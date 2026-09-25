const { Events, ChannelType } = require('discord.js');
const api = require('../lib/api');

module.exports = {
  name: Events.ChannelCreate,
  async execute(channel) {
    try {
      if (!channel.guild) return;
      const guildConfig = await api.getGuildConfig(channel.guild.id).catch(() => null);
      if (!guildConfig || guildConfig.guildType !== 'chapter' || !guildConfig.chapterId) return;

      // Ignore chapter forum channels or threads in main guild
      if (channel.name.startsWith('chp-')) return;

      const typeName = Object.keys(ChannelType).find((k) => ChannelType[k] === channel.type) || 'Channel';

      await api.logChapterEvent(
        channel.client,
        guildConfig.chapterId,
        channel.guild.id,
        'channel_created',
        {
          name: channel.name,
          type: typeName,
          category: channel.parent ? channel.parent.name : 'None',
        },
        'channel_role_changes'
      );
    } catch (err) {
      console.error('[channelCreate] Error logging channel creation:', err.message);
    }
  },
};
