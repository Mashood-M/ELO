const { Events } = require('discord.js');
const api = require('../lib/api');
const verifySessions = require('../lib/verifySessions');

module.exports = {
  name: Events.GuildMemberRemove,
  async execute(member) {
    verifySessions.clear(member.id);

    let guildConfig;
    try {
      guildConfig = await api.getGuildConfig(member.guild.id);
    } catch (err) {
      console.error('Failed to fetch guild config on leave:', err.message);
      return;
    }

    if (!guildConfig || guildConfig.guildType !== 'chapter') return;

    try {
      await api.unlinkUser(member.id, member.guild.id, 'left_server');
    } catch (err) {
      console.error('Failed to unlink user on leave:', err.message);
    }

    const modLog = member.guild.channels.cache.find((c) => c.name === 'mod-log');
    if (modLog) {
      modLog.send(`📤 **${member.user.tag}** left the server. Cluster count updated.`);
    }

    api.logEvent(member.guild.id, member.id, 'leave', { username: member.user.tag }).catch(() => {});
  },
};
