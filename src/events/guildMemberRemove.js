const { Events } = require('discord.js');
const api = require('../lib/api');

module.exports = {
  name: Events.GuildMemberRemove,
  async execute(member) {
    let guildConfig;
    try {
      guildConfig = await api.getGuildConfig(member.guild.id);
    } catch (err) {
      console.error('[guildMemberRemove] Failed to fetch guild config on leave:', err.message);
      return;
    }

    if (!guildConfig || guildConfig.guildType !== 'chapter') return;

    const modLog = member.guild.channels.cache.find((c) => c.name === 'mod-log');
    if (modLog) {
      modLog.send(`📤 **${member.user.tag}** left the chapter server.`);
    }

    api.logChapterEvent(member.client, guildConfig.chapterId, member.guild.id, 'leave', {
      username: member.user.tag,
      discord_user_id: member.id,
    }, 'membership').catch(() => {});
  },
};
