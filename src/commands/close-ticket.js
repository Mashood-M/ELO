const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const ticketSystem = require('../lib/ticketSystem');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('close-ticket')
    .setDescription('Close and archive the active ticket in this thread')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageThreads),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const channel = interaction.channel;

    if (!channel || !channel.isThread()) {
      return interaction.editReply({
        content: '⚠️ This command can only be used inside an active ticket thread.',
      });
    }

    const ticket = await ticketSystem.getTicketByThreadId(channel.id);
    if (!ticket) {
      return interaction.editReply({
        content: '⚠️ This thread is not recognized as an active ticket.',
      });
    }

    // Verify authorized staff
    const isAuthorized = await ticketSystem.isUserAuthorizedForLane(
      interaction.member,
      ticket.lane,
      ticket.chapter_id,
      interaction.client
    );

    if (!isAuthorized) {
      return interaction.editReply({
        content: `⚠️ Only authorized ${ticketSystem.getLaneDisplayName(ticket.lane)} staff can close this ticket.`,
      });
    }

    await ticketSystem.handleStaffClose(channel, interaction.user, interaction);
  },
};
