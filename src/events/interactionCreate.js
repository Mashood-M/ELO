const { Events } = require('discord.js');
const accountLinking = require('../lib/accountLinking');
const verifyFlow = require('../lib/verifyFlow');

module.exports = {
  name: Events.InteractionCreate,
  async execute(interaction) {
    // 1. Slash commands & Context Menu commands
    if (interaction.isChatInputCommand() || interaction.isContextMenuCommand()) {
      const command = interaction.client.commands.get(interaction.commandName);
      if (!command) return;

      try {
        await command.execute(interaction);
      } catch (err) {
        console.error(`Error running ${interaction.commandName}:`, err);
        const payload = { content: 'Something went wrong running that command.', ephemeral: true };
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

    // 2. Button interactions
    if (interaction.isButton()) {
      try {
        if (interaction.customId === 'link_account_start') {
          await accountLinking.handleLinkButton(interaction);
          return;
        }

        // Backward compatibility for existing buttons
        await verifyFlow.handleButton(interaction);
      } catch (err) {
        console.error('Error handling button interaction:', err);
      }
      return;
    }

    // 3. Modal submissions
    if (interaction.isModalSubmit()) {
      try {
        if (interaction.customId === 'link_account_modal') {
          await accountLinking.handleLinkModalSubmit(interaction);
          return;
        }

        // Backward compatibility for existing modals
        await verifyFlow.handleModalSubmit(interaction);
      } catch (err) {
        console.error('Error handling modal submission:', err);
      }
      return;
    }
  },
};
