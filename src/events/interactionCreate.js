const { Events } = require('discord.js');
const verifyFlow = require('../lib/verifyFlow');

module.exports = {
  name: Events.InteractionCreate,
  async execute(interaction) {
    if (interaction.isChatInputCommand()) {
      const command = interaction.client.commands.get(interaction.commandName);
      if (!command) return;

      try {
        await command.execute(interaction);
      } catch (err) {
        console.error(`Error running /${interaction.commandName}:`, err);
        const payload = { content: 'Something went wrong running that command.', flags: [1 << 6] };
        if (interaction.deferred && !interaction.replied) {
          await interaction.editReply(payload).catch(() => {});
        } else if (interaction.replied) {
          await interaction.followUp(payload).catch(() => {});
        } else {
          await interaction.reply(payload).catch(() => {});
        }
      }
      return;
    }

    // Handle button clicks for verification flow
    if (interaction.isButton()) {
      try {
        await verifyFlow.handleButton(interaction);
      } catch (err) {
        console.error('Error handling button interaction:', err);
      }
      return;
    }

    // Handle modal submissions for verification flow
    if (interaction.isModalSubmit()) {
      try {
        await verifyFlow.handleModalSubmit(interaction);
      } catch (err) {
        console.error('Error handling modal submission:', err);
      }
      return;
    }
  },
};
