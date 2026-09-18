const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const api = require('../lib/api');
const supabase = require('../lib/supabase');
const config = require('../config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('chapter')
    .setDescription('Provision a new Discord server for your ElevatesOS Chapter (Campus Leads only).'),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    // 1. Verify caller is in the MAIN server
    let guildConfig;
    try {
      guildConfig = await api.getGuildConfig(interaction.guildId);
    } catch (_) {}

    if (guildConfig && guildConfig.guildType !== 'main') {
      return interaction.editReply({
        content: '⚠️ The `/chapter` command can only be used in the Elevates **Main Server**.',
      });
    }

    // 2. Verify caller is linked to ElevatesOS
    const identity = await api.getIdentityByDiscordId(interaction.user.id);
    if (!identity || !identity.profile) {
      return interaction.editReply({
        content: '⚠️ You must link your ElevatesOS account first before provisioning a chapter server. Please run `/connect` or check `#link-server`.',
      });
    }

    const profile = identity.profile;
    const userRoles = identity.userRoles || [];

    // 3. Verify caller's current OS role is campus_lead for some chapter
    // Check user_roles table for role_key = 'campus_lead'
    let campusLeadRecord = userRoles.find(
      (r) => (r.role_key || r.role) === 'campus_lead' && r.chapter_id
    );

    let chapterId = campusLeadRecord?.chapter_id || profile.chapter_id;

    // Check chapters table if campus_lead_id matches profile.id
    if (!campusLeadRecord && chapterId) {
      const { data: chapterRow } = await supabase
        .from('chapters')
        .select('id, name, campus_lead_id')
        .eq('id', chapterId)
        .maybeSingle();

      if (chapterRow && chapterRow.campus_lead_id === profile.id) {
        campusLeadRecord = { chapter_id: chapterRow.id };
      }
    }

    // Check profile.designation
    if (!campusLeadRecord && (profile.designation === 'campus_lead' || profile.role === 'campus_lead') && profile.chapter_id) {
      campusLeadRecord = { chapter_id: profile.chapter_id };
      chapterId = profile.chapter_id;
    }

    if (!campusLeadRecord || !chapterId) {
      return interaction.editReply({
        content: '⚠️ Only verified **Campus Leads** assigned to an active ElevatesOS Chapter can provision chapter servers.',
      });
    }

    // 4. Verify that this chapter has no guild_config entry yet
    const { data: existingGuild } = await supabase
      .from('guild_config')
      .select('guild_id')
      .eq('chapter_id', chapterId)
      .maybeSingle();

    if (existingGuild) {
      return interaction.editReply({
        content: `⚠️ Your chapter already has an active Discord server configured (Server ID: \`${existingGuild.guild_id}\`). A chapter can only have one active server at a time.`,
      });
    }

    // Fetch chapter name
    let chapterName = 'Your Chapter';
    const { data: chapterData } = await supabase
      .from('chapters')
      .select('name')
      .eq('id', chapterId)
      .maybeSingle();

    if (chapterData?.name) chapterName = chapterData.name;

    // 5. Generate one-time setup token (valid for 1 hour)
    const { token, expiresAt } = await api.createChapterSetupToken(
      chapterId,
      interaction.user.id,
      profile.id
    );

    const templateLink = config.serverTemplateUrl || 'https://discord.new/ElevatesChapterTemplate';
    const botInviteLink = `https://discord.com/oauth2/authorize?client_id=${config.clientId}&scope=bot%20applications.commands&permissions=8`;

    const embed = new EmbedBuilder()
      .setColor(0xFF6B00)
      .setTitle(`🏛️ Provision Server: ${chapterName}`)
      .setDescription(
        `Hello **${profile.full_name || 'Campus Lead'}**! You are authorized to provision the official Discord server for **${chapterName}**.\n\n` +
        `### 🚀 Next Steps (3 Simple Steps):\n` +
        `**1. Create Chapter Server:**\n` +
        `   Click here to clone the template: [Create Discord Server from Template](${templateLink})\n\n` +
        `**2. Invite this Bot:**\n` +
        `   Invite the bot to your newly created server: [Invite ElevatesOS Bot](${botInviteLink})\n\n` +
        `**3. Activate Your Chapter:**\n` +
        `   Once the bot is in your new server, run this slash command in that server:\n` +
        `   \`\`\`\n/activate-chapter token:${token}\n\`\`\`\n\n` +
        `⏱️ **Token Expiration:** 1 hour (<t:${Math.floor(new Date(expiresAt).getTime() / 1000)}:R>)\n\n` +
        `_Note: Keep this setup token private. It can only be used once._`
      )
      .addFields(
        { name: 'Chapter Name', value: chapterName, inline: true },
        { name: 'Chapter ID', value: `\`${chapterId}\``, inline: true }
      )
      .setFooter({ text: 'ElevatesOS Chapter Provisioning Engine' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
