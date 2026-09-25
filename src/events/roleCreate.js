const { Events } = require('discord.js');
const api = require('../lib/api');

module.exports = {
  name: Events.GuildRoleCreate,
  async execute(role) {
    try {
      if (!role.guild) return;
      const guildConfig = await api.getGuildConfig(role.guild.id).catch(() => null);
      if (!guildConfig || guildConfig.guildType !== 'chapter' || !guildConfig.chapterId) return;

      await api.logChapterEvent(
        role.client,
        guildConfig.chapterId,
        role.guild.id,
        'role_created',
        {
          role_name: role.name,
          color: role.hexColor,
          mentionable: role.mentionable ? 'Yes' : 'No',
        },
        'channel_role_changes'
      );
    } catch (err) {
      console.error('[roleCreate] Error logging role creation:', err.message);
    }
  },
};
