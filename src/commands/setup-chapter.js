const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const api = require('../lib/api');
const { checkCommandPermission } = require('../lib/permissions');
const { syncChapterClusters } = require('../lib/clusterSync');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup-chapter')
    .setDescription('Manual setup: link this server to an ElevatesOS chapter (Founders / Admins).')
    .addStringOption((opt) =>
      opt.setName('chapter_id').setDescription('The chapter ID from ElevatesOS').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    if (!(await checkCommandPermission(interaction, 'setup-chapter'))) {
      // If OS role check fails, verify if member has Discord Administrator permission
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({
          content: '⚠️ You must be an Administrator or Founder to run `/setup-chapter`.',
          ephemeral: true,
        });
      }
    }

    const chapterId = interaction.options.getString('chapter_id').trim();

    await interaction.deferReply();

    let provisioningResult;
    try {
      provisioningResult = await api.provisionChapterGuild(
        interaction.client,
        interaction.guild,
        chapterId,
        interaction.member
      );
    } catch (err) {
      await interaction.editReply(`❌ Couldn't set up this server: ${err.message}`);
      return;
    }

    // Sync clusters for this chapter
    syncChapterClusters(interaction.client, chapterId).catch(() => {});

    const embed = new EmbedBuilder()
      .setTitle(`🎉 ${provisioningResult.chapterName || 'Chapter'} Server Provisioned`)
      .setDescription(
        'This server is now fully linked to ElevatesOS with all official chapter roles, cluster channels, and identity linking configured.'
      )
      .addFields(
        { name: 'Chapter ID', value: `\`${chapterId}\``, inline: true },
        { name: 'Type', value: 'Chapter Server', inline: true }
      )
      .setColor(0x22C55E)
      .setFooter({ text: 'ElevatesOS Chapter Provisioning Engine' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
