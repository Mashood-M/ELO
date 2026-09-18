const connectCommand = require('./connect');
const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Connect your ElevatesOS account with Discord (alias for /connect).')
    .addStringOption((opt) =>
      opt
        .setName('identifier')
        .setDescription('Your Elevates ID (e.g. ELV-0089), user UUID, or registered email address')
        .setRequired(false)
    ),

  async execute(interaction) {
    return connectCommand.execute(interaction);
  },
};
