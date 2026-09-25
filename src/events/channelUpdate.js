const { Events, ChannelType } = require('discord.js');
const api = require('../lib/api');

module.exports = {
  name: Events.ChannelUpdate,
  async execute(oldChannel, newChannel) {
    try {
      if (!newChannel.guild) return;

      const guildConfig = await api.getGuildConfig(newChannel.guild.id).catch(() => null);
      if (!guildConfig || guildConfig.guildType !== 'chapter' || !guildConfig.chapterId) return;

      // Ignore internal bot forums or threads
      if (newChannel.name.startsWith('chp-')) return;

      const nameChanged = oldChannel.name !== newChannel.name;
      const topicChanged = (oldChannel.topic || '') !== (newChannel.topic || '');
      const parentChanged = oldChannel.parentId !== newChannel.parentId;

      if (!nameChanged && !topicChanged && !parentChanged) return;

      const details = {
        channel: `<#${newChannel.id}>`,
      };

      if (nameChanged) {
        details.name_change = `\`#${oldChannel.name}\` ➔ \`#${newChannel.name}\``;
      }
      if (topicChanged) {
        details.topic_change = `From: "${oldChannel.topic || 'None'}"\nTo: "${newChannel.topic || 'None'}"`;
      }
      if (parentChanged) {
        details.category_change = `From: "${oldChannel.parent ? oldChannel.parent.name : 'None'}" ➔ "${newChannel.parent ? newChannel.parent.name : 'None'}"`;
      }

      await api.logChapterEvent(
        newChannel.client,
        guildConfig.chapterId,
        newChannel.guild.id,
        'channel_updated',
        details,
        'channel_role_changes'
      );
    } catch (err) {
      console.error('[channelUpdate] Error logging channel update:', err.message);
    }
  },
};
