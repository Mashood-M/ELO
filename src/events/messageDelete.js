const { Events } = require('discord.js');
const api = require('../lib/api');

module.exports = {
  name: Events.MessageDelete,
  async execute(message) {
    try {
      if (!message.guild) return;
      if (message.author?.bot) return;

      const guildConfig = await api.getGuildConfig(message.guild.id).catch(() => null);
      if (!guildConfig || guildConfig.guildType !== 'chapter' || !guildConfig.chapterId) return;

      const content = message.cleanContent || message.content || (message.attachments?.size ? '(Attachment only)' : '(No content/Uncached)');
      const attachments = message.attachments?.size
        ? message.attachments.map((a) => a.name || a.url).join(', ')
        : 'None';

      await api.logChapterEvent(
        message.client,
        guildConfig.chapterId,
        message.guild.id,
        'message_deleted',
        {
          author: message.author ? `<@${message.author.id}> (${message.author.tag})` : 'Unknown User',
          channel: `<#${message.channel.id}>`,
          content: content.slice(0, 1000),
          attachments,
          discord_user_id: message.author?.id || null,
        },
        'discord_activity'
      );

      // Local server mod-log
      const modLog = message.guild.channels.cache.find((c) => c.name === 'mod-log');
      if (modLog && message.author) {
        modLog.send(`🗑️ Message by **${message.author.tag}** deleted in <#${message.channel.id}>:\n> ${content.slice(0, 300)}`).catch(() => {});
      }
    } catch (err) {
      console.error('[messageDelete] Error logging deleted message:', err.message);
    }
  },
};
