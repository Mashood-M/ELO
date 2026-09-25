const { Events } = require('discord.js');
const api = require('../lib/api');

module.exports = {
  name: Events.VoiceStateUpdate,
  async execute(oldState, newState) {
    try {
      const guild = newState.guild || oldState.guild;
      if (!guild) return;

      const member = newState.member || oldState.member;
      if (!member || member.user.bot) return;

      const guildConfig = await api.getGuildConfig(guild.id).catch(() => null);
      if (!guildConfig || guildConfig.guildType !== 'chapter' || !guildConfig.chapterId) return;

      let eventType = null;
      const details = {
        member: `<@${member.id}> (${member.user.tag})`,
        discord_user_id: member.id,
      };

      if (!oldState.channelId && newState.channelId) {
        eventType = 'voice_joined';
        details.action = 'Joined voice channel';
        details.channel = `<#${newState.channelId}> (${newState.channel.name})`;
      } else if (oldState.channelId && !newState.channelId) {
        eventType = 'voice_left';
        details.action = 'Left voice channel';
        details.channel = `<#${oldState.channelId}> (${oldState.channel.name})`;
      } else if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
        eventType = 'voice_moved';
        details.action = 'Switched voice channels';
        details.from = `<#${oldState.channelId}> (${oldState.channel.name})`;
        details.to = `<#${newState.channelId}> (${newState.channel.name})`;
      }

      if (!eventType) return;

      await api.logChapterEvent(
        guild.client,
        guildConfig.chapterId,
        guild.id,
        eventType,
        details,
        'discord_activity'
      );
    } catch (err) {
      console.error('[voiceStateUpdate] Error logging voice state update:', err.message);
    }
  },
};
