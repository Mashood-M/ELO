const { Events, MessageFlags } = require('discord.js');
const accountLinking = require('../lib/accountLinking');
const verifyFlow = require('../lib/verifyFlow');
const ticketSystem = require('../lib/ticketSystem');

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
        const payload = { content: 'Something went wrong running that command.', flags: MessageFlags.Ephemeral };
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
        const customId = interaction.customId;

        // Account linking button
        if (customId === 'link_account_start') {
          await accountLinking.handleLinkButton(interaction);
          return;
        }

        // Chapter server activation button
        if (customId === 'activate_chapter_server') {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const chapterCmd = require('../commands/chapter');
          return chapterCmd.activateCurrentGuild(interaction);
        }

        // Ticket System: Lane Picker button (Founder, Admin, Executive Team, Campus Lead)
        if (customId.startsWith('ticket_lane_')) {
          const lane = customId.replace('ticket_lane_', '');
          await ticketSystem.handleLaneButtonClick(interaction, lane);
          return;
        }

        // Ticket System: Routing selection button (when user has multiple open tickets)
        if (customId.startsWith('ticket_route_')) {
          const ticketId = customId.replace('ticket_route_', '');
          await ticketSystem.handleRouteButtonClick(interaction, ticketId);
          return;
        }

        // Ticket System: Staff close button on forum starter post
        if (customId.startsWith('ticket_staff_close_')) {
          await ticketSystem.handleStaffClose(interaction.channel, interaction.user, interaction);
          return;
        }

        // Ticket System: User "Problem solved" button
        if (customId.startsWith('ticket_solve_')) {
          const ticketId = customId.replace('ticket_solve_', '');
          await ticketSystem.handleSolveButtonClick(interaction, ticketId);
          return;
        }

        // Ticket System: User "Not yet" button
        if (customId.startsWith('ticket_not_yet_')) {
          const ticketId = customId.replace('ticket_not_yet_', '');
          await ticketSystem.handleNotYetButtonClick(interaction, ticketId);
          return;
        }

        // Ticket System: User "Add Attachment" button
        if (customId.startsWith('ticket_attach_')) {
          const ticketId = customId.replace('ticket_attach_', '');
          await ticketSystem.handleAttachButtonClick(interaction, ticketId);
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
        const customId = interaction.customId;

        if (customId === 'link_account_modal') {
          await accountLinking.handleLinkModalSubmit(interaction);
          return;
        }

        // Ticket System: New ticket creation modal submit
        if (customId.startsWith('ticket_modal_')) {
          await ticketSystem.handleTicketModalSubmit(interaction);
          return;
        }

        // Ticket System: User "Add Attachment" modal submit
        if (customId.startsWith('ticket_attach_modal_')) {
          await ticketSystem.handleAttachModalSubmit(interaction);
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
