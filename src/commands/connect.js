const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const api = require('../lib/api');
const verifySessions = require('../lib/verifySessions');
const verifyFlow = require('../lib/verifyFlow');

const THEME_COLOR = 0xFF6B00;
const PLACEHOLDER_THUMBNAIL = 'https://cdn.elevates.org/assets/arcade-avatar-placeholder.png';

module.exports = {
  data: new SlashCommandBuilder()
    .setName('connect')
    .setDescription('Connect your ElevatesOS account with Discord (or claim a Guest pass).')
    .addStringOption((opt) =>
      opt
        .setName('identifier')
        .setDescription('Your Elevates ID (e.g. ELV-0061) or registered email address')
        .setRequired(false)
    ),

  async execute(interaction) {
    let guildConfig;
    try {
      guildConfig = await api.getGuildConfig(interaction.guild.id);
    } catch (err) {
      // ignore
    }

    const chapterName = guildConfig?.chapterName || 'Chapter';

    const config = require('../config');
    const existingLink = await api.getUserLink(interaction.user.id, interaction.guild.id);
    const hasVerifiedRole = interaction.member?.roles?.cache?.some(
      (r) => r.name.toLowerCase() === config.roles.verified?.toLowerCase()
    );

    // If account is linked in database but roles were not yet synced, sync them now
    if (existingLink && !hasVerifiedRole && interaction.guild && interaction.member) {
      await api.syncMemberRoles(interaction.guild, interaction.member, existingLink);
      const { postVerificationWelcomeCard } = require('../lib/generateWelcomeCard');
      await postVerificationWelcomeCard(interaction.guild, interaction.member, existingLink.name);
    }

    if (existingLink || hasVerifiedRole) {
      const name = existingLink?.name || interaction.member?.displayName || 'Member';
      const alreadyEmbed = new EmbedBuilder()
        .setColor(THEME_COLOR)
        .setTitle('🕹️ ALREADY CONNECTED')
        .setDescription(
          `Your Discord account is already connected to ElevatesOS as **${name}**! 🎉\n\n` +
          `You already have full access to chapter clusters, tasks, and discussions.`
        )
        .setThumbnail(PLACEHOLDER_THUMBNAIL)
        .setFooter({ text: 'ElevatesOS x Discord' })
        .setTimestamp();

      return interaction.reply({
        embeds: [alreadyEmbed],
        flags: [1 << 6], // Ephemeral
      });
    }

    const identifier = interaction.options.getString('identifier')?.trim();
    if (identifier) {
      await interaction.deferReply({ flags: [1 << 6] });
      return verifyFlow.processVerificationSubmission(interaction, identifier, interaction.guild.id);
    }

    // Start verification session
    verifySessions.start(interaction.user.id, interaction.guild.id);

    const connectEmbed = new EmbedBuilder()
      .setColor(THEME_COLOR)
      .setTitle('🕹️ CONNECT ELEVATES ACCOUNT')
      .setDescription(
        `Welcome to the **${chapterName}** chapter! 🎮\n\n` +
        `Link your **ElevatesOS** account to unlock chapter clusters, tasks, and official roles.\n\n` +
        `**Do you already have an ElevatesOS account?**`
      )
      .setThumbnail(PLACEHOLDER_THUMBNAIL)
      .setFooter({ text: 'ElevatesOS x Discord' })
      .setTimestamp();

    const buttonRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('os_link_yes')
        .setLabel('✅ Connect ElevatesOS')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('os_link_no')
        .setLabel("🆕 No, I'm new here")
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({
      embeds: [connectEmbed],
      components: [buttonRow],
      flags: [1 << 6], // MessageFlags.Ephemeral
    });
  },
};
