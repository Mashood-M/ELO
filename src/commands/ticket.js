const {
  SlashCommandBuilder,
  InteractionContextType,
  ApplicationIntegrationType,
} = require('discord.js');
const ticketSystem = require('../lib/ticketSystem');

const commandData = new SlashCommandBuilder()
  .setName('ticket')
  .setDescription('Open a new support ticket or select a ticket lane')
  .addAttachmentOption((opt) =>
    opt
      .setName('attachment')
      .setDescription('Attach a screenshot, log, or file (optional)')
      .setRequired(false)
  )
  .setDMPermission(true);

// Enable modern Discord Contexts and Integration Types so command appears in Bot DMs
if (typeof commandData.setContexts === 'function' && InteractionContextType) {
  commandData.setContexts([
    InteractionContextType.Guild,
    InteractionContextType.BotDM,
    InteractionContextType.PrivateChannel,
  ]);
}

if (typeof commandData.setIntegrationTypes === 'function' && ApplicationIntegrationType) {
  commandData.setIntegrationTypes([
    ApplicationIntegrationType.GuildInstall,
    ApplicationIntegrationType.UserInstall,
  ]);
}

module.exports = {
  data: commandData,

  async execute(interaction) {
    const attachment = interaction.options?.getAttachment ? interaction.options.getAttachment('attachment') : null;
    if (attachment) {
      ticketSystem.setPendingAttachment(interaction.user.id, {
        name: attachment.name,
        url: attachment.url,
        contentType: attachment.contentType,
      });
    }

    // Section 1: /ticket ALWAYS shows the full 4-lane picker regardless of open tickets
    return ticketSystem.sendLanePicker(
      interaction,
      'Choose a lane below to open a new support ticket:'
    );
  },
};
