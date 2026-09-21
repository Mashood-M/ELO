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
          m.components?.some((row) =>
            row.components?.some((comp) => comp.customId === 'link_account_start')
          )
      );
    } catch (_) {}

    // If message already exists, we're all set
    if (existingMsg) return channel;

    // 3. Construct public embed and button
    const guildConfig = await api.getGuildConfig(guild.id).catch(() => null);
    const chapterName = guildConfig?.chapterName || guild.name;

    const embed = new EmbedBuilder()
      .setColor(THEME_COLOR)
      .setTitle('🎮 LINK YOUR ELEVATES OS ACCOUNT')
      .setDescription(
        `Welcome to **${chapterName}**! ⚡\n\n` +
        'Connect your ElevatesOS account with Discord to unlock your official chapter roles, private project clusters, live session rooms, and event access.\n\n' +
        '### 📌 How it works:\n' +
        '1. Click **🔗 Connect Account** below.\n' +
        '2. Enter your **Elevates OS User ID** (e.g. `ELV-0089`, UUID, or registered email) in the private popup.\n' +
        '3. Enter the 6-digit verification code on your **ElevatesOS Profile** page within 4 hours.\n\n' +
        '_Your details are private — only you see the verification form._'
      )
      .setFooter({ text: 'ElevatesOS x Discord • Identity Verification' })
      .setTimestamp();

    const buttonRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('link_account_start')
        .setLabel('🔗 Connect Account')
        .setStyle(ButtonStyle.Primary)
    );

    await channel.send({
      embeds: [embed],
      components: [buttonRow],
    });

    return channel;
  } catch (err) {
    console.error(`[ensureLinkChannel] Error in guild ${guild.id}:`, err.message);
    return null;
  }
}

/**
 * Handles the "🔗 Connect Account" button click (customId: "link_account_start").
 * Opens an ephemeral modal asking for Elevates OS User ID.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 */
async function handleLinkButton(interaction) {
  // Check if caller is already linked
  const identity = await api.getIdentityByDiscordId(interaction.user.id);
  if (identity && identity.profile) {
    const alreadyEmbed = new EmbedBuilder()
      .setColor(THEME_COLOR)
      .setTitle('🕹️ ALREADY CONNECTED')
      .setDescription(
        `Your Discord account is already connected to ElevatesOS as **${identity.name}** (${identity.elevatesId || identity.userId})! 🎉\n\n` +
        `Your identity is verified across all Elevates chapter servers and clusters.`
      )
      .setFooter({ text: 'ElevatesOS x Discord' })
      .setTimestamp();

    return interaction.reply({
      embeds: [alreadyEmbed],
      ephemeral: true,
    });
  }

  // Open private Modal
  const modal = new ModalBuilder()
    .setCustomId('link_account_modal')
    .setTitle('Link ElevatesOS Account');

  const osUserIdInput = new TextInputBuilder()
    .setCustomId('os_user_id')
    .setLabel('Elevates OS User ID')
    .setPlaceholder('e.g. ELV-0089, user UUID, or email')
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const row = new ActionRowBuilder().addComponents(osUserIdInput);
  modal.addComponents(row);

  await interaction.showModal(modal);
}

/**
 * Handles the submission of link_account_modal.
 * Looks up profile, generates 6-digit OTP with 4-hour expiry, replies ephemerally.
 *
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 */
async function handleLinkModalSubmit(interaction) {
  // Immediately defer reply ephemerally to beat Discord's 3s modal timeout
  await interaction.deferReply({ ephemeral: true });

  const inputId = interaction.fields.getTextInputValue('os_user_id').trim();

  try {
    const result = await api.generateVerificationOtp(
      inputId,
      interaction.user.id,
      interaction.user.tag,
      interaction.guildId
    );

    if (!result || !result.ok) {
      const failEmbed = new EmbedBuilder()
        .setColor(0xEF4444)
        .setTitle('⚠️ ACCOUNT NOT FOUND')
        .setDescription(
          `I couldn't find an ElevatesOS account matching "**${inputId}**".\n\n` +
          'Please verify your **Elevates ID** (e.g. `ELV-0089`) or registered email address on the ElevatesOS website and try again.'
        )
        .setFooter({ text: 'ElevatesOS x Discord' })
        .setTimestamp();

      const retryRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('link_account_start')
          .setLabel('🔁 Try Again')
          .setStyle(ButtonStyle.Primary)
      );

      return interaction.editReply({ embeds: [failEmbed], components: [retryRow] });
    }

    // Success: OTP generated with 4-hour expiry
    const otpEmbed = new EmbedBuilder()
      .setColor(THEME_COLOR)
      .setTitle('🔐 CODE SENT — ENTER ON ELEVATES OS')
      .setDescription(
        `Code sent — enter it on your ElevatesOS profile page within 4 hours.\n\n` +
        `Hello **${result.userName}**! Enter your 6-digit verification code:\n\n` +
        `# \`  ${result.otpCode}  \`\n\n` +
        `⏱️ **Expires:** in 4 hours (<t:${Math.floor(new Date(result.expiresAt).getTime() / 1000)}:R>)\n\n` +
        `### 📋 Steps:\n` +
        `1. Open your **Elevates OS Profile** page.\n` +
        `2. Find the **Discord Verification** box.\n` +
        `3. Enter **\`${result.otpCode}\`** and submit.\n\n` +
        `_Once verified on the website, your roles will be synced automatically in all chapter servers!_`
      )
      .setFooter({ text: 'ElevatesOS x Discord • 4-Hour Code Expiry' })
      .setTimestamp();

    await interaction.editReply({ embeds: [otpEmbed] });

    // Log account link attempt to Founders forum
    try {
      const guildConfig = interaction.guildId ? await api.getGuildConfig(interaction.guildId).catch(() => null) : null;
      api.logChapterEvent(interaction.client, guildConfig?.chapterId, interaction.guildId, 'link_otp_generated', {
        discordUserId: interaction.user.id,
        discordUserTag: interaction.user.tag,
        elevatesUser: result.userName,
        osUserId: result.osUserId || inputId,
      }, 'membership').catch(() => {});
    } catch (_) {}
  } catch (err) {
    console.error('[handleLinkModalSubmit] Error:', err);
    await interaction.editReply({
      content: `⚠️ Failed to generate verification code: ${err.message}`,
    });
  }
}

module.exports = {
  ensureLinkChannel,
  handleLinkButton,
  handleLinkModalSubmit,
};
