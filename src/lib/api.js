const crypto = require('crypto');
const supabase = require('./supabase');

/**
 * Safely format an error into a standard Error object without exposing
 * service role keys or internal secrets to Discord users.
 */
function formatError(error, defaultMessage = 'Database operation failed') {
  if (!error) return new Error(defaultMessage);
  let message = typeof error === 'string' ? error : (error.message || defaultMessage);
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (key && key.length > 5 && message.includes(key)) {
    message = message.split(key).join('[REDACTED]');
  }
  const err = new Error(message);
  if (error.code) err.code = error.code;
  return err;
}

module.exports = {
  /**
   * Generates a secure 6-digit OTP code (valid for 15 minutes) for account linking.
   * Matches chapter to guild, validates user exists, inserts OTP into discord_verification_codes,
   * and returns the OTP code and instructions (does NOT immediately link account).
   */
  async generateVerificationOtp(osUserId, discordUserId, discordUsername, guildId) {
    try {
      // 1. Look up guild_config by guildId to get chapter_id for this guild
      const { data: guildConfig, error: guildErr } = await supabase
        .from('guild_config')
        .select('guild_id, guild_type, chapter_id')
        .eq('guild_id', guildId)
        .maybeSingle();

      if (guildErr) {
        throw formatError(guildErr, 'Failed to look up guild configuration');
      }

      // If guild is not configured or has no chapter mapped, cannot verify
      if (!guildConfig || !guildConfig.chapter_id) {
        return { ok: false, reason: 'chapter_mismatch' };
      }

      // 2. Look up user by elevates_id (e.g. ELV-0076), raw digits, email, or UUID
      let cleanInput = (osUserId || '').trim();
      // Strip leading '#' if entered
      if (cleanInput.startsWith('#')) cleanInput = cleanInput.slice(1).trim();

      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanInput);
      const isEmail = cleanInput.includes('@');
      const isDigitsOnly = /^\d+$/.test(cleanInput);

      // Normalize variations like "elv0076" -> "ELV-0076" or "76" -> "ELV-0076"
      let normalizedElevatesId = cleanInput;
      if (/^elv\d+$/i.test(cleanInput)) {
        normalizedElevatesId = 'ELV-' + cleanInput.slice(3);
      } else if (isDigitsOnly) {
        normalizedElevatesId = 'ELV-' + cleanInput.padStart(4, '0');
      }

      let user = null;
      let foundProfile = null;

      if (isUuid) {
        const { data } = await supabase.from('profiles').select('*').eq('id', cleanInput).maybeSingle();
        foundProfile = data;
      } else if (isEmail) {
        const { data } = await supabase.from('profiles').select('*').ilike('email', cleanInput).maybeSingle();
        foundProfile = data;
      } else {
        // Try normalized ELV ID first, then fallback to literal input
        let query = supabase.from('profiles').select('*').ilike('elevates_id', normalizedElevatesId);
        let { data } = await query.maybeSingle();
        if (!data && normalizedElevatesId !== cleanInput) {
          const fallback = await supabase.from('profiles').select('*').ilike('elevates_id', cleanInput).maybeSingle();
          data = fallback.data;
        }
        foundProfile = data;
      }

      if (foundProfile) {
        user = {
          id: foundProfile.id,
          name: foundProfile.full_name || foundProfile.name || 'Member',
          chapter_id: foundProfile.chapter_id,
          role: foundProfile.role || null,
          designation: foundProfile.designation || null,
          elevates_id: foundProfile.elevates_id || null,
        };

        // Sync to users table to satisfy foreign key constraints
        try {
          await supabase.from('users').upsert({
            id: user.id,
            name: user.name,
            chapter_id: user.chapter_id,
            role: user.role,
            designation: user.designation,
          });
        } catch (_) {}
      } else if (isUuid) {
        // Fallback to users table if input was a UUID
        const { data: dbUser, error: userErr } = await supabase
          .from('users')
          .select('*')
          .eq('id', cleanInput)
          .maybeSingle();

        if (userErr) throw formatError(userErr, 'Failed to look up user');
        if (dbUser) user = dbUser;
      }

      if (!user) {
        return { ok: false, reason: 'not_found', input: cleanInput };
      }

      // If user has no chapter assigned yet, attach them to this chapter
      if (!user.chapter_id) {
        user.chapter_id = guildConfig.chapter_id;
        await supabase.from('profiles').update({ chapter_id: guildConfig.chapter_id }).eq('id', user.id).catch(() => {});
        await supabase.from('users').update({ chapter_id: guildConfig.chapter_id }).eq('id', user.id).catch(() => {});
      } else if (user.chapter_id !== guildConfig.chapter_id) {
        // Look up registered chapter name for a friendly error message
        let userChapterName = 'another chapter';
        const { data: userChapter } = await supabase.from('chapters').select('name').eq('id', user.chapter_id).maybeSingle();
        if (userChapter?.name) userChapterName = userChapter.name;
        return {
          ok: false,
          reason: 'chapter_mismatch',
          userChapterName,
          guildChapterName: guildConfig.chapter_id,
          userName: user.name,
        };
      }

      // Look up chapter name
      let chapterName = null;
      if (user.chapter_id) {
        const { data: chapter, error: chapterErr } = await supabase
          .from('chapters')
          .select('name')
          .eq('id', user.chapter_id)
          .maybeSingle();

        if (chapterErr) {
          throw formatError(chapterErr, 'Failed to fetch chapter details');
        }
        if (chapter) {
          chapterName = chapter.name;
        }
      }

      // 3. Generate a secure 6-digit OTP code (100000 - 999999)
      const otpCode = crypto.randomInt(100000, 1000000).toString();
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

      // Invalidate / expire any prior pending codes for this user
      await supabase
        .from('discord_verification_codes')
        .update({ status: 'expired' })
        .eq('os_user_id', user.id)
        .eq('status', 'pending');

      // 4. Insert new OTP code into public.discord_verification_codes (valid for 15 minutes)
      const { error: otpErr } = await supabase
        .from('discord_verification_codes')
        .insert({
          os_user_id: user.id,
          discord_user_id: discordUserId,
          discord_username: discordUsername,
          guild_id: guildId,
          otp_code: otpCode,
          status: 'pending',
          expires_at: expiresAt,
        });

      if (otpErr) {
        throw formatError(otpErr, 'Failed to store verification code');
      }

      // 5. Log OTP generation to event audit log
      await supabase
        .from('discord_events_log')
        .insert({
          guild_id: guildId,
          discord_user_id: discordUserId,
          event_type: 'otp_generated',
          detail: { os_user_id: user.id, expires_at: expiresAt },
        })
        .catch(() => {});

      return {
        ok: true,
        otpCode,
        expiresAt,
        userName: user.name,
        elevatesId: foundProfile?.elevates_id || cleanInput,
        chapterName: chapterName || 'your chapter',
        userId: user.id,
        designation: user.designation || user.role || null,
      };
    } catch (err) {
      throw formatError(err, 'Verification OTP generation failed');
    }
  },

  /**
   * Legacy / direct alias for verification. Now delegates to OTP generation.
   */
  async verifyOsUserId(osUserId, discordUserId, discordUsername, guildId) {
    return this.generateVerificationOtp(osUserId, discordUserId, discordUsername, guildId);
  },

  /**
   * Safely synchronizes Discord guild member roles & nickname upon verified account status.
   */
  async syncMemberRoles(guild, member, profile) {
    if (!guild || !member) return false;
    try {
      const config = require('../config');
      const unverifiedRole = guild.roles.cache.find(
        (r) => !r.managed && r.name.toLowerCase() === config.roles.unverified?.toLowerCase()
      );
      const verifiedRole = guild.roles.cache.find(
        (r) => !r.managed && r.name.toLowerCase() === config.roles.verified?.toLowerCase()
      );

      if (unverifiedRole && member.roles.cache.has(unverifiedRole.id)) {
        await member.roles.remove(unverifiedRole).catch(() => {});
      }
      if (verifiedRole && !member.roles.cache.has(verifiedRole.id)) {
        await member.roles.add(verifiedRole).catch(() => {});
      }

      if (profile?.designation === 'campus_lead') {
        const leadRole = guild.roles.cache.find((r) => r.name === config.roles.campusLead);
        if (leadRole && !member.roles.cache.has(leadRole.id)) {
          await member.roles.add(leadRole).catch(() => {});
        }
      } else if (profile?.designation === 'class_rep') {
        const repRole = guild.roles.cache.find((r) => r.name === config.roles.classRep);
        if (repRole && !member.roles.cache.has(repRole.id)) {
          await member.roles.add(repRole).catch(() => {});
        }
      }

      if (profile?.name) {
        await member.setNickname(profile.name).catch(() => {});
      }

      return true;
    } catch (err) {
      console.error('Error in syncMemberRoles:', err);
      return false;
    }
  },

  /**
   * Checks if a Discord user is currently linked in a guild.
   * Returns the link record and profile full_name if linked, otherwise null.
   */
  async getUserLink(discordUserId, guildId) {
    try {
      const { data, error } = await supabase
        .from('discord_links')
        .select('*')
        .eq('discord_user_id', discordUserId)
        .eq('guild_id', guildId)
        .eq('status', 'linked')
        .maybeSingle();

      if (error || !data) return null;

      let name = null;
      let elevatesId = null;
      if (data.os_user_id) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('full_name, elevates_id')
          .eq('id', data.os_user_id)
          .maybeSingle();

        if (profile) {
          name = profile.full_name;
          elevatesId = profile.elevates_id;
        }
      }

      return {
        ...data,
        name,
        elevatesId,
      };
    } catch (_) {
      return null;
    }
  },

  /**
   * Looks up which chapter (if any) a guild is mapped to.
   * Left joins chapters for chapterName. Return null if not found.
   */
  async getGuildConfig(guildId) {
    try {
      const { data, error } = await supabase
        .from('guild_config')
        .select('*, chapters(name)')
        .eq('guild_id', guildId)
        .maybeSingle();

      if (error) {
        // Fallback if PostgREST relation syntax encounters schema issues
        const { data: simpleData, error: simpleErr } = await supabase
          .from('guild_config')
          .select('*')
          .eq('guild_id', guildId)
          .maybeSingle();

        if (simpleErr) throw formatError(simpleErr, 'Failed to fetch guild configuration');
        if (!simpleData) return null;

        let chapterName = null;
        if (simpleData.chapter_id) {
          const { data: chapter } = await supabase
            .from('chapters')
            .select('name')
            .eq('id', simpleData.chapter_id)
            .maybeSingle();
          if (chapter) chapterName = chapter.name;
        }

        return {
          guildId: simpleData.guild_id,
          guild_id: simpleData.guild_id,
          guildType: simpleData.guild_type,
          guild_type: simpleData.guild_type,
          chapterId: simpleData.chapter_id,
          chapter_id: simpleData.chapter_id,
          chapterName,
          chapter_name: chapterName,
          createdAt: simpleData.created_at,
          created_at: simpleData.created_at,
        };
      }

      if (!data) return null;

      const chapterName = data.chapters?.name
        || (Array.isArray(data.chapters) ? data.chapters[0]?.name : null)
        || null;

      return {
        guildId: data.guild_id,
        guild_id: data.guild_id,
        guildType: data.guild_type,
        guild_type: data.guild_type,
        chapterId: data.chapter_id,
        chapter_id: data.chapter_id,
        chapterName,
        chapter_name: chapterName,
        createdAt: data.created_at,
        created_at: data.created_at,
      };
    } catch (err) {
      throw formatError(err, 'Failed to fetch guild configuration');
    }
  },

  /**
   * Registers or updates a guild configuration.
   * Upserts into guild_config and returns row including chapterName from chapters lookup.
   */
  async setGuildConfig(guildId, chapterId, guildType) {
    try {
      const { data, error } = await supabase
        .from('guild_config')
        .upsert(
          {
            guild_id: guildId,
            chapter_id: chapterId,
            guild_type: guildType,
          },
          { onConflict: 'guild_id' }
        )
        .select()
        .single();

      if (error) {
        throw formatError(error, 'Failed to set guild configuration');
      }

      let chapterName = null;
      if (chapterId) {
        const { data: chapter, error: chapErr } = await supabase
          .from('chapters')
          .select('name')
          .eq('id', chapterId)
          .maybeSingle();

        if (chapErr) {
          throw formatError(chapErr, 'Failed to look up chapter details');
        }
        if (chapter) {
          chapterName = chapter.name;
        }
      }

      return {
        guildId: data.guild_id,
        guild_id: data.guild_id,
        chapterId: data.chapter_id,
        chapter_id: data.chapter_id,
        guildType: data.guild_type,
        guild_type: data.guild_type,
        chapterName,
        chapter_name: chapterName,
        createdAt: data.created_at,
        created_at: data.created_at,
      };
    } catch (err) {
      throw formatError(err, 'Failed to configure server');
    }
  },

  /**
   * Marks a link as unlinked (member left or was force-unlinked).
   * Updates discord_links status and logs to discord_events_log.
   */
  async unlinkUser(discordUserId, guildId, reason) {
    try {
      const now = new Date().toISOString();
      const { error: updateErr } = await supabase
        .from('discord_links')
        .update({
          status: 'unlinked',
          unlinked_at: now,
        })
        .eq('discord_user_id', discordUserId)
        .eq('guild_id', guildId);

      if (updateErr) {
        throw formatError(updateErr, 'Failed to update member link status');
      }

      const { error: logErr } = await supabase
        .from('discord_events_log')
        .insert({
          guild_id: guildId,
          discord_user_id: discordUserId,
          event_type: 'unlink',
          detail: { reason },
        });

      if (logErr) {
        throw formatError(logErr, 'Failed to log unlink event');
      }

      return { ok: true };
    } catch (err) {
      throw formatError(err, 'Failed to unlink user');
    }
  },

  /**
   * Fetches the current linked-member list for a chapter.
   * Selects discord_links joined with users where users.chapter_id = chapterId and discord_links.status = 'linked'.
   * Returns { members: [{ name, designation }, ...] }.
   */
  async getClusterMembers(chapterId) {
    try {
      const { data, error } = await supabase
        .from('discord_links')
        .select('os_user_id, status, users!inner(name, chapter_id, role, designation)')
        .eq('status', 'linked')
        .eq('users.chapter_id', chapterId);

      if (!error && data) {
        const members = data.map((row) => {
          const u = Array.isArray(row.users) ? row.users[0] : row.users;
          return {
            name: u?.name || 'Unknown',
            designation: u?.designation || u?.role || null,
          };
        });
        return { members };
      }

      // Fallback in case PostgREST nested inner join is unavailable
      const { data: users, error: usersErr } = await supabase
        .from('users')
        .select('id, name, role, designation')
        .eq('chapter_id', chapterId);

      if (usersErr) {
        throw formatError(usersErr, 'Failed to query users for cluster');
      }
      if (!users || users.length === 0) {
        return { members: [] };
      }

      const userIds = users.map((u) => u.id);
      const { data: links, error: linksErr } = await supabase
        .from('discord_links')
        .select('os_user_id')
        .eq('status', 'linked')
        .in('os_user_id', userIds);

      if (linksErr) {
        throw formatError(linksErr, 'Failed to query link status for cluster');
      }

      const linkedUserIds = new Set((links || []).map((l) => l.os_user_id));
      const members = users
        .filter((u) => linkedUserIds.has(u.id))
        .map((u) => ({
          name: u.name,
          designation: u.designation || u.role || null,
        }));

      return { members };
    } catch (err) {
      throw formatError(err, 'Failed to fetch cluster members');
    }
  },

  /**
   * Writes any event (join/leave/verify/kick/ban/mute/warn) to the audit log.
   * Plain insert into discord_events_log.
   */
  async logEvent(guildId, discordUserId, eventType, detail) {
    try {
      const { data, error } = await supabase
        .from('discord_events_log')
        .insert({
          guild_id: guildId,
          discord_user_id: discordUserId,
          event_type: eventType,
          detail: detail || {},
        })
        .select()
        .single();

      if (error) {
        throw formatError(error, 'Failed to log event');
      }

      return data;
    } catch (err) {
      throw formatError(err, 'Failed to log event');
    }
  },

  /**
   * Records a warning against a user.
   * Plain insert into discord_warnings.
   */
  async addWarning(discordUserId, guildId, reason, issuedBy) {
    try {
      const { data, error } = await supabase
        .from('discord_warnings')
        .insert({
          discord_user_id: discordUserId,
          guild_id: guildId,
          reason,
          issued_by: issuedBy,
        })
        .select()
        .single();

      if (error) {
        throw formatError(error, 'Failed to record warning');
      }

      return {
        id: data.id,
        discordUserId: data.discord_user_id,
        discord_user_id: data.discord_user_id,
        guildId: data.guild_id,
        guild_id: data.guild_id,
        reason: data.reason,
        issuedBy: data.issued_by,
        issued_by: data.issued_by,
        createdAt: data.created_at,
        created_at: data.created_at,
      };
    } catch (err) {
      throw formatError(err, 'Failed to record warning');
    }
  },

  /**
   * Fetches warning history for a user in a guild ordered by created_at desc.
   * Returns { items: [...] }.
   */
  async getWarnings(guildId, discordUserId) {
    try {
      const { data, error } = await supabase
        .from('discord_warnings')
        .select('*')
        .eq('guild_id', guildId)
        .eq('discord_user_id', discordUserId)
        .order('created_at', { ascending: false });

      if (error) {
        throw formatError(error, 'Failed to fetch warnings');
      }

      const items = (data || []).map((row) => ({
        id: row.id,
        discordUserId: row.discord_user_id,
        discord_user_id: row.discord_user_id,
        guildId: row.guild_id,
        guild_id: row.guild_id,
        reason: row.reason,
        issuedBy: row.issued_by,
        issued_by: row.issued_by,
        createdAt: row.created_at,
        created_at: row.created_at,
      }));

      return { items };
    } catch (err) {
      throw formatError(err, 'Failed to fetch warnings');
    }
  },

  /**
   * Looks up the main guild configuration (guild_type = 'main').
   * Returns guild_config row or null.
   */
  async getMainGuildConfig() {
    try {
      const { data, error } = await supabase
        .from('guild_config')
        .select('*')
        .eq('guild_type', 'main')
        .limit(1)
        .maybeSingle();

      if (error || !data) return null;
      return {
        guildId: data.guild_id,
        guild_id: data.guild_id,
        guildType: data.guild_type,
        guild_type: data.guild_type,
        chapterId: data.chapter_id,
        chapter_id: data.chapter_id,
      };
    } catch (_) {
      return null;
    }
  },
};
