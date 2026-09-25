const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');
const api = require('./api');

const THEME_COLOR = 0xFF6B00; // Warm arcade orange

/**
 * Ensures the #link-server (or #welcome) channel exists in a guild
 * and contains the active "🔗 Connect Account" public embed & button.
 *
 * @param {import('discord.js').Guild} guild
 */
async function ensureLinkChannel(guild) {
  if (!guild) return null;

  try {
    const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
    if (!me || !me.permissions.has(PermissionFlagsBits.SendMessages)) return null;

    // 1. Locate #link-server or #welcome
    let channel = guild.channels.cache.find(
      (c) =>
        c.type === ChannelType.GuildText &&
        (c.name === 'link-server' || c.name === 'welcome' || c.name.includes('verify'))
    );

    // If neither exists, attempt to create #link-server
    if (!channel && me.permissions.has(PermissionFlagsBits.ManageChannels)) {
      channel = await guild.channels.create({
        name: 'link-server',
        type: ChannelType.GuildText,
        topic: 'Official ElevatesOS Account Linking Portal',
        reason: 'Account linking channel for ElevatesOS',
      });
    }

    if (!channel) return null;

    // 2. Check if the channel already has our active link prompt message
    let existingMsg = null;
    try {
      const messages = await channel.messages.fetch({ limit: 15 });
      existingMsg = messages.find(
        (m) =>
          m.author.id === guild.client.user.id &&
          m.embeds?.some((e) => e.title?.includes('LINK YOUR ELEVATES OS ACCOUNT'))
      );

      // If an old message exists that still has interactive buttons, remove it to prevent confusion
      if (existingMsg && existingMsg.components?.length > 0) {
        await existingMsg.delete().catch(() => {});
        existingMsg = null;
      }
    } catch (_) {}

    // If message already exists without buttons, we're all set
    if (existingMsg) return channel;

    // 3. Construct public embed explaining code-paste verification
    const guildConfig = await api.getGuildConfig(guild.id).catch(() => null);
    const chapterName = guildConfig?.chapterName || guild.name;

    const embed = new EmbedBuilder()
      .setColor(THEME_COLOR)
      .setTitle('🎮 LINK YOUR ELEVATES OS ACCOUNT')
      .setDescription(
        `Welcome to **${chapterName}**! ⚡\n\n` +
        'Connect your ElevatesOS account with Discord to unlock your official chapter roles, private project clusters, live session rooms, and event access.\n\n' +
        '### 📌 How to link your account:\n' +
        '1. Log in to your **ElevatesOS Profile** on the web.\n' +
        '2. Generate a **6-character verification code** under your Discord settings.\n' +
        '3. **Paste the 6-character code directly in this channel.**\n\n' +
        '🔒 _Your message is deleted immediately the moment you post it to protect your code. Once verified, your roles unlock instantly!_'
      )
      .setFooter({ text: 'ElevatesOS x Discord • Code Verification Portal' })
      .setTimestamp();

    await channel.send({
      embeds: [embed],
    });

    return channel;
  } catch (err) {
    console.error(`[ensureLinkChannel] Error in guild ${guild.id}:`, err.message);
    return null;
  }
}

/**
 * Legacy button click handler (customId: "link_account_start").
 * Informs the user about the direct code-paste flow.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleLinkButton(interaction) {
  return interaction.reply({
    content: '⚠️ Account linking now uses direct code verification! Please generate your 6-character code on your ElevatesOS profile and post it directly into `#link-server`. Your message will be deleted immediately and your account linked.',
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * Legacy modal submission handler (customId: "link_account_modal").
 *
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 */
async function handleLinkModalSubmit(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  return interaction.editReply({
    content: '⚠️ Account linking now uses direct code verification! Please generate your 6-character code on your ElevatesOS profile and post it directly into `#link-server`. Your message will be deleted immediately and your account linked.',
  });
}

module.exports = {
  ensureLinkChannel,
  handleLinkButton,
  handleLinkModalSubmit,
};
