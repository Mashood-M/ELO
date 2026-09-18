const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const api = require('../lib/api');

const THEME_COLOR = 0xFF6B00;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('connect')
    .setDescription('Connect your ElevatesOS account with Discord.')
    .addStringOption((opt) =>
      opt
        .setName('identifier')
        .setDescription('Your Elevates ID (e.g. ELV-0089), user UUID, or registered email address')
        .setRequired(false)
    ),

  async execute(interaction) {
    // 1. Check if user is already linked
    const identity = await api.getIdentityByDiscordId(interaction.user.id);
    if (identity && identity.profile) {
      const alreadyEmbed = new EmbedBuilder()
        .setColor(THEME_COLOR)
        .setTitle('🕹️ ALREADY CONNECTED')
        .setDescription(
          `Your Discord account is already connected to ElevatesOS as **${identity.name}**! 🎉\n\n` +
          `You already have full access across all Elevates chapter servers and clusters.`
        )
        .setFooter({ text: 'ElevatesOS x Discord' })
        .setTimestamp();

      return interaction.reply({
        embeds: [alreadyEmbed],
        ephemeral: true,
      });
    }

    const identifier = interaction.options.getString('identifier')?.trim();

    // 2. If user passed identifier directly in slash command option
    if (identifier) {
      await interaction.deferReply({ ephemeral: true });

      const result = await api.generateVerificationOtp(
        identifier,
        interaction.user.id,
        interaction.user.tag,
        interaction.guildId
      );

      if (!result || !result.ok) {
        return interaction.editReply({
          content: `⚠️ I couldn't find an ElevatesOS account matching "**${identifier}**". Please check your Elevates ID or email and try again.`,
        });
      }

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
        .setFooter({ text: 'ElevatesOS x Discord • Identity Verification' })
        .setTimestamp();

      return interaction.editReply({ embeds: [otpEmbed] });
    }

    // 3. Otherwise, show ephemeral connect prompt with button
    const connectEmbed = new EmbedBuilder()
      .setColor(THEME_COLOR)
      .setTitle('🕹️ CONNECT ELEVATES ACCOUNT')
      .setDescription(
        'Connect your ElevatesOS account with Discord to unlock your chapter roles and private cluster workspaces.\n\n' +
        'Click the button below to open the secure account linking form.'
      )
      .setFooter({ text: 'ElevatesOS x Discord' })
      .setTimestamp();

    const buttonRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('link_account_start')
        .setLabel('🔗 Connect Account')
        .setStyle(ButtonStyle.Primary)
    );

    await interaction.reply({
      embeds: [connectEmbed],
      components: [buttonRow],
      ephemeral: true,
    });
  },
};
