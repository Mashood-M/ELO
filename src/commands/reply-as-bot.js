const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
} = require('discord.js');
const config = require('../config');
const api = require('../lib/api');
const { checkCommandPermission } = require('../lib/permissions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('reply-as-bot')
    .setDescription('Reply to a message in the current channel as the bot.')
    .addStringOption((opt) =>
      opt
        .setName('message_id')
        .setDescription('The ID of the message to reply to')
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('text')
        .setDescription('The reply text to send as the bot')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!config.features?.adminBroadcast) {
      return interaction.editReply({
        content: '⚠️ Admin broadcast commands are currently disabled.',
      });
    }

    // Role check: Campus Lead (in their own chapter) or Founder/Admin
    if (!(await checkCommandPermission(interaction, 'reply-as-bot'))) return;

    const messageId = interaction.options.getString('message_id').trim();
    const replyText = interaction.options.getString('text');

    let targetMessage;
    try {
      targetMessage = await interaction.channel.messages.fetch(messageId);
    } catch (err) {
      return interaction.editReply({
        content: `⚠️ Could not find a message with ID \`${messageId}\` in this channel.`,
      });
    }

    try {
      await targetMessage.reply(replyText);

      await interaction.editReply({
        content: `✅ Successfully replied as bot to message \`${messageId}\`.`,
      });

      const guildConfig = await api.getGuildConfig(interaction.guild.id).catch(() => null);
      api.logChapterEvent(interaction.client, guildConfig?.chapterId, interaction.guild.id, 'reply_as_bot', {
        targetMessageId: messageId,
        channelId: interaction.channel.id,
        by: interaction.user.tag,
      }, 'channel_role_changes').catch(() => {});
    } catch (err) {
      console.error('[reply-as-bot] Error replying to message:', err);
      await interaction.editReply({
        content: `Failed to reply to message: ${err.message}`,
      });
    }
  },
};
