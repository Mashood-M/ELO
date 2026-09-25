const { Events } = require('discord.js');
const api = require('../lib/api');

module.exports = {
  name: Events.MessageUpdate,
  async execute(oldMessage, newMessage) {
    try {
      if (!newMessage.guild) return;
      if (newMessage.author?.bot) return;

      // Ignore if content hasn't changed (e.g. Discord generating link preview embeds)
      if (oldMessage.content === newMessage.content) return;

      const guildConfig = await api.getGuildConfig(newMessage.guild.id).catch(() => null);
      if (!guildConfig || guildConfig.guildType !== 'chapter' || !guildConfig.chapterId) return;

      const beforeContent = oldMessage.cleanContent || oldMessage.content || '(Previous content uncached)';
      const afterContent = newMessage.cleanContent || newMessage.content || '(Empty content)';

      await api.logChapterEvent(
        newMessage.client,
        guildConfig.chapterId,
        newMessage.guild.id,
        'message_edited',
        {
          author: `<@${newMessage.author.id}> (${newMessage.author.tag})`,
          channel: `<#${newMessage.channel.id}>`,
          before: beforeContent.slice(0, 500),
          after: afterContent.slice(0, 500),
          jump_to_message: newMessage.url,
          discord_user_id: newMessage.author.id,
        },
        'discord_activity'
      );

      const modLog = newMessage.guild.channels.cache.find((c) => c.name === 'mod-log');
      if (modLog) {
        modLog.send(
          `✏️ Message edited by **${newMessage.author.tag}** in <#${newMessage.channel.id}>: [Jump](${newMessage.url})\n` +
          `**Before:** ${beforeContent.slice(0, 200)}\n` +
          `**After:** ${afterContent.slice(0, 200)}`
        ).catch(() => {});
      }
    } catch (err) {
      console.error('[messageUpdate] Error logging edited message:', err.message);
    }
  },
};
