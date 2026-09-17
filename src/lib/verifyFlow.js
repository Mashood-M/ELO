const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const config = require('../config');
const api = require('./api');
const verifySessions = require('./verifySessions');

const THEME_COLOR = 0xFF6B00; // Warm arcade orange

/**
 * Safely disables buttons on private messages (e.g. DMs) to prevent repeated clicks.
 * Does NOT disable buttons in guild channels so persistent welcome/verify messages remain usable.
 */
async function disableMessageButtons(message) {
  if (!message || message.guildId || !message.components || !message.components.length) return;
  try {
    const disabledRows = message.components.map((row) => {
      const newRow = new ActionRowBuilder();
      const updatedButtons = row.components.map((component) =>
        ButtonBuilder.from(component).setDisabled(true)
      );
      return newRow.addComponents(updatedButtons);
    });
    await message.edit({ components: disabledRows });
  } catch (err) {
    // Ignore errors
  }
}

/**
 * Handles button interactions for the verification flow.
 */
async function handleButton(interaction) {
  const guildId = interaction.guildId || verifySessions.get(interaction.user.id)?.guildId;
  const existingLink = guildId ? await api.getUserLink(interaction.user.id, guildId) : null;
  const hasVerifiedRole = interaction.member?.roles?.cache?.some(
    (r) => r.name.toLowerCase() === config.roles.verified?.toLowerCase()
  );

  if (existingLink || hasVerifiedRole) {
    const name = existingLink?.name || interaction.member?.displayName || 'Member';
    const alreadyEmbed = new EmbedBuilder()
      .setColor(THEME_COLOR)
      .setTitle('🕹️ ALREADY CONNECTED')
      .setDescription(
        `Your Discord account is already connected to ElevatesOS as **${name}**! 🎉\n\n` +
        `You already have full access to chapter clusters, tasks, and discussions.`
      )
      .setFooter({ text: 'ElevatesOS x Discord' })
      .setTimestamp();

    return interaction.reply({
      embeds: [alreadyEmbed],
      flags: [1 << 6], // Ephemeral
    });
  }

  if (interaction.customId === 'os_link_yes') {
    const modal = new ModalBuilder()
      .setCustomId('os_link_modal')
      .setTitle('Link Your ElevatesOS Account');

    const osUserIdInput = new TextInputBuilder()
      .setCustomId('os_user_id_input')
      .setLabel('Elevates ID or Registered Email')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g. ELV-0061 or you@example.com')
      .setRequired(true);

    const firstActionRow = new ActionRowBuilder().addComponents(osUserIdInput);
    modal.addComponents(firstActionRow);

    // Show modal immediately (must be first response)
    await interaction.showModal(modal);
  } else if (interaction.customId === 'check_os_verification') {
    await interaction.deferReply({ flags: [1 << 6] });

    const session = verifySessions.get(interaction.user.id);
    const guildId = interaction.guildId || session?.guildId;

    if (!guildId) {
      return interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setColor(THEME_COLOR)
            .setTitle('⚠️ CHAPTER NOT FOUND')
            .setDescription("Couldn't locate your chapter server.")
            .setFooter({ text: 'ElevatesOS x Discord' }),
        ],
      });
    }

    let guild = interaction.guild;
    if (!guild && guildId) {
      guild = interaction.client.guilds.cache.get(guildId) ||
        (await interaction.client.guilds.fetch(guildId).catch(() => null));
    }

    let member = interaction.member;
    if (!member && guild) {
      member = await guild.members.fetch(interaction.user.id).catch(() => null);
    }

    const link = await api.getUserLink(interaction.user.id, guildId);

    if (link && link.status === 'linked') {
      if (guild && member) {
        await api.syncMemberRoles(guild, member, {
          name: link.name,
          designation: link.designation || link.role,
        });
        const { postVerificationWelcomeCard } = require('./generateWelcomeCard');
        await postVerificationWelcomeCard(guild, member, link.name);
      }

      verifySessions.clear(interaction.user.id);

      const verifiedEmbed = new EmbedBuilder()
        .setColor(THEME_COLOR)
        .setTitle('🎮 ACCESS GRANTED — VERIFIED!')
        .setDescription(
          `🎉 Welcome aboard, **${link.name || 'Member'}**!\n\n` +
          `Your Discord account is officially verified and linked to ElevatesOS.\n\n` +
          `All chapter channels, project clusters, and official roles are unlocked!`
        )
        .setFooter({ text: 'ElevatesOS x Discord' })
        .setTimestamp();

      return interaction.editReply({ embeds: [verifiedEmbed] });
    }

    // Still pending
    const pendingEmbed = new EmbedBuilder()
      .setColor(THEME_COLOR)
      .setTitle('⏳ AWAITING WEB VERIFICATION')
      .setDescription(
        `We haven't detected your verification on Elevates OS yet.\n\n` +
        `👉 **Step-by-step**:\n` +
        `1. Open your **Elevates OS Profile**.\n` +
        `2. In the **Discord Verification** section, enter your 6-digit OTP code.\n` +
        `3. Click **Verify Code** on the website.\n\n` +
        `Once confirmed on Elevates OS, click **Check Verification Status** again!`
      )
      .setFooter({ text: 'ElevatesOS x Discord' })
      .setTimestamp();

    const checkRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('check_os_verification')
        .setLabel('🔄 Check Verification Status')
        .setStyle(ButtonStyle.Success)
    );

    return interaction.editReply({ embeds: [pendingEmbed], components: [checkRow] });
  } else if (interaction.customId === 'os_link_no') {
    await interaction.deferReply({ flags: [1 << 6] });

    // Only disable DM messages
    if (interaction.message && !interaction.inGuild()) {
      await disableMessageButtons(interaction.message);
    }

    const session = verifySessions.get(interaction.user.id);
    const guildId = interaction.guildId || session?.guildId;

    let guild = interaction.guild;
    if (!guild && guildId) {
      guild = interaction.client.guilds.cache.get(guildId) ||
        (await interaction.client.guilds.fetch(guildId).catch(() => null));
    }

    let member = interaction.member;
    if (!member && guild) {
      member = await guild.members.fetch(interaction.user.id).catch(() => null);
    }

    if (member && guild) {
      const unverifiedRole = guild.roles.cache.find(
        (r) => !r.managed && r.name.toLowerCase() === config.roles.unverified?.toLowerCase()
      );
      const guestRole = guild.roles.cache.find(
        (r) => !r.managed && r.name.toLowerCase() === config.roles.guest?.toLowerCase()
      );

      if (unverifiedRole) await member.roles.remove(unverifiedRole).catch(() => {});
      if (guestRole) await member.roles.add(guestRole).catch(() => {});
    }

    const guestEmbed = new EmbedBuilder()
      .setColor(THEME_COLOR)
      .setTitle('🕹️ GUEST PASS ISSUED')
      .setDescription(
        `You've been assigned the **Guest** role!\n\n` +
        `You're welcome to browse our general and welcome channels. Chapter-specific clusters, tasks, and discussions remain exclusive to verified ElevatesOS members.\n\n` +
        `_Changed your mind? An admin can re-trigger verification for you anytime._`
      )
      .setFooter({ text: 'ElevatesOS x Discord' })
      .setTimestamp();

    await interaction.editReply({ embeds: [guestEmbed] });

    if (guildId) {
      api.logEvent(guildId, interaction.user.id, 'declined_os_account', {
        username: interaction.user.tag,
      }).catch(() => {});
    }

    if (guild) {
      const modLog = guild.channels.cache.find((c) => c.name === 'mod-log');
      if (modLog) {
        modLog.send(`ℹ️ **${interaction.user.tag}** joined as **Guest** (no ElevatesOS account).`);
      }
    }

    verifySessions.clear(interaction.user.id);
  }
}

