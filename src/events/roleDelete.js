const { Events } = require('discord.js');
const api = require('../lib/api');

module.exports = {
  name: Events.GuildRoleDelete,
  async execute(role) {
    try {
      if (!role.guild) return;
      const guildConfig = await api.getGuildConfig(role.guild.id).catch(() => null);
      if (!guildConfig || guildConfig.guildType !== 'chapter' || !guildConfig.chapterId) return;

      await api.logChapterEvent(
        role.client,
        guildConfig.chapterId,
        role.guild.id,
        'role_deleted',
        {
          role_name: role.name,
        },
        'channel_role_changes'
      );
    } catch (err) {
      console.error('[roleDelete] Error logging role deletion:', err.message);
    }
  },
};
