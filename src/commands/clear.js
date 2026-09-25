const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const api = require('../lib/api');

const CLEAR_PASSWORD = process.env.CLEAR_COMMAND_PASSWORD || 'mashood';

module.exports = {
  data: new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Delete messages from this channel (password protected).')
    .addStringOption((opt) =>
      opt
        .setName('password')
        .setDescription('Enter the password to authorize deletion')
        .setRequired(true)
    )
    .addIntegerOption((opt) =>
      opt
        .setName('amount')
        .setDescription('Number of messages to delete (1-100, default: 100)')
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(false)
    )
    .addUserOption((opt) =>
      opt
        .setName('user')
        .setDescription('Only delete messages from this specific user (optional)')
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  async execute(interaction) {
    // Keep response private so password and deletion feedback are ephemeral
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const enteredPassword = interaction.options.getString('password');
    if (enteredPassword?.trim() !== CLEAR_PASSWORD) {
      await interaction.editReply({
        content: '❌ Incorrect password. You are not authorized to use this command.',
      });
      return;
    }

    if (!interaction.inGuild() || !interaction.channel) {
      await interaction.editReply({
        content: '❌ This command can only be used inside a server text channel.',
      });
      return;
    }

    if (typeof interaction.channel.bulkDelete !== 'function') {
      await interaction.editReply({
        content: '❌ Bulk message deletion is not supported in this channel.',
      });
      return;
    }

    const botMember = interaction.guild.members.me;
    if (!botMember || !interaction.channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ManageMessages)) {
      await interaction.editReply({
        content: "❌ I don't have the **Manage Messages** permission in this channel. Please grant it to my role.",
      });
      return;
    }

    const amount = interaction.options.getInteger('amount') ?? 100;
    const targetUser = interaction.options.getUser('user');

    try {
      let deletedCount = 0;

      if (targetUser) {
        const fetchedMessages = await interaction.channel.messages.fetch({ limit: 100 });
        const userMessages = Array.from(fetchedMessages.values()).filter((m) => m.author?.id === targetUser.id);
        const toDelete = userMessages.slice(0, amount);

        if (toDelete.length === 0) {
          await interaction.editReply({
            content: `⚠️ No recent messages found from **${targetUser.tag}** in the last 100 messages.`,
          });
          return;
        }

        const deleted = await interaction.channel.bulkDelete(toDelete, true);
        deletedCount = deleted.size;

        if (deletedCount === 0) {
          await interaction.editReply({
            content: '⚠️ No messages were deleted. Note: Messages older than 14 days cannot be deleted due to Discord limitations.',
          });
          return;
        }

        await interaction.editReply({
          content: `🧹 Successfully deleted **${deletedCount}** message(s) from **${targetUser.tag}**.`,
        });
      } else {
        const deleted = await interaction.channel.bulkDelete(amount, true);
        deletedCount = deleted.size;

        if (deletedCount === 0) {
          await interaction.editReply({
            content: '⚠️ No messages were deleted. Note: Messages older than 14 days cannot be deleted due to Discord limitations.',
          });
          return;
        }

        const partialNotice = deletedCount < amount ? ' (Note: Messages older than 14 days were skipped).' : '';
        await interaction.editReply({
          content: `🧹 Successfully deleted **${deletedCount}** message(s).${partialNotice}`,
        });
      }

      // Log to #mod-log if channel exists
      const modLog = interaction.guild.channels.cache.find((c) => c.name === 'mod-log');
      if (modLog) {
        const userNote = targetUser ? ` from **${targetUser.tag}**` : '';
        modLog.send(`🧹 **${interaction.user.tag}** cleared **${deletedCount}** message(s)${userNote} in <#${interaction.channelId}>.`);
      }

      // Log chapter event to database
      const guildConfig = await api.getGuildConfig(interaction.guild.id).catch(() => null);
      api.logChapterEvent(interaction.client, guildConfig?.chapterId, interaction.guild.id, 'clear', {
        channelId: interaction.channelId,
        deletedCount,
        amountRequested: amount,
        targetUserId: targetUser ? targetUser.id : null,
        targetUserTag: targetUser ? targetUser.tag : null,
        by: interaction.user.tag,
        by_id: interaction.user.id,
      }, 'moderation').catch(() => {});
    } catch (err) {
      console.error('[clear] Error deleting messages:', err);
      await interaction.editReply({
        content: `❌ Failed to delete messages: ${err.message}`,
      });
    }
  },
};
