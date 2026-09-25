const {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');
const api = require('../lib/api');

const THEME_COLOR = 0xFF6B00;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('connect')
    .setDescription('Connect your ElevatesOS account with Discord.'),

  async execute(interaction) {
    // 1. Immediately defer reply ephemerally (Performance: 3s interaction window)
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // 2. Check if user is already linked
    const identity = await api.getIdentityByDiscordId(interaction.user.id);
    if (identity && identity.profile) {
      const alreadyEmbed = new EmbedBuilder()
        .setColor(THEME_COLOR)
        .setTitle('🕹️ ALREADY CONNECTED')
        .setDescription(
          `Your Discord account is already connected to ElevatesOS as **${identity.name}**! 🎉\n\n` +
          'You already have full access across all Elevates chapter servers and clusters.'
        )
        .setFooter({ text: 'ElevatesOS x Discord' })
        .setTimestamp();

      return interaction.editReply({ embeds: [alreadyEmbed] });
    }

    // 3. Instruct user on the 6-character code-paste verification flow
    const connectEmbed = new EmbedBuilder()
      .setColor(THEME_COLOR)
      .setTitle('🕹️ CONNECT ELEVATES OS ACCOUNT')
      .setDescription(
        'ElevatesOS accounts are verified using secure 6-character link codes!\n\n' +
        '### 📌 How to link your account:\n' +
        '1. Log in to your **ElevatesOS Profile** on the web.\n' +
        '2. Generate a 6-character verification code under **Discord Settings**.\n' +
        '3. Go to the **#link-server** channel in this server.\n' +
        '4. **Paste your 6-character code** directly into the channel.\n\n' +
        '🔒 _Your message is deleted immediately upon posting, and your official roles will be granted automatically!_'
      )
      .setFooter({ text: 'ElevatesOS x Discord • Code Verification' })
      .setTimestamp();

    return interaction.editReply({ embeds: [connectEmbed] });
  },
};
