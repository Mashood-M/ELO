const { Events, AuditLogEvent } = require('discord.js');
const api = require('../lib/api');

module.exports = {
  name: Events.GuildMemberRemove,
  async execute(member) {
    try {
      if (!member.guild) return;

      const guildConfig = await api.getGuildConfig(member.guild.id).catch(() => null);
      if (!guildConfig || guildConfig.guildType !== 'chapter' || !guildConfig.chapterId) return;

      // Check audit logs to detect if member was kicked
      let isKick = false;
      let moderator = null;
      let moderatorId = null;
      let reason = 'No reason provided';

      try {
        const auditLogs = await member.guild.fetchAuditLogs({
          type: AuditLogEvent.MemberKick,
          limit: 1,
        }).catch(() => null);

        const entry = auditLogs?.entries?.first();
        if (entry && entry.target?.id === member.id && (Date.now() - entry.createdTimestamp < 8000)) {
          isKick = true;
          moderator = `${entry.executor.tag} (<@${entry.executor.id}>)`;
          moderatorId = entry.executor.id;
          if (entry.reason) reason = entry.reason;
        }
      } catch (_) {}

      const modLog = member.guild.channels.cache.find((c) => c.name === 'mod-log');

      if (isKick) {
        if (modLog) {
          modLog.send(`👢 **${member.user.tag}** was kicked by **${moderator}**. Reason: ${reason}`).catch(() => {});
        }

        await api.logChapterEvent(
          member.client,
          guildConfig.chapterId,
          member.guild.id,
          'kick',
          {
            target: `<@${member.id}> (${member.user.tag})`,
            moderator,
            reason,
            discord_user_id: member.id,
            by_id: moderatorId,
          },
          'moderation'
        ).catch(() => {});
      } else {
        if (modLog) {
          modLog.send(`📤 **${member.user.tag}** left the chapter server.`).catch(() => {});
        }

        await api.logChapterEvent(
          member.client,
          guildConfig.chapterId,
          member.guild.id,
          'leave',
          {
            username: member.user.tag,
            user: `<@${member.id}> (${member.user.tag})`,
            discord_user_id: member.id,
          },
          'membership'
        ).catch(() => {});
      }
    } catch (err) {
      console.error('[guildMemberRemove] Error handling member remove:', err.message);
    }
  },
};
