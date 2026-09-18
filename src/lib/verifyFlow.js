const { EmbedBuilder } = require('discord.js');
const accountLinking = require('./accountLinking');
const api = require('./api');

const THEME_COLOR = 0xFF6B00;

/**
 * Backward compatibility handler for legacy buttons.
 */
async function handleButton(interaction) {
  if (interaction.customId === 'os_link_yes' || interaction.customId === 'link_account_start') {
    return accountLinking.handleLinkButton(interaction);
  }

  if (interaction.customId === 'check_os_verification') {
    await interaction.deferReply({ ephemeral: true });

    const identity = await api.getIdentityByDiscordId(interaction.user.id);
    if (identity && identity.profile) {
      if (interaction.guild) {
        await api.syncUserAcrossGuilds(interaction.client, interaction.user.id, identity.userId);
      }

      const verifiedEmbed = new EmbedBuilder()
        .setColor(THEME_COLOR)
        .setTitle('🎮 ACCESS GRANTED — VERIFIED!')
        .setDescription(
          `🎉 Welcome aboard, **${identity.name}**!\n\n` +
          `Your Discord account is officially verified and linked to ElevatesOS.\n\n` +
          `All chapter channels, project clusters, and official roles are unlocked!`
        )
        .setFooter({ text: 'ElevatesOS x Discord' })
        .setTimestamp();

      return interaction.editReply({ embeds: [verifiedEmbed] });
    }

    const pendingEmbed = new EmbedBuilder()
      .setColor(THEME_COLOR)
      .setTitle('⏳ AWAITING WEB VERIFICATION')
      .setDescription(
        `We haven't detected your verification on ElevatesOS yet.\n\n` +
        `👉 **Steps**:\n` +
        `1. Open your **Elevates OS Profile** page.\n` +
        `2. In the **Discord Verification** section, enter your 6-digit OTP code.\n` +
        `3. Submit the code on the website.\n\n` +
        `Once confirmed on ElevatesOS, your access is unlocked immediately across all servers!`
      )
      .setFooter({ text: 'ElevatesOS x Discord' })
      .setTimestamp();

    return interaction.editReply({ embeds: [pendingEmbed] });
  }

  if (interaction.customId === 'os_link_no') {
    return interaction.reply({
      content: 'If you ever wish to connect your ElevatesOS account in the future, head over to `#link-server` anytime!',
      ephemeral: true,
    });
  }
}

/**
 * Backward compatibility handler for legacy modal submissions.
 */
async function handleModalSubmit(interaction) {
  if (interaction.customId === 'link_account_modal' || interaction.customId === 'os_link_modal') {
    return accountLinking.handleLinkModalSubmit(interaction);
  }
}

module.exports = {
  handleButton,
  handleModalSubmit,
  processVerificationSubmission: accountLinking.handleLinkModalSubmit,
};