/**
 * Processes verification submission: generates OTP and replies ephemerally.
 */
async function processVerificationSubmission(interaction, osUserId, guildId) {
  let guild = interaction.guild;
  if (!guild && guildId) {
    guild = interaction.client.guilds.cache.get(guildId) ||
      (await interaction.client.guilds.fetch(guildId).catch(() => null));
  }

  let chapterName = 'Chapter';
  try {
    const guildConfig = await api.getGuildConfig(guildId);
    if (guildConfig?.chapterName) chapterName = guildConfig.chapterName;
  } catch (_) {}

  let result;
  try {
    result = await api.generateVerificationOtp(
      osUserId,
      interaction.user.id,
      interaction.user.tag,
      guildId
    );
  } catch (err) {
    console.error('Error in generateVerificationOtp:', err);
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(THEME_COLOR)
          .setTitle('⚠️ SYSTEM ERROR')
          .setDescription('Something went wrong reaching ElevatesOS. Please try again in a moment.')
          .setFooter({ text: 'ElevatesOS x Discord' }),
      ],
    });
    return;
  }

  if (!result || !result.ok) {
    const updatedSession = verifySessions.incrementAttempt(interaction.user.id, guildId);
    const attemptsLeft = config.maxVerifyAttempts - updatedSession.attempts;

    if (attemptsLeft <= 0) {
      const maxEmbed = new EmbedBuilder()
        .setColor(THEME_COLOR)
        .setTitle('⚠️ VERIFICATION LIMIT REACHED')
        .setDescription(
          "That doesn't match any ElevatesOS account after several tries.\n\n" +
          "I've flagged this for your **Campus Lead** to assist you manually."
        )
        .setFooter({ text: 'ElevatesOS x Discord' })
        .setTimestamp();

      await interaction.editReply({ embeds: [maxEmbed] });

      if (guild) {
        const modLog = guild.channels.cache.find((c) => c.name === 'mod-log');
        if (modLog) {
          modLog.send(`⚠️ **${interaction.user.tag}** failed verification ${config.maxVerifyAttempts} times. Needs manual linking.`);
        }
      }

      api.logEvent(guildId, interaction.user.id, 'verify_failed_max', {}).catch(() => {});
      return;
    }

    const retryRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('os_link_yes')
        .setLabel('🔁 Try Again')
        .setStyle(ButtonStyle.Primary)
    );

    let errorTitle = '⚠️ INVALID USER ID';
    let errorDescription = `I couldn't find an ElevatesOS account matching "**${osUserId}**".\n\n` +
      `💡 **Tip**: You can enter your **Elevates ID** (e.g. \`ELV-0061\` or digits \`0061\`) or your **registered email address**.\n\n` +
      `**${attemptsLeft}** attempt(s) remaining.`;

    if (result && result.reason === 'chapter_mismatch') {
      errorTitle = '⚠️ CHAPTER MISMATCH';
      errorDescription = `Found your account (**${result.userName}**), but it is registered under **${result.userChapterName}**.\n\n` +
        `This server is exclusively for **${chapterName}** chapter members.\n\n` +
        `**${attemptsLeft}** attempt(s) remaining.`;
    }

    const failEmbed = new EmbedBuilder()
      .setColor(THEME_COLOR)
      .setTitle(errorTitle)
      .setDescription(errorDescription)
      .setFooter({ text: 'ElevatesOS x Discord' })
      .setTimestamp();

    await interaction.editReply({ embeds: [failEmbed], components: [retryRow] });
    return;
  }

  // OTP generated successfully: reply ephemerally with 6-digit code and instructions
  verifySessions.clear(interaction.user.id);

  const otpEmbed = new EmbedBuilder()
    .setColor(THEME_COLOR)
    .setTitle('🔐 ELEVATES OS VERIFICATION CODE')
    .setDescription(
      `Hello **${result.userName}**! 👋\n\n` +
      `To link your Discord account with ElevatesOS, enter this 6-digit code on your **Elevates OS Profile**:\n\n` +
      `# \`  ${result.otpCode}  \`\n\n` +
      `⏱️ **This code is valid for 15 minutes.**\n\n` +
      `### 📋 How to complete verification:\n` +
      `1. Go to your **Elevates OS** website and open your **Profile** page.\n` +
      `2. Scroll to the **Discord Verification** terminal.\n` +
      `3. Enter the 6-digit code **\`${result.otpCode}\`** and click **Verify Code**.\n\n` +
      `*(After verifying on the website, click the button below to confirm!)*`
    )
    .setFooter({ text: 'ElevatesOS x Discord • Security Verification' })
    .setTimestamp();

  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('check_os_verification')
      .setLabel('🔄 Check Verification Status')
      .setStyle(ButtonStyle.Success)
  );

  await interaction.editReply({ embeds: [otpEmbed], components: [actionRow] });
}

/**
 * Handles modal submit interactions for linking the ElevatesOS account.
 */
async function handleModalSubmit(interaction) {
  if (interaction.customId !== 'os_link_modal') return;

  // Immediately defer to beat the 3-second limit
  await interaction.deferReply({ flags: [1 << 6] });

  const osUserId = interaction.fields.getTextInputValue('os_user_id_input').trim();
  const session = verifySessions.get(interaction.user.id);
  const guildId = interaction.guildId || session?.guildId;

  if (!guildId) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(THEME_COLOR)
          .setTitle('⚠️ CHAPTER NOT FOUND')
          .setDescription("Couldn't locate your chapter server. Please contact an admin or re-join.")
          .setFooter({ text: 'ElevatesOS x Discord' }),
      ],
    });
    return;
  }

  await processVerificationSubmission(interaction, osUserId, guildId);
}

module.exports = { handleButton, handleModalSubmit, processVerificationSubmission };
