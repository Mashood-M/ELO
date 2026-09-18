const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const api = require('../lib/api');
const { syncChapterClusters } = require('../lib/clusterSync');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('activate-chapter')
    .setDescription('Activate this Discord server for your ElevatesOS Chapter using your setup token.')
    .addStringOption((opt) =>
      opt
        .setName('token')
        .setDescription('The 1-hour setup token issued by /chapter')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    await interaction.deferReply();

    const tokenInput = interaction.options.getString('token').trim();

    // 1. Verify that this guild is not already configured as a main server or chapter
    let existingConfig = null;
    try {
      existingConfig = await api.getGuildConfig(interaction.guildId);
    } catch (_) {}

    if (existingConfig && existingConfig.guildType === 'main') {
      return interaction.editReply({
        content: '⚠️ This server is configured as the Elevates **Main Server** and cannot be converted into a chapter server.',
      });
    }

    if (existingConfig && existingConfig.chapterId) {
      return interaction.editReply({
        content: `⚠️ This server is already activated and linked to Chapter ID \`${existingConfig.chapterId}\`.`,
      });
    }

    // 2. Validate setup token
    const tokenResult = await api.validateAndConsumeSetupToken(tokenInput, interaction.user.id);
    if (!tokenResult || !tokenResult.ok) {
      return interaction.editReply({
        content: `❌ Activation failed: ${tokenResult?.message || 'Invalid or expired setup token.'}`,
      });
    }

    const { tokenData } = tokenResult;
    const chapterId = tokenData.chapter_id;

    // 3. Provision chapter guild
    let provisioningResult;
    try {
      provisioningResult = await api.provisionChapterGuild(
        interaction.client,
        interaction.guild,
        chapterId,
        interaction.member
      );
    } catch (err) {
      console.error('[activate-chapter] Error during provisioning:', err);
      return interaction.editReply({
        content: `❌ An error occurred during chapter provisioning: ${err.message}`,
      });
    }

    // 4. Trigger initial cluster synchronization for this chapter
    syncChapterClusters(interaction.client, chapterId).catch((err) =>
      console.error('[activate-chapter] Cluster sync error:', err.message)
    );

    // 5. Send success reply
    const successEmbed = new EmbedBuilder()
      .setColor(0x22C55E)
      .setTitle(`🎉 ${provisioningResult.chapterName} Discord Server Activated!`)
      .setDescription(
        `This server is now officially linked to the **${provisioningResult.chapterName}** chapter on ElevatesOS!\n\n` +
        `### ✅ Configuration Summary:\n` +
        `• **Elevates Chapter ID:** \`${chapterId}\`\n` +
        `• **Server Type:** Chapter Guild\n` +
        `• **Campus Lead Role:** Generated with **Administrator** access in this server.\n` +
        `• **Chapter Roles:** Automatically generated from ElevatesOS roles schema.\n` +
        `• **Audit Logging:** Linked to private Founders log channel in the Main Server.\n` +
        `• **Account Linking:** Portal ready in \`#link-server\` (zero DMs).\n\n` +
        `Members can now connect their accounts and access their chapter clusters!`
      )
      .setFooter({ text: 'ElevatesOS Chapter Provisioning Engine' })
      .setTimestamp();

    await interaction.editReply({ embeds: [successEmbed] });

    // Log activation event
    api.logChapterEvent(interaction.client, chapterId, interaction.guildId, 'chapter_activated', {
      activatedBy: interaction.user.tag,
      guildName: interaction.guild.name,
      guildId: interaction.guildId,
    }).catch(() => {});
  },
};
