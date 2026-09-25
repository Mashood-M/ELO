const connectCommand = require('./connect');
const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Connect your ElevatesOS account with Discord (alias for /connect).'),

  async execute(interaction) {
    return connectCommand.execute(interaction);
  },
};
