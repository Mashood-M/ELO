const { Events, AuditLogEvent } = require('discord.js');
const api = require('../lib/api');

module.exports = {
  name: Events.GuildBanAdd,
  async execute(ban) {
    try {
      if (!ban.guild) return;

      const guildConfig = await api.getGuildConfig(ban.guild.id).catch(() => null);
      if (!guildConfig || guildConfig.guildType !== 'chapter' || !guildConfig.chapterId) return;

      let moderator = 'Discord Staff / System';
      let moderatorId = null;
      let reason = ban.reason || 'No reason provided';

      try {
        const auditLogs = await ban.guild.fetchAuditLogs({
          type: AuditLogEvent.MemberBanAdd,
          limit: 1,
        }).catch(() => null);

        const entry = auditLogs?.entries?.first();
        if (entry && entry.target?.id === ban.user.id && (Date.now() - entry.createdTimestamp < 10000)) {
          moderator = `${entry.executor.tag} (<@${entry.executor.id}>)`;
          moderatorId = entry.executor.id;
          if (entry.reason) reason = entry.reason;
        }
      } catch (_) {}

      await api.logChapterEvent(
        ban.client,
        guildConfig.chapterId,
        ban.guild.id,
        'ban',
        {
          target: `<@${ban.user.id}> (${ban.user.tag})`,
          moderator,
          reason,
          discord_user_id: ban.user.id,
          by_id: moderatorId,
        },
        'moderation'
      );

      const modLog = ban.guild.channels.cache.find((c) => c.name === 'mod-log');
      if (modLog) {
        modLog.send(`🔨 **${ban.user.tag}** was banned by **${moderator}**. Reason: ${reason}`).catch(() => {});
      }
    } catch (err) {
      console.error('[guildBanAdd] Error handling ban event:', err.message);
    }
  },
};
