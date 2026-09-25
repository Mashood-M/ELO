const { Events } = require('discord.js');
const api = require('../lib/api');

module.exports = {
  name: Events.GuildMemberUpdate,
  async execute(oldMember, newMember) {
    try {
      if (!newMember.guild) return;
      if (newMember.user.bot) return;

      // 1. Detect role additions and removals
      const addedRoles = newMember.roles.cache.filter(
        (r) => !oldMember.roles.cache.has(r.id) && !r.managed && r.name !== '@everyone'
      );
      const removedRoles = oldMember.roles.cache.filter(
        (r) => !newMember.roles.cache.has(r.id) && !r.managed && r.name !== '@everyone'
      );

      const hasRoleChanges = addedRoles.size > 0 || removedRoles.size > 0;
      const nicknameChanged = oldMember.displayName !== newMember.displayName;

      const wasTimedOut = oldMember.isCommunicationDisabled();
      const isTimedOut = newMember.isCommunicationDisabled();
      const timeoutChanged = wasTimedOut !== isTimedOut;

      if (!hasRoleChanges && !nicknameChanged && !timeoutChanged) return;

      // 2. Resolve chapter ID for this member and guild
      let chapterId = null;
      const guildConfig = await api.getGuildConfig(newMember.guild.id).catch(() => null);

      if (guildConfig?.guildType === 'chapter' && guildConfig.chapterId) {
        chapterId = guildConfig.chapterId;
      } else {
        const identity = await api.getIdentityByDiscordId(newMember.id).catch(() => null);
        chapterId = identity?.profile?.chapter_id || identity?.chapterId || null;
      }

      // 3. Log each role addition to the chapter forum log
      for (const [, role] of addedRoles) {
        console.log(`[GuildMemberUpdate] Role "${role.name}" assigned to ${newMember.user.tag} in ${newMember.guild.name}`);
        if (chapterId) {
          await api.logChapterEvent(
            newMember.client,
            chapterId,
            newMember.guild.id,
            'role_assigned',
            {
              user: `<@${newMember.id}> (${newMember.displayName})`,
              role: role.name,
              server: newMember.guild.name,
              discord_user_id: newMember.id,
            },
            'role_changes'
          ).catch((err) => console.warn('[GuildMemberUpdate] logChapterEvent error:', err.message));
        }
      }

      // 4. Log each role removal to the chapter forum log
      for (const [, role] of removedRoles) {
        console.log(`[GuildMemberUpdate] Role "${role.name}" removed from ${newMember.user.tag} in ${newMember.guild.name}`);
        if (chapterId) {
          await api.logChapterEvent(
            newMember.client,
            chapterId,
            newMember.guild.id,
            'role_revoked',
            {
              user: `<@${newMember.id}> (${newMember.displayName})`,
              role: role.name,
              server: newMember.guild.name,
              discord_user_id: newMember.id,
            },
            'role_changes'
          ).catch((err) => console.warn('[GuildMemberUpdate] logChapterEvent error:', err.message));
        }
      }

      // 5. Detect and log timeouts (mutes / unmutes)
      if (timeoutChanged && chapterId) {
        let moderator = 'Discord Staff / System';
        let moderatorId = null;
        let reason = 'No reason provided';

        try {
          const { AuditLogEvent } = require('discord.js');
          const auditLogs = await newMember.guild.fetchAuditLogs({
            type: AuditLogEvent.MemberUpdate,
            limit: 1,
          }).catch(() => null);

          const entry = auditLogs?.entries?.first();
          if (entry && entry.target?.id === newMember.id && (Date.now() - entry.createdTimestamp < 8000)) {
            moderator = `${entry.executor.tag} (<@${entry.executor.id}>)`;
            moderatorId = entry.executor.id;
            if (entry.reason) reason = entry.reason;
          }
        } catch (_) {}

        const modLog = newMember.guild.channels.cache.find((c) => c.name === 'mod-log');

        if (!wasTimedOut && isTimedOut) {
          const until = newMember.communicationDisabledUntil;
          const untilStr = until ? `<t:${Math.floor(until.getTime() / 1000)}:R>` : 'Active';

          if (modLog) {
            modLog.send(`🔇 **${newMember.user.tag}** was timed out until ${untilStr} by **${moderator}**. Reason: ${reason}`).catch(() => {});
          }

          await api.logChapterEvent(
            newMember.client,
            chapterId,
            newMember.guild.id,
            'mute',
            {
              target: `<@${newMember.id}> (${newMember.user.tag})`,
              duration: untilStr,
              moderator,
              reason,
              discord_user_id: newMember.id,
              by_id: moderatorId,
            },
            'moderation'
          ).catch(() => {});
        } else if (wasTimedOut && !isTimedOut) {
          if (modLog) {
            modLog.send(`🔊 Timeout removed for **${newMember.user.tag}** by **${moderator}**.`).catch(() => {});
          }

          await api.logChapterEvent(
            newMember.client,
            chapterId,
            newMember.guild.id,
            'unmute',
            {
              target: `<@${newMember.id}> (${newMember.user.tag})`,
              moderator,
              discord_user_id: newMember.id,
              by_id: moderatorId,
            },
            'moderation'
          ).catch(() => {});
        }
      }

      // 6. Detect and log nickname changes
      if (nicknameChanged && chapterId) {
        await api.logChapterEvent(
          newMember.client,
          chapterId,
          newMember.guild.id,
          'nickname_changed',
          {
            user: `<@${newMember.id}> (${newMember.user.tag})`,
            before: oldMember.displayName,
            after: newMember.displayName,
            discord_user_id: newMember.id,
          },
          'membership'
        ).catch(() => {});
      }

      // 7. Dynamically refresh live roster in 👥 Current Roles topic
      if (chapterId && hasRoleChanges) {
        await api.updateChapterCurrentRolesTopic(newMember.client, chapterId).catch(() => {});
      }
    } catch (err) {
      console.error('[GuildMemberUpdate] Error handling member update:', err.message);
    }
  },
};
