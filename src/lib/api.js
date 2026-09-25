const crypto = require('crypto');
const { ChannelType, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const supabase = require('./supabase');
const syncQueue = require('./syncQueue');
const config = require('../config');

// In-memory fallback token store if DB table chapter_setup_tokens is not yet migrated
const inMemorySetupTokens = new Map();
// In-memory cache for resolved chapter forum channels and thread maps
const chapterForumCache = new Map();

// In-memory cache for guild_config with TTL to reduce DB lookups (Section 5.2)
const guildConfigCache = new Map(); // guildId -> { data, cachedAt }
const GUILD_CONFIG_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Periodic cleanup of stale inMemorySetupTokens and guildConfigCache (Section 5.6)
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of inMemorySetupTokens.entries()) {
    if (data.expires_at && new Date(data.expires_at).getTime() < now) {
      inMemorySetupTokens.delete(token);
    }
  }
  for (const [guildId, entry] of guildConfigCache.entries()) {
    if (now - entry.cachedAt > GUILD_CONFIG_TTL_MS) {
      guildConfigCache.delete(guildId);
    }
  }
}, 10 * 60 * 1000).unref();

// Canonical topic specifications for chapter audit forums
const STARTER_THREADS = [
  {
    key: 'role_changes',
    name: '🎭 Role Changes',
    description: 'ElevatesOS role assignments, promotions, demotions, and permission updates',
    matchTerms: ['role changes', 'roles changes', 'role_changes'],
  },
  {
    key: 'current_roles',
    name: '👥 Current Roles',
    description: 'live synchronized roster of all current chapter leads, core team, and role holders',
    matchTerms: ['current roles', 'current_roles', 'roster'],
  },
  {
    key: 'term_handover',
    name: '🔄 Term Handover',
    description: 'chapter term handovers, old CL/executive team demoted, new CL/executive team assigned',
    matchTerms: ['term handover', 'term handovers', 'term_handover', 'term_handovers', 'handover', 'term transition'],
  },
  {
    key: 'events',
    name: '📅 Events & Meetups',
    description: 'event creation, schedule updates, attendance check-ins, and form releases',
    matchTerms: ['events', 'meetups', 'event creation'],
  },
  {
    key: 'cluster_activity',
    name: '🧠 Cluster Activity',
    description: 'cluster created, member added/removed, host assigned/removed, tasks',
    matchTerms: ['cluster'],
  },
  {
    key: 'moderation',
    name: '🛡️ Moderation',
    description: 'kicks, bans, mutes, warns, and unlinks',
    matchTerms: ['moderation'],
  },
  {
    key: 'membership',
    name: '👤 Membership',
    description: 'member joined/left the chapter server, account linked/unlinked',
    matchTerms: ['membership'],
  },
  {
    key: 'channel_role_changes',
    name: '⚙️ Channel & Role Changes',
    description: 'server configuration, discord channels, and discord server role changes',
    matchTerms: ['channel & role', 'server & channel', 'channel_role_changes', 'server logs', 'channel'],
  },
  {
    key: 'discord_activity',
    name: '💬 Discord Activity',
    description: 'deleted messages, message edits, voice activity, invites, and discord server events',
    matchTerms: ['discord activity', 'discord logs', 'chat', 'voice logs', 'discord messages'],
  },
];

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
  STARTER_THREADS,
  /**
   * Generates a secure 6-digit OTP code (valid for 4 hours) for account linking.
   * Looks up user in profiles (by elevates_id, raw digits, UUID, or email).
   * Inserts OTP into discord_verification_codes and returns OTP code.
   */
  async generateVerificationOtp(osUserIdInput, discordUserId, discordUsername, guildId) {
    try {
      let cleanInput = (osUserIdInput || '').trim();
      if (cleanInput.startsWith('#')) cleanInput = cleanInput.slice(1).trim();

      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanInput);
      const isEmail = cleanInput.includes('@');
      const isDigitsOnly = /^\d+$/.test(cleanInput);

      let normalizedElevatesId = cleanInput;
      if (/^elv\d+$/i.test(cleanInput)) {
        normalizedElevatesId = 'ELV-' + cleanInput.slice(3);
      } else if (isDigitsOnly) {
        normalizedElevatesId = 'ELV-' + cleanInput.padStart(4, '0');
      }

      let foundProfile = null;

      if (isUuid) {
        const { data } = await supabase.from('profiles').select('*').eq('id', cleanInput).maybeSingle();
        foundProfile = data;
      } else if (isEmail) {
        const { data } = await supabase.from('profiles').select('*').ilike('email', cleanInput).maybeSingle();
        foundProfile = data;
      } else {
        let { data } = await supabase.from('profiles').select('*').ilike('elevates_id', normalizedElevatesId).maybeSingle();
        if (!data && normalizedElevatesId !== cleanInput) {
          const fallback = await supabase.from('profiles').select('*').ilike('elevates_id', cleanInput).maybeSingle();
          data = fallback.data;
        }
        foundProfile = data;
      }

      if (!foundProfile) {
        return { ok: false, reason: 'not_found', input: cleanInput };
      }

      // Look up chapter details if user has a chapter assigned
      let chapterName = 'Elevates Chapter';
      if (foundProfile.chapter_id) {
        const chapter = await this.getChapterByIdentifier(foundProfile.chapter_id);
        if (chapter?.name) chapterName = chapter.name;
      }

      // Generate secure 6-digit OTP (100000 - 999999)
      const otpCode = crypto.randomInt(100000, 1000000).toString();
      // 4-hour expiry as specified in prompt
      const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();

      // Expire any existing pending OTPs for this user
      await supabase
        .from('discord_verification_codes')
        .update({ status: 'expired' })
        .eq('os_user_id', foundProfile.id)
        .eq('status', 'pending');

      // Insert new OTP record
      const { error: otpErr } = await supabase
        .from('discord_verification_codes')
        .insert({
          os_user_id: foundProfile.id,
          discord_user_id: discordUserId,
          discord_username: discordUsername,
          guild_id: guildId || 'global',
          otp_code: otpCode,
          status: 'pending',
          expires_at: expiresAt,
        });

      if (otpErr) {
        throw formatError(otpErr, 'Failed to store verification code');
      }

      // Log OTP generation event
      if (guildId) {
        try {
          await supabase
            .from('discord_events_log')
            .insert({
              guild_id: guildId,
              discord_user_id: discordUserId,
              event_type: 'otp_generated',
              detail: { os_user_id: foundProfile.id, expires_at: expiresAt },
            });
        } catch (_) {}
      }

      return {
        ok: true,
        otpCode,
        expiresAt,
        userName: foundProfile.full_name || 'Member',
        elevatesId: foundProfile.elevates_id || cleanInput,
        chapterName,
        chapterId: foundProfile.chapter_id,
        userId: foundProfile.id,
        designation: foundProfile.designation || foundProfile.role || null,
      };
    } catch (err) {
      throw formatError(err, 'Verification OTP generation failed');
    }
  },

  /**
   * Looks up a single identity by Discord User ID.
   * Returns profile, user_roles, chapter_id, and connection status.
   */
  async getIdentityByDiscordId(discordUserId) {
    if (!discordUserId) return null;
    try {
      // 1. Primary lookup in profiles table
      const { data: profile, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('discord_user_id', discordUserId)
        .eq('discord_connected', true)
        .maybeSingle();

      if (error) console.error('[getIdentityByDiscordId] profiles lookup error:', error.message);

      if (profile) {
        // Fetch active user roles with role definitions
        const { data: userRoles } = await supabase
          .from('user_roles')
          .select('*, roles(name, key)')
          .eq('user_id', profile.id);

        return {
          profile,
          userRoles: userRoles || [],
          userId: profile.id,
          os_user_id: profile.id,
          chapterId: profile.chapter_id,
          chapter_id: profile.chapter_id,
          name: profile.full_name || 'Member',
          elevatesId: profile.elevates_id,
          discord_user_id: profile.discord_user_id,
          discord_connected: profile.discord_connected,
        };
      }

      // 2. Secondary fallback check in discord_links
      const { data: link } = await supabase
        .from('discord_links')
        .select('*')
        .eq('discord_user_id', discordUserId)
        .eq('status', 'linked')
        .order('linked_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (link && link.os_user_id) {
        const { data: linkedProfile } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', link.os_user_id)
          .maybeSingle();

        if (linkedProfile) {
          const { data: userRoles } = await supabase
            .from('user_roles')
            .select('*, roles(name, key)')
            .eq('user_id', linkedProfile.id);

          return {
            profile: linkedProfile,
            userRoles: userRoles || [],
            userId: linkedProfile.id,
            os_user_id: linkedProfile.id,
            chapterId: linkedProfile.chapter_id,
            chapter_id: linkedProfile.chapter_id,
            name: linkedProfile.full_name || 'Member',
            elevatesId: linkedProfile.elevates_id,
            discord_user_id: discordUserId,
            discord_connected: true,
          };
        }
      }

      return null;
    } catch (err) {
      console.error('[getIdentityByDiscordId] Error:', err);
      return null;
    }
  },

  /**
   * Looks up a single identity by OS User ID (UUID).
   */
  async getIdentityByOsUserId(osUserId) {
    if (!osUserId) return null;
    try {
      const { data: profile } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', osUserId)
        .maybeSingle();

      if (!profile) return null;

      const { data: userRoles } = await supabase
        .from('user_roles')
        .select('*, roles(name, key)')
        .eq('user_id', profile.id);

      return {
        profile,
        userRoles: userRoles || [],
        userId: profile.id,
        chapterId: profile.chapter_id,
        name: profile.full_name || 'Member',
        elevatesId: profile.elevates_id,
        discord_user_id: profile.discord_user_id,
        discord_connected: Boolean(profile.discord_connected),
      };
    } catch (err) {
      console.error('[getIdentityByOsUserId] Error:', err);
      return null;
    }
  },

  /**
   * Fetches all official roles defined in the roles table.
   */
  async getAllOsRoles() {
    try {
      const { data, error } = await supabase.from('roles').select('*');
      if (error) {
        console.error('[getAllOsRoles] Error fetching roles:', error.message);
        return [];
      }
      return data || [];
    } catch (err) {
      console.error('[getAllOsRoles] Failed:', err);
      return [];
    }
  },

  /**
   * Resolves a chapter by either:
   * 1. Supabase UUID (id)
   * 2. Elevates ID (e.g. 'CHP-0033', 'chp-0033', '33')
   * 3. Slug or name
   *
   * @param {string|object} identifier UUID, Elevates ID, slug, or existing chapter object
   * @returns {Promise<object|null>} Chapter row or null
   */
  async getChapterByIdentifier(identifier) {
    if (!identifier) return null;
    if (typeof identifier === 'object' && identifier.id) return identifier;

    let clean = String(identifier).trim();
    if (clean.startsWith('#')) clean = clean.slice(1).trim();

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clean);

    // 1. If UUID, query id directly
    if (isUuid) {
      try {
        const { data, error } = await supabase
          .from('chapters')
          .select('*')
          .eq('id', clean)
          .maybeSingle();
        if (data) return data;
      } catch (_) {}
    }

    // 2. Elevates ID normalization (e.g. CHP-0033, chp-0033, chp33, 33)
    let normalizedElevatesId = clean.toUpperCase();
    const chpMatch = clean.match(/^chp-?(\d+)$/i);
    if (chpMatch) {
      normalizedElevatesId = 'CHP-' + chpMatch[1].padStart(4, '0');
    } else if (/^\d+$/.test(clean)) {
      normalizedElevatesId = 'CHP-' + clean.padStart(4, '0');
    }

    try {
      // Try normalized elevates_id first
      const { data: normData } = await supabase
        .from('chapters')
        .select('*')
        .ilike('elevates_id', normalizedElevatesId)
        .maybeSingle();
      if (normData) return normData;

      // Try raw input against elevates_id
      if (clean !== normalizedElevatesId) {
        const { data: rawData } = await supabase
          .from('chapters')
          .select('*')
          .ilike('elevates_id', clean)
          .maybeSingle();
        if (rawData) return rawData;
      }

      // 3. Fallback: match by slug
      const { data: slugData } = await supabase
        .from('chapters')
        .select('*')
        .ilike('slug', clean)
        .maybeSingle();
      if (slugData) return slugData;

      // 4. Fallback: match by name
      const { data: nameData } = await supabase
        .from('chapters')
        .select('*')
        .ilike('name', clean)
        .maybeSingle();
      if (nameData) return nameData;
    } catch (err) {
      console.error('[getChapterByIdentifier] Error resolving chapter:', err.message);
    }

    return null;
  },

  /**
   * Alias for getChapterByIdentifier
   */
  async getChapter(identifier) {
    return this.getChapterByIdentifier(identifier);
  },

  /**
   * Looks up which chapter a guild is mapped to.
   */
  async getGuildConfig(guildId) {
    if (!guildId) return null;

    // Check in-memory cache first (Section 5.2)
    const cached = guildConfigCache.get(guildId);
    if (cached && Date.now() - cached.cachedAt < GUILD_CONFIG_TTL_MS) {
      return cached.data;
    }

    try {
      const { data, error } = await supabase
        .from('guild_config')
        .select('*, chapters(id, name, slug, elevates_id)')
        .eq('guild_id', guildId)
        .maybeSingle();

      if (error || !data) {
        const { data: simpleData, error: simpleErr } = await supabase
          .from('guild_config')
          .select('*')
          .eq('guild_id', guildId)
          .maybeSingle();

        if (simpleErr || !simpleData) {
          if (guildId === config.mainGuildId) {
            const mainResult = {
              guildId,
              guild_id: guildId,
              guildType: 'main',
              guild_type: 'main',
              chapterId: null,
              chapter_id: null,
              chapterName: null,
              chapter_name: null,
              chapterElevatesId: null,
              elevates_id: null,
            };
            guildConfigCache.set(guildId, { data: mainResult, cachedAt: Date.now() });
            return mainResult;
          }
          return null;
        }

        let chapterName = null;
        let chapterElevatesId = null;
        if (simpleData.chapter_id) {
          const chapter = await this.getChapterByIdentifier(simpleData.chapter_id);
          if (chapter) {
            chapterName = chapter.name;
            chapterElevatesId = chapter.elevates_id || null;
          }
        }

        const simpleResult = {
          guildId: simpleData.guild_id,
          guild_id: simpleData.guild_id,
          guildType: simpleData.guild_type,
          guild_type: simpleData.guild_type,
          chapterId: simpleData.chapter_id,
          chapter_id: simpleData.chapter_id,
          chapterName,
          chapter_name: chapterName,
          chapterElevatesId,
          elevates_id: chapterElevatesId,
          campusLeadId: simpleData.campus_lead_id || null,
          campus_lead_id: simpleData.campus_lead_id || null,
          campusLeadDiscordId: simpleData.campus_lead_discord_id || null,
          campus_lead_discord_id: simpleData.campus_lead_discord_id || null,
          createdAt: simpleData.created_at,
        };
        guildConfigCache.set(guildId, { data: simpleResult, cachedAt: Date.now() });
        return simpleResult;
      }

      const chapterObj = Array.isArray(data.chapters) ? data.chapters[0] : data.chapters;
      const chapterName = chapterObj?.name || null;
      const chapterElevatesId = chapterObj?.elevates_id || null;

      const result = {
        guildId: data.guild_id,
        guild_id: data.guild_id,
        guildType: data.guild_type,
        guild_type: data.guild_type,
        chapterId: data.chapter_id,
        chapter_id: data.chapter_id,
        chapterName,
        chapter_name: chapterName,
        chapterElevatesId,
        elevates_id: chapterElevatesId,
        campusLeadId: data.campus_lead_id || null,
        campus_lead_id: data.campus_lead_id || null,
        campusLeadDiscordId: data.campus_lead_discord_id || null,
        campus_lead_discord_id: data.campus_lead_discord_id || null,
        createdAt: data.created_at,
      };
      guildConfigCache.set(guildId, { data: result, cachedAt: Date.now() });
      return result;
    } catch (err) {
      if (guildId === config.mainGuildId) {
        const fallbackMain = {
          guildId,
          guild_id: guildId,
          guildType: 'main',
          guild_type: 'main',
          chapterId: null,
          chapter_id: null,
          chapterName: null,
          chapter_name: null,
          chapterElevatesId: null,
          elevates_id: null,
        };
        guildConfigCache.set(guildId, { data: fallbackMain, cachedAt: Date.now() });
        return fallbackMain;
      }
      return null;
    }
  },

  /**
   * Sets or updates guild configuration.
   */
  async setGuildConfig(guildId, chapterId, guildType, campusLeadId = null, campusLeadDiscordId = null) {
    try {
      let resolvedChapterId = chapterId;
      let chapterObj = null;
      if (chapterId) {
        chapterObj = await this.getChapterByIdentifier(chapterId);
        if (chapterObj) {
          resolvedChapterId = chapterObj.id;
        }
      }

      const payload = {
        guild_id: guildId,
        chapter_id: resolvedChapterId,
        guild_type: guildType,
      };
      if (campusLeadId) payload.campus_lead_id = campusLeadId;
      if (campusLeadDiscordId) payload.campus_lead_discord_id = campusLeadDiscordId;

      const { data, error } = await supabase
        .from('guild_config')
        .upsert(payload, { onConflict: 'guild_id' })
        .select()
        .single();

      if (error) throw formatError(error, 'Failed to set guild configuration');

      guildConfigCache.delete(guildId);

      let chapterName = chapterObj?.name || null;
      let chapterElevatesId = chapterObj?.elevates_id || null;
      if (!chapterObj && resolvedChapterId) {
        const chap = await this.getChapterByIdentifier(resolvedChapterId);
        if (chap) {
          chapterName = chap.name;
          chapterElevatesId = chap.elevates_id || null;
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
        chapterElevatesId,
        elevates_id: chapterElevatesId,
      };
    } catch (err) {
      throw formatError(err, 'Failed to configure server');
    }
  },

  /**
   * Looks up the main guild configuration.
   */
  async getMainGuildConfig() {
    try {
      const { data, error } = await supabase
        .from('guild_config')
        .select('*')
        .eq('guild_type', 'main')
        .limit(1)
        .maybeSingle();

      if (error || !data) {
        if (config.mainGuildId) {
          return {
            guildId: config.mainGuildId,
            guild_id: config.mainGuildId,
            guildType: 'main',
            chapterId: null,
          };
        }
        return null;
      }
      return {
        guildId: data.guild_id,
        guild_id: data.guild_id,
        guildType: data.guild_type,
        chapterId: data.chapter_id,
      };
    } catch (_) {
      if (config.mainGuildId) {
        return {
          guildId: config.mainGuildId,
          guild_id: config.mainGuildId,
          guildType: 'main',
          chapterId: null,
        };
      }
      return null;
    }
  },

  /**
   * Creates a one-time chapter setup token tied to chapter_id and campus_lead's discord_user_id.
   * Valid for 1 hour.
   */
  async createChapterSetupToken(chapterId, campusLeadDiscordId, campusLeadId = null) {
    let resolvedChapterId = chapterId;
    if (chapterId) {
      const chapter = await this.getChapterByIdentifier(chapterId);
      if (chapter) {
        resolvedChapterId = chapter.id;
      }
    }

    const token = 'chp_' + crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const tokenData = {
      chapter_id: resolvedChapterId,
      campus_lead_id: campusLeadId,
      campus_lead_discord_id: campusLeadDiscordId,
      token,
      expires_at: expiresAt,
      used_at: null,
      created_at: new Date().toISOString(),
    };

    // Store in memory cache
    inMemorySetupTokens.set(token, tokenData);

    // Try storing in chapter_setup_tokens table
    try {
      const { error } = await supabase.from('chapter_setup_tokens').insert(tokenData);
      if (error) {
        // Fallback to storing in discord_events_log if table does not exist
        try {
          await supabase.from('discord_events_log').insert({
            guild_id: 'global',
            discord_user_id: campusLeadDiscordId,
            event_type: 'chapter_setup_token',
            detail: tokenData,
          });
        } catch (_) {}
      }
    } catch (_) {
      // Ignore, in-memory cache and event log provide resilience
    }

    return { token, expiresAt };
  },

  /**
   * Validates and consumes a setup token.
   */
  async validateAndConsumeSetupToken(token, callerDiscordId) {
    const cleanToken = (token || '').trim();
    const now = new Date();

    // 1. Check in-memory store
    let tokenData = inMemorySetupTokens.get(cleanToken);

    // 2. Check DB if not found or on fresh restart
    if (!tokenData) {
      try {
        const { data } = await supabase
          .from('chapter_setup_tokens')
          .select('*')
          .eq('token', cleanToken)
          .maybeSingle();
        if (data) tokenData = data;
      } catch (_) {}
    }

    // 3. Fallback: check discord_events_log
    if (!tokenData) {
      try {
        const { data: logs } = await supabase
          .from('discord_events_log')
          .select('detail')
          .eq('event_type', 'chapter_setup_token')
          .order('created_at', { ascending: false })
          .limit(20);

        if (logs) {
          for (const l of logs) {
            if (l.detail?.token === cleanToken) {
              tokenData = l.detail;
              break;
            }
          }
        }
      } catch (_) {}
    }

    if (!tokenData) {
      return { ok: false, reason: 'invalid_token', message: 'Invalid or expired setup token. Please run /chapter again in the main server.' };
    }

    if (tokenData.used_at) {
      return { ok: false, reason: 'already_used', message: 'Invalid or expired setup token. Please run /chapter again in the main server.' };
    }

    if (new Date(tokenData.expires_at) < now) {
      // Mark as used to prevent replaying expired tokens
      tokenData.used_at = now.toISOString();
      inMemorySetupTokens.set(cleanToken, tokenData);
      try {
        await supabase
          .from('chapter_setup_tokens')
          .update({ used_at: tokenData.used_at })
          .eq('token', cleanToken);
      } catch (_) {}
      return { ok: false, reason: 'expired', message: 'Invalid or expired setup token. Please run /chapter again in the main server.' };
    }

    // Mark as used immediately to prevent replay attacks
    tokenData.used_at = now.toISOString();
    inMemorySetupTokens.set(cleanToken, tokenData);

    try {
      await supabase
        .from('chapter_setup_tokens')
        .update({ used_at: tokenData.used_at })
        .eq('token', cleanToken);
    } catch (_) {}

    try {
      await supabase.from('discord_events_log').insert({
        guild_id: 'global',
        discord_user_id: callerDiscordId || tokenData.campus_lead_discord_id,
        event_type: 'chapter_setup_token_used',
        detail: { token: cleanToken, chapter_id: tokenData.chapter_id },
      });
    } catch (_) {}

    return { ok: true, tokenData };
  },

  /**
   * Activates a chapter server upon bot join via OAuth2 callback.
   *
   * @param {import('discord.js').Client} client Discord client instance
   * @param {string} guildId Target Guild ID
   * @param {string} token Setup token passed via OAuth2 state parameter
   * @returns {Promise<{ ok: boolean, message?: string, chapterName?: string, guild?: any }>}
   */
  async activateChapter(client, guildId, token) {
    if (!client || !guildId || !token) {
      return {
        ok: false,
        message: 'Invalid or expired setup token. Please run /chapter again in the main server.',
      };
    }

    // 1. Validate and consume token
    const tokenResult = await this.validateAndConsumeSetupToken(token);
    if (!tokenResult || !tokenResult.ok) {
      return {
        ok: false,
        message: tokenResult?.message || 'Invalid or expired setup token. Please run /chapter again in the main server.',
      };
    }

    const { tokenData } = tokenResult;
    const chapterId = tokenData.chapter_id;
    const leadDiscordId = tokenData.campus_lead_discord_id;

    // 2. Fetch guild with retry mechanism to handle gateway/HTTP race conditions
    let guild = client.guilds.cache.get(guildId);
    if (!guild) {
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          guild = await client.guilds.fetch(guildId);
          if (guild) break;
        } catch (_) {
          if (attempt < 5) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
      }
    }

    if (!guild) {
      return {
        ok: false,
        message: `Unable to access Discord server (${guildId}). Please ensure the bot was successfully added to your server.`,
      };
    }

    // 3. Verify server is not the Main Server
    let existingConfig = null;
    try {
      existingConfig = await this.getGuildConfig(guild.id);
    } catch (_) {}

    if (existingConfig && existingConfig.guildType === 'main') {
      return {
        ok: false,
        message: 'This server is configured as the Main Server and cannot be converted into a chapter server.',
      };
    }

    // 4. Resolve Campus Lead member
    let campusLeadMember = null;
    if (leadDiscordId) {
      try {
        campusLeadMember = guild.members.cache.get(leadDiscordId) ||
          (await guild.members.fetch(leadDiscordId).catch(() => null));
      } catch (_) {}
    }

    // 5. Run provisioning logic
    let provisioningResult;
    try {
      provisioningResult = await this.provisionChapterGuild(
        client,
        guild,
        chapterId,
        campusLeadMember
      );
    } catch (err) {
      console.error('[activateChapter] Error during chapter provisioning:', err);
      return {
        ok: false,
        message: `An error occurred during chapter provisioning: ${err.message}`,
      };
    }

    // 6. Explicitly ensure Campus Lead role is assigned to the lead member
    if (campusLeadMember && provisioningResult?.campusLeadRole) {
      if (!campusLeadMember.roles.cache.has(provisioningResult.campusLeadRole.id)) {
        await campusLeadMember.roles.add(provisioningResult.campusLeadRole).catch((roleErr) =>
          console.warn('[activateChapter] Could not add Campus Lead role to caller:', roleErr.message)
        );
      }
    }

    // 7. Trigger initial cluster synchronization for this chapter
    const { syncChapterClusters } = require('./clusterSync');
    syncChapterClusters(client, chapterId).catch((err) =>
      console.error('[activateChapter] Cluster sync error:', err.message)
    );

    // 8. Post welcome embed in chapter server
    try {
      const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
      const welcomeChannel =
        guild.systemChannel ||
        guild.channels.cache.find(
          (c) =>
            c.type === ChannelType.GuildText &&
            c.name !== 'link-server' &&
            c.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)
        );

      if (welcomeChannel) {
        const linkChannel = guild.channels.cache.find((c) => c.name === 'link-server');
        const welcomeEmbed = new EmbedBuilder()
          .setColor(0x22C55E)
          .setTitle(`🎉 ${provisioningResult.chapterName} Discord Server Activated!`)
          .setDescription(
            `This server is now officially linked to the **${provisioningResult.chapterName}** chapter on ElevatesOS!\n\n` +
            `• **Elevates Chapter ID:** \`${provisioningResult.elevatesId || chapterId}\`\n` +
            `• **Campus Lead:** ${campusLeadMember ? `<@${campusLeadMember.id}>` : 'Configured'}\n` +
            `• **Campus Lead Role:** Configured with **Administrator** access\n` +
            `• **Chapter Roles:** Provisioned from ElevatesOS\n` +
            `• **Account Linking:** Head over to ${linkChannel ? `<#${linkChannel.id}>` : '`#link-server`'} to connect your account.\n\n` +
            `Private cluster categories and channels will synchronize automatically.`
          )
          .setFooter({ text: 'ElevatesOS Chapter Provisioning Engine' })
          .setTimestamp();

        await welcomeChannel.send({ embeds: [welcomeEmbed] }).catch(() => {});
      }
    } catch (welcomeErr) {
      console.warn('[activateChapter] Could not post welcome embed:', welcomeErr.message);
    }

    // 9. Log activation event in main server forum
    this.logChapterEvent(client, chapterId, guild.id, 'chapter_activated', {
      activatedBy: campusLeadMember ? campusLeadMember.user.tag : (leadDiscordId || 'OAuth2 Join'),
      guildName: guild.name,
      guildId: guild.id,
    }, 'channel_role_changes').catch(() => {});

    return {
      ok: true,
      chapterName: provisioningResult.chapterName,
      guild,
    };
  },

  /**
   * Provisions a new chapter guild.
   */
  async provisionChapterGuild(client, guild, chapterIdOrIdentifier, campusLeadMember) {
    // Safety guard: The Main Server must NEVER be provisioned or have roles auto-created
    const currentConfig = await this.getGuildConfig(guild.id);
    if (currentConfig?.guildType === 'main' || guild.id === config.mainGuildId) {
      throw new Error('This server is configured as the Main Server and cannot be provisioned as a chapter server.');
    }

    // 1. Fetch chapter info - supports UUID, elevates_id (e.g. CHP-0033), or existing chapter object
    const chapter = typeof chapterIdOrIdentifier === 'object' && chapterIdOrIdentifier !== null && chapterIdOrIdentifier.id
      ? chapterIdOrIdentifier
      : await this.getChapterByIdentifier(chapterIdOrIdentifier);

    if (!chapter) {
      throw new Error(`Failed to fetch chapter info for "${chapterIdOrIdentifier}" during provisioning`);
    }

    const chapterId = chapter.id;
    const chapterElevatesId = chapter.elevates_id || chapter.id;
    const chapterName = chapter.name || 'Chapter';
    const chapterSlug = (chapter.slug || chapterName).toLowerCase().replace(/[^a-z0-9]+/g, '-');

    // 2. Set guild_config with Campus Lead identity
    let campusLeadProfileId = null;
    if (campusLeadMember) {
      const leadIdentity = await this.getIdentityByDiscordId(campusLeadMember.id);
      campusLeadProfileId = leadIdentity?.profile?.id || null;
    }
    await this.setGuildConfig(guild.id, chapterId, 'chapter', campusLeadProfileId, campusLeadMember?.id);

    // If campus lead profile is identified and chapter.campus_lead_id is unassigned, link them in chapters table
    if (campusLeadProfileId && !chapter.campus_lead_id) {
      try {
        await supabase
          .from('chapters')
          .update({ campus_lead_id: campusLeadProfileId })
          .eq('id', chapterId)
          .is('campus_lead_id', null);
      } catch (_) {}
    }

    // 3. Fetch all OS roles from roles table and create in guild
    const osRoles = await this.getAllOsRoles();
    const createdRoles = new Map(); // key -> role

    // Helper to find or create role
    async function getOrCreateRole(name, color = null, permissions = null) {
      let r = guild.roles.cache.find(
        (role) => role.name.toLowerCase().trim() === name.toLowerCase().trim()
      );
      if (!r) {
        r = await guild.roles.create({
          name,
          color: color || undefined,
          permissions: permissions || undefined,
          reason: 'ElevatesOS Chapter Role Setup',
        });
      }
      return r;
    }

    // Base membership roles
    const verifiedRole = await getOrCreateRole(config.roles.verified || 'ELEVATES • Member', 0x22C55E);
    const unverifiedRole = await getOrCreateRole(config.roles.unverified || 'elevates', 0x94A3B8);
    const guestRole = await getOrCreateRole(config.roles.guest || 'Guest', 0x64748B);

    // Create a Discord role for every OS role
    for (const osRole of osRoles) {
      const roleName = osRole.name || osRole.key;
      const r = await getOrCreateRole(roleName);
      createdRoles.set(osRole.key, r);
    }

    // Ensure Campus Lead role exists
    const campusLeadRoleName = config.roles.campusLead || 'Campus Lead';
    let campusLeadRole = guild.roles.cache.find(
      (r) => r.name.toLowerCase() === campusLeadRoleName.toLowerCase()
    );
    if (!campusLeadRole) {
      campusLeadRole = await guild.roles.create({
        name: campusLeadRoleName,
        color: 0xF59E0B,
        reason: 'ElevatesOS Campus Lead Role Setup',
      });
    }

    // Ensure Executive Member role exists
    const execMemberRoleName = config.roles.executiveMember || 'Executive Member';
    let execMemberRole = guild.roles.cache.find(
      (r) => !r.managed && [execMemberRoleName.toLowerCase(), 'executive team', 'executive'].includes(r.name.toLowerCase().trim())
    );
    if (!execMemberRole) {
      execMemberRole = await guild.roles.create({
        name: execMemberRoleName,
        color: 0x3B82F6,
        reason: 'ElevatesOS Executive Member Role Setup',
      });
    }

    // Requirement: Give Campus Lead's Discord role Administrator permission WITHIN THIS chapter server only
    try {
      if (!campusLeadRole.permissions.has(PermissionFlagsBits.Administrator)) {
        await campusLeadRole.setPermissions(
          campusLeadRole.permissions.add(PermissionFlagsBits.Administrator),
          'Campus Lead Administrator access for this chapter server'
        );
      }
    } catch (permErr) {
      console.warn('[provisionChapterGuild] Could not grant Administrator permission to Campus Lead role:', permErr.message);
    }

    // Assign Campus Lead their role immediately
    if (campusLeadMember) {
      try {
        if (!campusLeadMember.roles.cache.has(campusLeadRole.id)) {
          await campusLeadMember.roles.add(campusLeadRole);
        }
        if (!campusLeadMember.roles.cache.has(verifiedRole.id)) {
          await campusLeadMember.roles.add(verifiedRole);
        }
        if (campusLeadMember.roles.cache.has(unverifiedRole.id)) {
          await campusLeadMember.roles.remove(unverifiedRole);
        }
        // Set nickname to OS full name if available
        const identity = await this.getIdentityByDiscordId(campusLeadMember.id);
        if (identity?.name) {
          await campusLeadMember.setNickname(identity.name).catch(() => {});
        }
      } catch (err) {
        console.warn('[provisionChapterGuild] Could not fully assign roles to Campus Lead:', err.message);
      }
    }

    // 4. In the MAIN server, ensure Chapter Management category & dedicated forum log channel
    let chapterManagementLogChannel = null;
    try {
      const forumData = await this.ensureChapterLogForum(client, chapterId);
      chapterManagementLogChannel = forumData?.forumChannel || null;

      // Post chapter activated log message in "Channel & Role Changes" starter thread
      const chgThread = forumData?.threadMap?.['channel_role_changes'] || chapterManagementLogChannel;
      if (chgThread) {
        const activationEmbed = new EmbedBuilder()
          .setColor(0x22C55E)
          .setTitle(`🏛️ Chapter Activated: ${chapterName}`)
          .setDescription(
            `A new chapter Discord server has been successfully provisioned and linked to ElevatesOS!\n\n` +
            `• **Chapter Name:** ${chapterName}\n` +
            `• **Elevates ID:** \`${chapterElevatesId}\`\n` +
            `• **Chapter ID:** \`${chapterId}\`\n` +
            `• **Guild ID:** \`${guild.id}\`\n` +
            `• **Campus Lead:** ${campusLeadMember ? `<@${campusLeadMember.id}>` : 'None'}\n` +
            `• **Activated At:** <t:${Math.floor(Date.now() / 1000)}:F>`
          )
          .setFooter({ text: 'ElevatesOS Chapter Oversight' })
          .setTimestamp();

        await chgThread.send({ embeds: [activationEmbed] }).catch(() => {});
      }
    } catch (mainErr) {
      console.error('[provisionChapterGuild] Error setting up main server log forum:', mainErr);
    }

    // 5. Post public account link message in chapter server
    const { ensureLinkChannel } = require('./accountLinking');
    await ensureLinkChannel(guild).catch((err) =>
      console.warn('[provisionChapterGuild] ensureLinkChannel error:', err.message)
    );

    // 6. Ensure private leadership/insider section with Executive Member tier under Campus Lead tier
    let leadershipSection = null;
    try {
      leadershipSection = await this.ensureChapterLeadershipSection(guild, chapterId);
    } catch (leadErr) {
      console.warn('[provisionChapterGuild] ensureChapterLeadershipSection error:', leadErr.message);
    }

    return {
      chapterName,
      chapterSlug,
      chapterId,
      elevatesId: chapterElevatesId,
      guildId: guild.id,
      campusLeadRole,
      execMemberRole,
      leadershipSection,
      logChannel: chapterManagementLogChannel,
    };
  },

  /**
   * Ensures the Chapter Management Category, the chapter's dedicated FORUM log channel,
   * and the 4 starter threads exist in the Main Server.
   *
   * Starter threads:
   * - "🛡️ Moderation" — kicks, bans, mutes, warns, unlinks
   * - "🧠 Cluster Activity" — cluster created, member added/removed, host assigned/removed
   * - "⚙️ Channel & Role Changes" — any role or channel created/modified for this chapter
   * - "👤 Membership" — member joined/left the chapter server, account linked/unlinked
   */
  async ensureChapterLogForum(client, chapterId) {
    if (!client || !chapterId) return null;

    try {
      const chapter = await this.getChapterByIdentifier(chapterId);
      if (!chapter) return null;

      const resolvedChapterId = chapter.id;
      const chapterName = chapter.name || 'Chapter';
      const chapterSlug = (chapter.slug || chapterName).toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const channelName = `chp-${chapterSlug}`.slice(0, 100);

      // 0. Fast Path: Check in-memory cache
      const cached = chapterForumCache.get(resolvedChapterId);
      if (cached && (Date.now() - cached.timestamp < 15 * 60 * 1000)) {
        const forumChannel = client.channels.cache.get(cached.forumChannelId) ||
          await client.channels.fetch(cached.forumChannelId).catch(() => null);
        if (forumChannel) {
          const threadMap = {};
          let allFound = true;
          for (const [key, thId] of Object.entries(cached.threadIds)) {
            if (!thId) { allFound = false; continue; }
            const th = client.channels.cache.get(thId) || await client.channels.fetch(thId).catch(() => null);
            if (th) threadMap[key] = th;
            else allFound = false;
          }
          if (allFound && Object.keys(threadMap).length >= STARTER_THREADS.length) {
            return { forumChannel, threadMap, chapterName };
          }
        }
      }

      // 0.1 Fast Path: Check chapter_log_channels database record & resolve threads directly from forum
      try {
        const { data: dbLogRecord } = await supabase
          .from('chapter_log_channels')
          .select('channel_id')
          .eq('chapter_id', resolvedChapterId)
          .maybeSingle();

        if (dbLogRecord?.channel_id) {
          const forumChannel = client.channels.cache.get(dbLogRecord.channel_id) ||
            await client.channels.fetch(dbLogRecord.channel_id).catch(() => null);
          if (forumChannel && forumChannel.type === ChannelType.GuildForum) {
            const fetchedActive = await forumChannel.threads.fetchActive().catch(() => ({ threads: new Map() }));
            const fetchedArchived = await forumChannel.threads.fetchArchived().catch(() => ({ threads: new Map() }));
            const allThreads = new Map([...(fetchedActive.threads || new Map()), ...(fetchedArchived.threads || new Map())]);

            const threadMap = {};
            for (const tSpec of STARTER_THREADS) {
              const thread = Array.from(allThreads.values()).find((th) => {
                const norm = th.name.toLowerCase().trim();
                const raw = norm.replace(/[^a-z0-9]/g, '');
                const specNorm = tSpec.name.toLowerCase().trim();
                const specRaw = specNorm.replace(/[^a-z0-9]/g, '');
                if (norm === specNorm || raw === specRaw) return true;

                if (tSpec.key === 'role_changes') {
                  return (norm.includes('role changes') || norm.includes('roles changes')) && !norm.includes('channel');
                }
                if (tSpec.key === 'channel_role_changes') {
                  return norm.includes('channel & role') || norm.includes('server & channel') || (norm.includes('channel') && norm.includes('role'));
                }
                if (tSpec.key === 'discord_activity') {
                  return (norm.includes('discord') || norm.includes('chat') || norm.includes('messages')) && !norm.includes('cluster');
                }
                if (tSpec.key === 'current_roles') {
                  return norm.includes('current roles') || norm.includes('roster');
                }
                if (tSpec.key === 'events') {
                  return norm.includes('events') || norm.includes('meetups');
                }
                if (tSpec.key === 'term_handover') {
                  return norm.includes('term handover') || norm.includes('handover') || norm.includes('term_handover');
                }
                return tSpec.matchTerms.some((term) => norm.includes(term));
              });

              if (thread) {
                if (thread.archived) await thread.setArchived(false).catch(() => {});
                if (thread.joinable) await thread.join().catch(() => {});
                threadMap[tSpec.key] = thread;
              }
            }

            if (Object.keys(threadMap).length >= STARTER_THREADS.length) {
              chapterForumCache.set(resolvedChapterId, {
                forumChannelId: forumChannel.id,
                threadIds: Object.fromEntries(Object.entries(threadMap).map(([k, t]) => [k, t.id])),
                timestamp: Date.now(),
              });
              return { forumChannel, threadMap, chapterName };
            }
          }
        }
      } catch (_) {}

      // 1. Locate Main Server
      let mainGuild = null;
      const mainConfig = await this.getMainGuildConfig();
      if (mainConfig?.guildId) {
        mainGuild = client.guilds.cache.get(mainConfig.guildId) ||
          (await client.guilds.fetch(mainConfig.guildId).catch(() => null));
      }
      if (!mainGuild && config.mainGuildId) {
        mainGuild = client.guilds.cache.get(config.mainGuildId) ||
          (await client.guilds.fetch(config.mainGuildId).catch(() => null));
      }
      if (!mainGuild) {
        mainGuild = client.guilds.cache.find((g) => g.id !== mainConfig?.guildId) || client.guilds.cache.first();
      }
      if (!mainGuild) return null;

      // Ensure channel and role caches are fresh in Main Server
      await mainGuild.channels.fetch().catch(() => {});
      await mainGuild.roles.fetch().catch(() => {});

      // 2. Find or create private "CHAPTER LOGS 🔒" category
      let category = mainGuild.channels.cache.find(
        (c) =>
          c.type === ChannelType.GuildCategory &&
          (c.name.toLowerCase().includes('chapter log') ||
            c.name.toLowerCase().includes('chapter-log') ||
            c.name.toLowerCase() === 'chapter logs')
      );

      // Setup Founders & HQ Admin private permissions
      const founderRole = mainGuild.roles.cache.find(
        (r) =>
          r.name.toLowerCase().includes('founder') ||
          r.name.toLowerCase() === (config.roles.founder || '').toLowerCase()
      );

      const adminRole = mainGuild.roles.cache.find(
        (r) =>
          r.name === 'HQ Admin' ||
          r.name.toLowerCase().includes('admin') ||
          r.name.toLowerCase() === (config.roles.admin || '').toLowerCase()
      );

      const permissionOverwrites = [
        {
          id: mainGuild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.ManageThreads,
            PermissionFlagsBits.CreatePublicThreads,
            PermissionFlagsBits.CreatePrivateThreads,
            PermissionFlagsBits.SendMessagesInThreads,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
      ];

      if (founderRole) {
        permissionOverwrites.push({
          id: founderRole.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.SendMessagesInThreads,
          ],
        });
      }

      if (adminRole && adminRole.id !== founderRole?.id) {
        permissionOverwrites.push({
          id: adminRole.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.SendMessagesInThreads,
          ],
        });
      }

      if (!category) {
        category = await mainGuild.channels.create({
          name: 'CHAPTER LOGS 🔒',
          type: ChannelType.GuildCategory,
          permissionOverwrites,
          reason: 'Dedicated private category for all chapter log forums',
        });
      } else {
        await category.permissionOverwrites.set(permissionOverwrites).catch(() => {});
      }

      // 3. Find or create Forum channel (NEVER delete an existing text channel!)
      let forumChannel = mainGuild.channels.cache.find(
        (c) => c.name === channelName && (c.parentId === category.id || !c.parentId)
      ) || mainGuild.channels.cache.find((c) => c.name === channelName);

      if (!forumChannel) {
        try {
          forumChannel = await mainGuild.channels.create({
            name: channelName,
            type: ChannelType.GuildForum,
            parent: category.id,
            topic: `ElevatesOS Official Audit Log for ${chapterName} Chapter (${resolvedChapterId})`,
            permissionOverwrites,
            reason: `Forum audit log channel for ${chapterName} Chapter`,
          });
        } catch (forumErr) {
          console.warn(`[ensureChapterLogForum] GuildForum creation failed, falling back to GuildText:`, forumErr.message);
          forumChannel = await mainGuild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: category.id,
            topic: `ElevatesOS Official Audit Log for ${chapterName} Chapter (${resolvedChapterId})`,
            permissionOverwrites,
            reason: `Fallback audit log channel for ${chapterName} Chapter`,
          }).catch(() => null);
        }
      } else if (forumChannel.parentId !== category.id) {
        await forumChannel.setParent(category.id, { lockPermissions: false }).catch(() => {});
      }

      if (!forumChannel) return null;

      // 4. Ensure the 7 function topics/threads exist
      const threadMap = {};

      if (forumChannel.type === ChannelType.GuildForum) {
        const fetchedActive = await forumChannel.threads.fetchActive().catch(() => ({ threads: new Map() }));
        const fetchedArchived = await forumChannel.threads.fetchArchived().catch(() => ({ threads: new Map() }));
        const allThreads = new Map([...(fetchedActive.threads || new Map()), ...(fetchedArchived.threads || new Map())]);

        for (const tSpec of STARTER_THREADS) {
          let thread = Array.from(allThreads.values()).find((th) => {
            const norm = th.name.toLowerCase().trim();
            const raw = norm.replace(/[^a-z0-9]/g, '');
            const specNorm = tSpec.name.toLowerCase().trim();
            const specRaw = specNorm.replace(/[^a-z0-9]/g, '');
            if (norm === specNorm || raw === specRaw) return true;

            if (tSpec.key === 'role_changes') {
              return (norm.includes('role changes') || norm.includes('roles changes')) && !norm.includes('channel');
            }
            if (tSpec.key === 'channel_role_changes') {
              return norm.includes('channel & role') || norm.includes('server & channel') || (norm.includes('channel') && norm.includes('role'));
            }
            if (tSpec.key === 'discord_activity') {
              return (norm.includes('discord') || norm.includes('chat') || norm.includes('messages')) && !norm.includes('cluster');
            }
            if (tSpec.key === 'current_roles') {
              return norm.includes('current roles') || norm.includes('roster');
            }
            if (tSpec.key === 'events') {
              return norm.includes('events') || norm.includes('meetups');
            }
            if (tSpec.key === 'term_handover') {
              return norm.includes('term handover') || norm.includes('handover') || norm.includes('term_handover');
            }
            return tSpec.matchTerms.some((term) => norm.includes(term));
          });

          if (thread && thread.archived) {
            await thread.setArchived(false).catch(() => {});
          }
          if (thread && thread.joinable) {
            await thread.join().catch(() => {});
          }

          if (!thread) {
            try {
              thread = await forumChannel.threads.create({
                name: tSpec.name,
                message: {
                  content: `**${tSpec.name} Topic**\nOfficial log of all ${tSpec.description} for **${chapterName}**.\n\n_Auto-managed by ElevatesOS._`,
                },
                reason: `Starter audit thread for ${chapterName}`,
              });
              if (thread && thread.joinable) {
                await thread.join().catch(() => {});
              }
            } catch (thErr) {
              console.error(`[ensureChapterLogForum] Could not create thread ${tSpec.name}:`, thErr.message);
            }
          }

          if (thread) {
            threadMap[tSpec.key] = thread;
          }
        }
      } else if (forumChannel.type === ChannelType.GuildText) {
        const fetchedActive = await forumChannel.threads.fetchActive().catch(() => ({ threads: new Map() }));
        const activeThreads = fetchedActive.threads || new Map();

        for (const tSpec of STARTER_THREADS) {
          let thread = Array.from(activeThreads.values()).find((th) => {
            const norm = th.name.toLowerCase().trim();
            const raw = norm.replace(/[^a-z0-9]/g, '');
            const specNorm = tSpec.name.toLowerCase().trim();
            const specRaw = specNorm.replace(/[^a-z0-9]/g, '');
            if (norm === specNorm || raw === specRaw) return true;

            if (tSpec.key === 'role_changes') {
              return (norm.includes('role changes') || norm.includes('roles changes')) && !norm.includes('channel');
            }
            if (tSpec.key === 'channel_role_changes') {
              return norm.includes('channel & role') || norm.includes('server & channel') || (norm.includes('channel') && norm.includes('role'));
            }
            if (tSpec.key === 'discord_activity') {
              return (norm.includes('discord') || norm.includes('chat') || norm.includes('messages')) && !norm.includes('cluster');
            }
            if (tSpec.key === 'current_roles') {
              return norm.includes('current roles') || norm.includes('roster');
            }
            if (tSpec.key === 'events') {
              return norm.includes('events') || norm.includes('meetups');
            }
            if (tSpec.key === 'term_handover') {
              return norm.includes('term handover') || norm.includes('handover') || norm.includes('term_handover');
            }
            return tSpec.matchTerms.some((term) => norm.includes(term));
          });

          if (thread && thread.joinable) {
            await thread.join().catch(() => {});
          }

          if (!thread) {
            try {
              thread = await forumChannel.threads.create({
                name: tSpec.name,
                autoArchiveDuration: 10080,
                reason: `Starter audit thread for ${chapterName}`,
              });
              if (thread && thread.joinable) {
                await thread.join().catch(() => {});
              }
              await thread.send(`**${tSpec.name} Topic**\nOfficial log of all ${tSpec.description} for **${chapterName}**.\n\n_Auto-managed by ElevatesOS._`).catch(() => {});
            } catch (thErr) {
              console.error(`[ensureChapterLogForum] Could not create fallback thread ${tSpec.name}:`, thErr.message);
            }
          }

          if (thread) {
            threadMap[tSpec.key] = thread;
          }
        }
      }

      // Cache resolved forum channel & thread IDs in memory
      chapterForumCache.set(resolvedChapterId, {
        forumChannelId: forumChannel.id,
        threadIds: Object.fromEntries(Object.entries(threadMap).map(([k, t]) => [k, t.id])),
        timestamp: Date.now(),
      });

      // Initialize or refresh live roster in 👥 Current Roles topic
      if (threadMap['current_roles']) {
        this.updateChapterCurrentRolesTopic(client, resolvedChapterId, threadMap['current_roles']).catch(() => {});
      }

      // 5. Update references in chapter_log_channels table
      try {
        const payload = {
          chapter_id: resolvedChapterId,
          main_guild_id: mainGuild.id,
          channel_id: forumChannel.id,
          term_handover_thread_id: threadMap['term_handover']?.id || null,
          role_changes_thread_id: threadMap['role_changes']?.id || null,
          current_roles_thread_id: threadMap['current_roles']?.id || null,
          events_thread_id: threadMap['events']?.id || null,
          moderation_thread_id: threadMap['moderation']?.id || null,
          cluster_activity_thread_id: threadMap['cluster_activity']?.id || null,
          channel_role_changes_thread_id: threadMap['channel_role_changes']?.id || null,
          membership_thread_id: threadMap['membership']?.id || null,
        };

        await supabase
          .from('chapter_log_channels')
          .upsert(payload, { onConflict: 'chapter_id' });
      } catch (err) {
        console.warn('[ensureChapterLogForum] Could not update chapter_log_channels:', err.message);
      }

      return {
        forumChannel,
        threadMap,
        chapterName,
      };
    } catch (err) {
      console.error('[ensureChapterLogForum] Error:', err);
      return null;
    }
  },

  /**
   * Ensures the private leadership/insider channel section exists in each chapter server.
   * Under the existing Campus Lead tier, adds an "Executive Member" tier visible to
   * campus_lead + executive_member roles for that chapter.
   *
   * @param {import('discord.js').Guild} guild
   * @param {object|string} chapterIdOrIdentifier
   */
  async ensureChapterLeadershipSection(guild, chapterIdOrIdentifier) {
    if (!guild) return null;
    const currentConfig = await this.getGuildConfig(guild.id).catch(() => null);
    if (currentConfig?.guildType === 'main' || guild.id === config.mainGuildId) return null;

    try {
      await guild.channels.fetch().catch(() => {});
      await guild.roles.fetch().catch(() => {});

      // 1. Resolve Campus Lead and Executive Member roles in this chapter server
      const campusLeadRoleName = (config.roles?.campusLead || 'Campus Lead').toLowerCase().trim();
      const execMemberRoleName = (config.roles?.executiveMember || 'Executive Member').toLowerCase().trim();

      let campusLeadRole = guild.roles.cache.find(
        (r) => !r.managed && r.name.toLowerCase().trim() === campusLeadRoleName
      );
      if (!campusLeadRole && guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
        campusLeadRole = await guild.roles.create({
          name: config.roles?.campusLead || 'Campus Lead',
          color: 0xF59E0B,
          reason: 'ElevatesOS Campus Lead Role Setup',
        }).catch(() => null);
      }

      let execMemberRole = guild.roles.cache.find(
        (r) => !r.managed && [execMemberRoleName, 'executive team', 'executive'].includes(r.name.toLowerCase().trim())
      );
      if (!execMemberRole && guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
        execMemberRole = await guild.roles.create({
          name: config.roles?.executiveMember || 'Executive Member',
          color: 0x3B82F6,
          reason: 'ElevatesOS Executive Member Role Setup',
        }).catch(() => null);
      }

      // 2. Find or create private leadership category
      let category = guild.channels.cache.find(
        (c) =>
          c.type === ChannelType.GuildCategory &&
          (c.name.toLowerCase().includes('leadership') ||
            c.name.toLowerCase().includes('insider') ||
            c.name.toLowerCase() === 'leadership 🔒' ||
            c.name.toLowerCase() === 'leadership')
      );

      const categoryOverwrites = [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: guild.client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.ManageRoles,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
      ];

      if (campusLeadRole) {
        categoryOverwrites.push({
          id: campusLeadRole.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks,
          ],
        });
      }

      if (execMemberRole) {
        categoryOverwrites.push({
          id: execMemberRole.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks,
          ],
        });
      }

      if (!category && guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
        category = await guild.channels.create({
          name: 'LEADERSHIP 🔒',
          type: ChannelType.GuildCategory,
          permissionOverwrites: categoryOverwrites,
          reason: 'Private chapter leadership and insider section',
        }).catch(() => null);
      } else if (category && guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
        await category.permissionOverwrites.set(categoryOverwrites).catch(() => {});
      }

      const categoryId = category?.id;

      // 3. Ensure Campus Lead Lounge (visible ONLY to Campus Lead + bot)
      let campusLeadChannel = guild.channels.cache.find(
        (c) =>
          (c.name === 'campus-lead' || c.name === 'campus-lead-lounge') &&
          (!categoryId || c.parentId === categoryId)
      );

      const clChannelOverwrites = [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: guild.client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
      ];

      if (campusLeadRole) {
        clChannelOverwrites.push({
          id: campusLeadRole.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks,
          ],
        });
      }

      if (execMemberRole) {
        clChannelOverwrites.push({
          id: execMemberRole.id,
          deny: [PermissionFlagsBits.ViewChannel],
        });
      }

      if (!campusLeadChannel && guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
        campusLeadChannel = await guild.channels.create({
          name: 'campus-lead',
          type: ChannelType.GuildText,
          parent: categoryId,
          topic: 'Private leadership channel for the Campus Lead',
          permissionOverwrites: clChannelOverwrites,
          reason: 'Chapter Campus Lead private tier',
        }).catch(() => null);
      } else if (campusLeadChannel && guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
        await campusLeadChannel.permissionOverwrites.set(clChannelOverwrites).catch(() => {});
      }

      // 4. Ensure Executive Member Tier (under Campus Lead, visible to campus_lead + executive_member)
      let execMemberChannel = guild.channels.cache.find(
        (c) =>
          (c.name === 'executive-members' || c.name === 'executive-lounge') &&
          (!categoryId || c.parentId === categoryId)
      );

      const execChannelOverwrites = [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        {
          id: guild.client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
      ];

      if (campusLeadRole) {
        execChannelOverwrites.push({
          id: campusLeadRole.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks,
          ],
        });
      }

      if (execMemberRole) {
        execChannelOverwrites.push({
          id: execMemberRole.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks,
          ],
        });
      }

      if (!execMemberChannel && guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
        execMemberChannel = await guild.channels.create({
          name: 'executive-members',
          type: ChannelType.GuildText,
          parent: categoryId,
          topic: 'Private chapter leadership channel for Campus Lead and Executive Members',
          permissionOverwrites: execChannelOverwrites,
          reason: 'Chapter Executive Member tier under Campus Lead',
        }).catch(() => null);
      } else if (execMemberChannel && guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
        await execMemberChannel.permissionOverwrites.set(execChannelOverwrites).catch(() => {});
      }

      return {
        category,
        campusLeadChannel,
        execMemberChannel,
        execChannel: execMemberChannel,
      };
    } catch (err) {
      console.warn('[ensureChapterLeadershipSection] Warning:', err.message);
      return null;
    }
  },

  /**
   * Logs a term-handover event for a chapter into the Main Server forum's "🔄 Term Handover" thread.
   *
   * @param {import('discord.js').Client} client
   * @param {string} chapterId
   * @param {string} [guildId=null]
   * @param {object} [data={}]
   */
  async logTermHandoverEvent(client, chapterId, guildId = null, data = {}) {
    const detail = {
      term: data.term || data.term_name || data.termName || 'Chapter Term Transition',
      old_campus_lead: data.old_campus_lead || data.oldCampusLead || null,
      new_campus_lead: data.new_campus_lead || data.newCampusLead || null,
      demoted_executives: data.demoted_executives || data.demotedExecutives || null,
      assigned_executives: data.assigned_executives || data.assignedExecutives || null,
      timestamp: `<t:${Math.floor(Date.now() / 1000)}:F>`,
      ...data,
    };
    return this.logChapterEvent(client, chapterId, guildId, 'term_handover', detail, 'term_handover');
  },

  /**
   * Updates the live roster in the 👥 Current Roles topic for a chapter.
   * Keeps an official pinned embed updated with Campus Lead, Class Reps, Core Team, etc.
   */
  async updateChapterCurrentRolesTopic(client, chapterId, targetThread = null) {
    try {
      if (!client || !chapterId) return;

      // 1. Fetch chapter details
      const chapter = await this.getChapterByIdentifier(chapterId);
      if (!chapter) return;
      const resolvedChapterId = chapter.id;

      // 2. Fetch Campus Lead if designated
      let campusLeadProfile = null;
      if (chapter.campus_lead_id) {
        const { data: lead } = await supabase
          .from('profiles')
          .select('id, full_name, email, discord_user_id, discord_username, department, year, designation, role, elevates_id')
          .eq('id', chapter.campus_lead_id)
          .single();
        campusLeadProfile = lead;
      }

      // 3. Fetch user_roles for this chapter
      const { data: chapterRoles } = await supabase
        .from('user_roles')
        .select('id, user_id, role_key, role, valid_from, valid_to, created_at')
        .eq('chapter_id', resolvedChapterId);

      const roleUserIds = [...new Set((chapterRoles || []).map((r) => r.user_id).filter(Boolean))];

      // 4. Fetch all profiles associated with chapter and chapterRoles
      const profilesMap = new Map();
      const { data: chapterProfiles } = await supabase
        .from('profiles')
        .select('id, full_name, email, discord_user_id, discord_username, department, year, designation, role, elevates_id')
        .eq('chapter_id', resolvedChapterId);

      if (chapterProfiles) {
        for (const p of chapterProfiles) profilesMap.set(p.id, p);
      }

      const missingRoleUserIds = roleUserIds.filter((uid) => !profilesMap.has(uid));
      if (missingRoleUserIds.length > 0) {
        const { data: extraProfiles } = await supabase
          .from('profiles')
          .select('id, full_name, email, discord_user_id, discord_username, department, year, designation, role, elevates_id')
          .in('id', missingRoleUserIds);
        if (extraProfiles) {
          for (const p of extraProfiles) profilesMap.set(p.id, p);
        }
      }
      if (campusLeadProfile && !profilesMap.has(campusLeadProfile.id)) {
        profilesMap.set(campusLeadProfile.id, campusLeadProfile);
      }

      // 5. Build Grouped Roles Roster
      let leadDisplay = '*No Campus Lead currently assigned.*';
      if (campusLeadProfile) {
        const dId = campusLeadProfile.discord_user_id;
        const mention = dId ? `<@${dId}>` : '*(No Discord linked)*';
        const dept = campusLeadProfile.department ? ` • ${campusLeadProfile.department}` : '';
        const yr = campusLeadProfile.year ? ` Yr ${campusLeadProfile.year}` : '';
        const elId = campusLeadProfile.elevates_id ? ` • \`${campusLeadProfile.elevates_id}\`` : '';
        leadDisplay = `👑 **${campusLeadProfile.full_name || 'Unknown'}** ${elId}\n  └ ${mention}${dept}${yr}`;
      }

      const executiveMembers = [];
      const classReps = [];
      const coreTeam = [];
      const otherRoles = [];

      const formatUser = (p, roleTitle = null) => {
        const name = p?.full_name || 'Member';
        const mention = p?.discord_user_id ? `<@${p.discord_user_id}>` : '*(No Discord)*';
        const dept = p?.department ? ` • ${p.department}` : '';
        const yr = p?.year ? ` • Yr ${p.year}` : '';
        const elId = p?.elevates_id ? ` • \`${p.elevates_id}\`` : '';
        if (roleTitle) {
          return `• **${roleTitle}**: ${name} (${mention})${dept}${yr}`;
        }
        return `• **${name}** (${mention})${dept}${yr}${elId}`;
      };

      // 5a. Inspect profiles designation & role
      for (const [, p] of profilesMap) {
        const des = (p.designation || '').toLowerCase().trim();
        const roleStr = (p.role || '').toLowerCase().trim();

        const isExecMember =
          des.includes('executive_member') ||
          des.includes('exec_member') ||
          des === 'executive' ||
          roleStr.includes('executive_member') ||
          roleStr.includes('exec_member') ||
          roleStr === 'executive';

        const isClassRep =
          des.includes('class_rep') ||
          des.includes('class representative') ||
          des.includes('class rep') ||
          roleStr.includes('class representative') ||
          roleStr.includes('class rep');

        const isCore =
          des.includes('core') ||
          des.includes('coordinator') ||
          des.includes('head') ||
          roleStr.includes('coordinator') ||
          roleStr.includes('core');

        if (isExecMember && p.id !== chapter.campus_lead_id) {
          const line = formatUser(p, 'Executive Member');
          if (!executiveMembers.some((em) => em.includes(p.full_name || p.id))) {
            executiveMembers.push(line);
          }
        }

        if (isClassRep) {
          const line = formatUser(p);
          if (!classReps.some((c) => c.includes(p.full_name || p.id))) {
            classReps.push(line);
          }
        }

        if (isCore && p.id !== chapter.campus_lead_id && !isExecMember) {
          const title = (p.designation || p.role || 'Core Team')
            .replace(/_/g, ' ')
            .replace(/\b\w/g, (c) => c.toUpperCase());
          const line = formatUser(p, title);
          if (!coreTeam.some((c) => c.includes(p.full_name || p.id))) {
            coreTeam.push(line);
          }
        }
      }

      // 5b. Inspect user_roles table records
      if (chapterRoles && chapterRoles.length > 0) {
        for (const r of chapterRoles) {
          const p = profilesMap.get(r.user_id);
          const name = p?.full_name || 'Unknown';
          const rKey = (r.role_key || r.role || '').toLowerCase().trim();

          if (rKey === 'student' || rKey === 'member') continue;
          if (rKey.includes('lead') && r.user_id === chapter.campus_lead_id) continue;

          const title = (r.role_key || r.role || 'Role')
            .replace(/_/g, ' ')
            .replace(/-/g, ' ')
            .replace(/\b\w/g, (c) => c.toUpperCase());

          if (rKey === 'executive_member' || rKey === 'exec_member' || rKey === 'executive') {
            const line = formatUser(p, 'Executive Member');
            if (!executiveMembers.some((em) => em.includes(name))) {
              executiveMembers.push(line);
            }
          } else if (rKey.includes('rep')) {
            if (!classReps.some((cr) => cr.includes(name))) {
              classReps.push(formatUser(p));
            }
          } else if (
            rKey.includes('lead') ||
            rKey.includes('head') ||
            rKey.includes('core') ||
            rKey.includes('coordinator') ||
            rKey.includes('manager')
          ) {
            const line = formatUser(p, title);
            if (!coreTeam.some((ct) => ct.includes(name) && ct.includes(title))) {
              coreTeam.push(line);
            }
          } else {
            const line = formatUser(p, title);
            if (!otherRoles.some((ot) => ot.includes(name) && ot.includes(title))) {
              otherRoles.push(line);
            }
          }
        }
      }

      const nowUnix = Math.floor(Date.now() / 1000);
      const embed = new EmbedBuilder()
        .setColor(0x3B82F6)
        .setTitle(`👥 Current Leadership & Roles Roster — ${chapter.name}`)
        .setDescription(
          `Official synchronized leadership structure and active roles for **${chapter.name}**.\n` +
          `• **Last Synchronized:** <t:${nowUnix}:R> (<t:${nowUnix}:T>)\n` +
          `*This roster automatically updates in real time with ElevatesOS.*`
        )
        .addFields(
          {
            name: '👑 Campus Lead',
            value: leadDisplay,
            inline: false,
          },
          {
            name: `⚡ Executive Members (${executiveMembers.length})`,
            value: executiveMembers.length > 0 ? executiveMembers.join('\n') : '*None assigned*',
            inline: false,
          },
          {
            name: `🎓 Class Representatives (${classReps.length})`,
            value: classReps.length > 0 ? classReps.join('\n') : '*None assigned*',
            inline: false,
          },
          {
            name: `🛠️ Core Team & Coordinators (${coreTeam.length})`,
            value: coreTeam.length > 0 ? coreTeam.join('\n') : '*None assigned*',
            inline: false,
          }
        );

      if (otherRoles.length > 0) {
        embed.addFields({
          name: `🎖️ Additional Roles (${otherRoles.length})`,
          value: otherRoles.slice(0, 15).join('\n'),
          inline: false,
        });
      }

      embed.addFields({
        name: '📊 Chapter Overview',
        value: `• **Chapter ID:** \`${chapter.id}\`\n• **Elevates ID:** \`${chapter.elevates_id || 'N/A'}\`\n• **College:** ${chapter.college || 'N/A'}\n• **Status:** \`${chapter.status || 'active'}\``,
        inline: false,
      });

      embed.setFooter({
        text: 'ElevatesOS Live Chapter Roster • Auto-updating',
      });
      embed.setTimestamp();

      // 6. Find target thread if not passed
      let thread = targetThread;
      if (!thread) {
        const forumData = await this.ensureChapterLogForum(client, resolvedChapterId);
        thread = forumData?.threadMap?.['current_roles'];
      }

      if (!thread) return;

      if (thread.joinable) {
        await thread.join().catch(() => {});
      }
      if (thread.archived) {
        await thread.setArchived(false).catch(() => {});
      }

      // 7. Find existing pinned roster message or bot message to edit
      const messages = await thread.messages.fetch({ limit: 25 }).catch(() => null);
      const rosterMsgs = messages
        ? Array.from(messages.values()).filter(
            (m) =>
              m.author.id === client.user.id &&
              m.embeds.length > 0 &&
              (m.embeds[0].footer?.text?.includes('ElevatesOS Live Chapter Roster') ||
                m.embeds[0].title?.includes('Current Leadership & Roles Roster'))
          )
        : [];

      if (rosterMsgs.length > 0) {
        await rosterMsgs[0].edit({ embeds: [embed] }).catch((err) => {
          console.error('[updateChapterCurrentRolesTopic] Edit error:', err.message);
        });
        if (!rosterMsgs[0].pinned) {
          await rosterMsgs[0].pin().catch(() => {});
        }
        // Clean up duplicate roster messages if any
        for (const dup of rosterMsgs.slice(1)) {
          await dup.delete().catch(() => {});
        }
      } else {
        const newMsg = await thread.send({ embeds: [embed] }).catch((err) => {
          console.error('[updateChapterCurrentRolesTopic] Send error:', err.message);
          return null;
        });
        if (newMsg) {
          await newMsg.pin().catch(() => {});
        }
      }
    } catch (err) {
      console.error('[updateChapterCurrentRolesTopic] Error:', err);
    }
  },

  /**
   * Centralized event logger that logs to discord_events_log
   * AND routes chapter-specific events to the appropriate starter thread in the chapter's log forum.
   *
   * Categories:
   * - "term_handover": term handover events, old CL/executive team demoted, new CL/executive team assigned
   * - "role_changes": ElevatesOS role assignments, promotions, demotions, permission updates
   * - "current_roles": live synchronized roster of chapter leadership
   * - "events": event creation, schedule updates, attendance, forms
   * - "cluster_activity": cluster created, member added/removed, host assigned/removed, tasks
   * - "moderation": kicks, bans, mutes, warns, unlinks
   * - "membership": member joined/left chapter server, account linked/unlinked, OTP
   * - "channel_role_changes": server configuration, discord channels, and guild roles
   */
  async logChapterEvent(client, chapterId, guildId, eventType, detail = {}, category = null) {
    try {
      // 1. Insert into database audit log
      try {
        await supabase.from('discord_events_log').insert({
          guild_id: guildId || 'global',
          discord_user_id: detail.discord_user_id || detail.userId || detail.targetId || detail.target_id || null,
          event_type: eventType,
          detail,
        });
      } catch (_) {}

      if (!client) return;

      // 2. Comprehensive chapter resolution
      if (!chapterId) {
        if (detail.chapter_id || detail.chapterId) {
          chapterId = detail.chapter_id || detail.chapterId;
        } else if (guildId && guildId !== config.mainGuildId) {
          const guildConfig = await this.getGuildConfig(guildId).catch(() => null);
          chapterId = guildConfig?.chapterId;
        }

        // Check target user's identity in ElevatesOS
        const targetUserId = detail.discord_user_id || detail.targetId || detail.userId || detail.target_id;
        if (!chapterId && targetUserId) {
          try {
            const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetUserId);
            const identity = isUuid
              ? await this.getIdentityByOsUserId(targetUserId)
              : await this.getIdentityByDiscordId(targetUserId);
            if (identity?.profile?.chapter_id || identity?.chapterId) {
              chapterId = identity.profile?.chapter_id || identity.chapterId;
            }
          } catch (_) {}
        }

        // Check executor / author's identity in ElevatesOS
        const executorUserId = detail.by_id || detail.executor_id || detail.caller_id || detail.moderator_id || detail.author_id || detail.userId;
        if (!chapterId && executorUserId) {
          try {
            const identity = await this.getIdentityByDiscordId(executorUserId);
            if (identity?.profile?.chapter_id) {
              chapterId = identity.profile.chapter_id;
            }
          } catch (_) {}
        }

        if (!chapterId && detail.by && typeof detail.by === 'string' && client) {
          const userObj = client.users.cache.find((u) => u.tag === detail.by || u.username === detail.by);
          if (userObj) {
            try {
              const identity = await this.getIdentityByDiscordId(userObj.id);
              if (identity?.profile?.chapter_id) {
                chapterId = identity.profile.chapter_id;
              }
            } catch (_) {}
          }
        }
      }

      // 3. Determine log category
      let targetCategory = category;
      if (!targetCategory) {
        const t = (eventType || '').toLowerCase();
        if (
          t.includes('term_handover') ||
          t.includes('handover') ||
          t.includes('term_transition') ||
          t.includes('term_demote') ||
          t.includes('term_promote') ||
          t.includes('term_end') ||
          t.includes('term_start') ||
          t === 'term_handover' ||
          t === 'term_handovers'
        ) {
          targetCategory = 'term_handover';
        } else if (
          t.includes('kick') ||
          t.includes('ban') ||
          t.includes('mute') ||
          t.includes('timeout') ||
          t.includes('warn') ||
          t.includes('unlink') ||
          t.includes('clear') ||
          t === 'moderation'
        ) {
          targetCategory = 'moderation';
        } else if (
          t.includes('message_delete') ||
          t.includes('message_edit') ||
          t.includes('message_bulk_delete') ||
          t.includes('voice') ||
          t.includes('invite') ||
          t.includes('thread') ||
          t === 'discord_activity'
        ) {
          targetCategory = 'discord_activity';
        } else if (
          t.includes('event') ||
          t.includes('attendance') ||
          t.includes('form') ||
          t.includes('meetup') ||
          t === 'events'
        ) {
          targetCategory = 'events';
        } else if (
          t.includes('role_assign') ||
          t.includes('role_revoke') ||
          t.includes('role_remove') ||
          t.includes('role_change') ||
          t.includes('role_insert') ||
          t.includes('role_update') ||
          t.includes('role_delete') ||
          t.includes('designation') ||
          t.includes('campus_lead') ||
          t.includes('os_role') ||
          t === 'role_changes'
        ) {
          targetCategory = 'role_changes';
        } else if (t.includes('cluster') || t.includes('host') || t.includes('task')) {
          targetCategory = 'cluster_activity';
        } else if (
          t.includes('join') ||
          t.includes('leave') ||
          t.includes('link') ||
          t.includes('member_join') ||
          t.includes('member_leave') ||
          t.includes('otp') ||
          t.includes('nickname') ||
          t === 'membership'
        ) {
          targetCategory = 'membership';
        } else {
          targetCategory = 'channel_role_changes';
        }
      }

      // 4. If chapterId was resolved, post in the chapter's dedicated forum in CHAPTER LOGS category
      if (chapterId) {
        const forumData = await this.ensureChapterLogForum(client, chapterId);
        if (forumData) {
          const { forumChannel, threadMap, chapterName } = forumData;
          let targetDestination = threadMap[targetCategory];

          // Ensure targetDestination is ALWAYS a valid ThreadChannel if in a Forum
          if (!targetDestination || (forumChannel.type === ChannelType.GuildForum && !targetDestination.isThread())) {
            if (forumChannel.type === ChannelType.GuildForum) {
              const fetchedActive = await forumChannel.threads.fetchActive().catch(() => ({ threads: new Map() }));
              const fetchedArchived = await forumChannel.threads.fetchArchived().catch(() => ({ threads: new Map() }));
              const allThreads = Array.from(new Map([...(fetchedActive.threads || new Map()), ...(fetchedArchived.threads || new Map())]).values());

              targetDestination = allThreads.find((th) => {
                const norm = th.name.toLowerCase().trim();
                if (targetCategory === 'term_handover') {
                  return norm.includes('term handover') || norm.includes('handover') || norm.includes('term');
                }
                if (targetCategory === 'role_changes') {
                  return (norm.includes('role changes') || norm.includes('roles changes')) && !norm.includes('channel');
                }
                if (targetCategory === 'current_roles') {
                  return norm.includes('current roles') || norm.includes('roster');
                }
                if (targetCategory === 'events') {
                  return norm.includes('events') || norm.includes('meetups');
                }
                if (targetCategory === 'cluster_activity') {
                  return norm.includes('cluster');
                }
                if (targetCategory === 'moderation') {
                  return norm.includes('moderation');
                }
                if (targetCategory === 'membership') {
                  return norm.includes('membership');
                }
                if (targetCategory === 'channel_role_changes') {
                  return norm.includes('channel & role') || norm.includes('server & channel') || norm.includes('channel');
                }
                if (targetCategory === 'discord_activity') {
                  return norm.includes('discord') || norm.includes('chat') || norm.includes('activity') || norm.includes('messages');
                }
                return norm.includes(targetCategory.replace(/_/g, ' '));
              }) || allThreads[0];

              if (!targetDestination) {
                targetDestination = await forumChannel.threads.create({
                  name: `📋 ${targetCategory.toUpperCase().replace(/_/g, ' ')}`,
                  message: { content: `**Audit Log for ${chapterName}**\nAuto-created log thread.` },
                  reason: `Starter audit thread for ${chapterName}`,
                }).catch(() => null);
              }
            } else {
              targetDestination = forumChannel;
            }
          }

          if (targetDestination) {
            // Unarchive thread if archived
            if (targetDestination.archived) {
              await targetDestination.setArchived(false).catch(() => {});
            }
            if (targetDestination.joinable) {
              await targetDestination.join().catch(() => {});
            }

            const embedColor =
              eventType.includes('handover') || eventType.includes('term')
                ? 0x6366F1
                : eventType.includes('ban') || eventType.includes('kick') || eventType.includes('unlink') || eventType.includes('delete')
                ? 0xEF4444
                : eventType.includes('warn') || eventType.includes('timeout') || eventType.includes('mute')
                ? 0xF59E0B
                : eventType.includes('edit') || eventType.includes('update')
                ? 0x3B82F6
                : eventType.includes('voice')
                ? 0x10B981
                : eventType.includes('event') || eventType.includes('attendance') || eventType.includes('form')
                ? 0x06B6D4
                : eventType.includes('role') || eventType.includes('designation') || eventType.includes('lead')
                ? 0xEC4899
                : eventType.includes('cluster') || eventType.includes('task')
                ? 0x8B5CF6
                : eventType.includes('join') || eventType.includes('activate') || eventType.includes('link') || eventType.includes('verified')
                ? 0x22C55E
                : 0x3B82F6;

            const emojiMap = {
              term_handover: '🔄',
              events: '📅',
              role_changes: '🎭',
              current_roles: '👥',
              cluster_activity: '🧠',
              moderation: '🛡️',
              membership: '👤',
              channel_role_changes: '⚙️',
              discord_activity: '💬',
            };
            const catEmoji = emojiMap[targetCategory] || '📌';

            const embed = new EmbedBuilder()
              .setColor(embedColor)
              .setTitle(`${catEmoji} Event: ${eventType.toUpperCase().replace(/_/g, ' ')}`)
              .setDescription(
                Object.entries(detail)
                  .filter(([k]) => k !== 'discord_user_id')
                  .map(([k, v]) => `• **${k.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())}:** ${typeof v === 'object' ? JSON.stringify(v) : v}`)
                  .join('\n') || 'No additional details.'
              )
              .setFooter({ text: `${chapterName} • ${targetCategory.replace(/_/g, ' ')}` })
              .setTimestamp();

            await targetDestination.send({ embeds: [embed] }).catch((err) => {
              console.error(`[logChapterEvent] Could not send message to log thread:`, err.message);
            });
            return;
          }
        }
      }

      // 5. Fallback: If not chapter-specific or chapter forum unavailable, log to Main Server general moderation channel
      try {
        const mainConfig = await this.getMainGuildConfig();
        const mainGuildId = mainConfig?.guildId || config.mainGuildId;
        const mainGuild = mainGuildId
          ? (client.guilds.cache.get(mainGuildId) || await client.guilds.fetch(mainGuildId).catch(() => null))
          : null;

        if (mainGuild) {
          const generalModLog = mainGuild.channels.cache.find(
            (c) =>
              c.type === ChannelType.GuildText &&
              (c.name === 'moderation' || c.name === 'mod-log' || c.name === 'bot-log' || c.name.includes('moderation'))
          );

          if (generalModLog) {
            const fallbackEmbed = new EmbedBuilder()
              .setColor(0x3B82F6)
              .setTitle(`📌 General Event: ${eventType.toUpperCase().replace(/_/g, ' ')}`)
              .setDescription(
                Object.entries(detail)
                  .map(([k, v]) => `• **${k.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())}:** ${typeof v === 'object' ? JSON.stringify(v) : v}`)
                  .join('\n') || 'No additional details.'
              )
              .setFooter({ text: 'Elevates Main Server Log' })
              .setTimestamp();

            await generalModLog.send({ embeds: [fallbackEmbed] }).catch(() => {});
          }
        }
      } catch (_) {}
    } catch (err) {
      console.error('[logChapterEvent] Error logging event:', err.message);
    }
  },

  /**
   * Synchronizes a user's Discord role and profile state across all guilds.
   * Runs through syncQueue to prevent Discord 429 rate limits.
   */
  async syncUserAcrossGuilds(client, discordUserId, osUserId = null) {
    if (!client || (!discordUserId && !osUserId)) return;

    syncQueue.enqueue('user', discordUserId || osUserId, async () => {
      let identity = null;
      if (discordUserId) {
        identity = await this.getIdentityByDiscordId(discordUserId);
      }
      if (!identity && osUserId) {
        identity = await this.getIdentityByOsUserId(osUserId);
      }

      const profile = identity?.profile || null;
      const targetDiscordId = discordUserId || profile?.discord_user_id || identity?.discord_user_id;
      if (!targetDiscordId) return;

      const isConnected = Boolean(
        profile &&
        profile.discord_connected &&
        (profile.discord_user_id === targetDiscordId || identity?.discord_user_id === targetDiscordId)
      );

      const userChapterId = profile?.chapter_id || identity?.chapterId;
      const userRoles = identity?.userRoles || [];

      // Iterate through all cached guilds the bot is in
      for (const [, guild] of client.guilds.cache) {
        let member = null;
        try {
          member = guild.members.cache.get(targetDiscordId) ||
            (await guild.members.fetch(targetDiscordId).catch(() => null));
        } catch (_) {}

        if (!member) continue;

        const guildConfig = await this.getGuildConfig(guild.id);
        const guildType = guildConfig?.guildType || 'chapter';
        const guildChapterId = guildConfig?.chapterId;

        const verifiedRole = guild.roles.cache.find(
          (r) => !r.managed && r.name.toLowerCase() === (config.roles.verified || 'ELEVATES • Member').toLowerCase()
        );
        const unverifiedRole = guild.roles.cache.find(
          (r) => !r.managed && (
            r.name.toLowerCase() === 'unverified' ||
            r.name.toLowerCase() === (config.roles.unverified || 'elevates').toLowerCase()
          )
        );
        const guestRole = guild.roles.cache.find(
          (r) => !r.managed && r.name.toLowerCase() === (config.roles.guest || 'Guest').toLowerCase()
        );

        // CASE 1: Main Server
        if (guildType === 'main') {
          const allowedFixedRoles = config.mainRoles.allowedRoles;

          if (isConnected && profile) {
            const targetRoleNames = new Set();

            // Default base role for all verified connected members
            targetRoleNames.add(config.mainRoles.defaultRole); // 'Verified Member'

            // Gather all OS role keys and names for this user across all chapters and globally
            const userRoleKeys = new Set();
            const userRoleNames = new Set();

            if (userRoles && userRoles.length > 0) {
              for (const r of userRoles) {
                const k = (r.role_key || r.role || '').toLowerCase().trim();
                if (k) userRoleKeys.add(k);
                if (r.roles?.name) userRoleNames.add(r.roles.name.trim());
                if (r.roles?.key) userRoleKeys.add(r.roles.key.toLowerCase().trim());
              }
            } else {
              // Fallback only when user has NO assigned records in user_roles
              if (profile.designation) {
                userRoleKeys.add(profile.designation.toLowerCase().trim());
              }
              if (profile.role) {
                userRoleKeys.add(profile.role.toLowerCase().trim());
              }
            }

            // High-level administrative roles directly from profile if assigned
            if (profile.role && ['founder', 'hq_admin', 'admin'].includes(profile.role.toLowerCase().trim())) {
              userRoleKeys.add(profile.role.toLowerCase().trim());
            }

            // Check if user is campus_lead for ANY chapter in chapters table
            try {
              const { data: leadChapters } = await supabase
                .from('chapters')
                .select('id')
                .eq('campus_lead_id', profile.id)
                .limit(1);
              if (leadChapters && leadChapters.length > 0) {
                userRoleKeys.add('campus_lead');
                userRoleNames.add('Campus Lead');
              }
            } catch (_) {}

            // Map each OS role to the main server fixed role
            for (const rKey of userRoleKeys) {
              const mapped = config.mainRoles.getMainRoleForOsRole(rKey);
              if (mapped) {
                targetRoleNames.add(mapped);
              }
            }

            // Also check any roles in the guild that match official OS role names or userRoleNames
            for (const [, gRole] of guild.roles.cache) {
              if (gRole.managed) continue;
              const gName = gRole.name.toLowerCase().trim();
              for (const rKey of userRoleKeys) {
                if (gName === rKey || gName === rKey.replace(/_/g, ' ')) {
                  targetRoleNames.add(gRole.name);
                }
              }
              for (const rName of userRoleNames) {
                if (gName === rName.toLowerCase()) {
                  targetRoleNames.add(gRole.name);
                }
              }
            }

            // Unverified should NEVER be held by a connected member
            targetRoleNames.delete('Unverified');

            // If user's only role is guest, do not assign Verified Member
            if (userRoleKeys.has('guest') && userRoleKeys.size === 1) {
              targetRoleNames.delete('Verified Member');
              targetRoleNames.add('Guest');
            }

            // Collect all OS-managed roles in the guild that the bot handles
            const allOsRoles = await this.getAllOsRoles();
            const osManagedRoleNames = new Set(allowedFixedRoles);
            for (const r of allOsRoles) {
              if (r.name) osManagedRoleNames.add(r.name);
            }
            osManagedRoleNames.add('ELEVATES • Founder');
            osManagedRoleNames.add('ELEVATES • Admin');

            for (const roleName of osManagedRoleNames) {
              let discordRole = guild.roles.cache.find(
                (r) => !r.managed && r.name.toLowerCase().trim() === roleName.toLowerCase().trim()
              );
              if (!discordRole && roleName === 'Founder') {
                discordRole = guild.roles.cache.find((r) => !r.managed && r.name === 'ELEVATES • Founder');
              }
              if (!discordRole && (roleName === 'HQ Admin' || roleName === 'Admin')) {
                discordRole = guild.roles.cache.find(
                  (r) => !r.managed && (r.name === 'HQ Admin' || r.name === 'ELEVATES • Admin')
                );
              }
              if (!discordRole) continue;

              const shouldHave =
                targetRoleNames.has(roleName) ||
                targetRoleNames.has(discordRole.name) ||
                (roleName === 'Founder' && (targetRoleNames.has('Founder') || targetRoleNames.has('ELEVATES • Founder'))) ||
                ((roleName === 'HQ Admin' || roleName === 'Admin') && (targetRoleNames.has('HQ Admin') || targetRoleNames.has('Admin') || targetRoleNames.has('ELEVATES • Admin'))) ||
                ((roleName === 'Class Rep' || roleName === 'Class Representative') && (targetRoleNames.has('Class Rep') || targetRoleNames.has('Class Representative')));

              const currentlyHas = member.roles.cache.has(discordRole.id);

              if (shouldHave && !currentlyHas) {
                try {
                  await member.roles.add(discordRole);
                  console.log(`[syncUserAcrossGuilds] Added main role "${discordRole.name}" to ${member.user.tag}`);
                  const targetChapter = userChapterId || profile?.chapter_id;
                  if (targetChapter) {
                    this.logChapterEvent(
                      client,
                      targetChapter,
                      guild.id,
                      'role_assigned',
                      {
                        user: `<@${member.id}> (${profile.full_name || member.user.username})`,
                        role: discordRole.name,
                        server: 'Main Server',
                        discord_user_id: member.id,
                      },
                      'role_changes'
                    ).catch(() => {});
                    this.updateChapterCurrentRolesTopic(client, targetChapter).catch(() => {});
                  }
                } catch (err) {
                  console.warn(`[syncUserAcrossGuilds] Could not add main role "${discordRole.name}" to ${member.user.tag}:`, err.message);
                }
              } else if (!shouldHave && currentlyHas) {
                try {
                  await member.roles.remove(discordRole);
                  console.log(`[syncUserAcrossGuilds] Removed main role "${discordRole.name}" from ${member.user.tag}`);
                  const targetChapter = userChapterId || profile?.chapter_id;
                  if (targetChapter) {
                    this.logChapterEvent(
                      client,
                      targetChapter,
                      guild.id,
                      'role_revoked',
                      {
                        user: `<@${member.id}> (${profile.full_name || member.user.username})`,
                        role: discordRole.name,
                        server: 'Main Server',
                        discord_user_id: member.id,
                      },
                      'role_changes'
                    ).catch(() => {});
                    this.updateChapterCurrentRolesTopic(client, targetChapter).catch(() => {});
                  }
                } catch (err) {
                  console.warn(`[syncUserAcrossGuilds] Could not remove main role "${discordRole.name}" from ${member.user.tag}:`, err.message);
                }
              }
            }

            if (profile.full_name && member.displayName !== profile.full_name) {
              await member.setNickname(profile.full_name).catch(() => {});
            }
          } else {
            // Member is NOT linked / disconnected in the Main Server
            if (unverifiedRole && !member.roles.cache.has(unverifiedRole.id)) {
              await member.roles.add(unverifiedRole).catch(() => {});
            }

            // Remove any assigned fixed membership/leadership roles
            const allOsRoles = await this.getAllOsRoles();
            const osManagedRoleNames = new Set(allowedFixedRoles);
            for (const r of allOsRoles) {
              if (r.name) osManagedRoleNames.add(r.name);
            }
            osManagedRoleNames.add('ELEVATES • Founder');
            osManagedRoleNames.add('ELEVATES • Admin');

            for (const roleName of osManagedRoleNames) {
              if (roleName === 'Unverified') continue;
              let discordRole = guild.roles.cache.find(
                (r) => !r.managed && r.name.toLowerCase().trim() === roleName.toLowerCase().trim()
              );
              if (!discordRole && roleName === 'Founder') {
                discordRole = guild.roles.cache.find((r) => !r.managed && r.name === 'ELEVATES • Founder');
              }
              if (!discordRole && (roleName === 'HQ Admin' || roleName === 'Admin')) {
                discordRole = guild.roles.cache.find(
                  (r) => !r.managed && (r.name === 'HQ Admin' || r.name === 'ELEVATES • Admin')
                );
              }
              if (discordRole && member.roles.cache.has(discordRole.id)) {
                await member.roles.remove(discordRole).catch(() => {});
                console.log(`[syncUserAcrossGuilds] Removed main role "${discordRole.name}" from unlinked ${member.user.tag}`);
              }
            }
          }
          continue;
        }

        // CASE 2: Chapter Server matching member's current OS chapter
        if (guildType === 'chapter' && guildChapterId === userChapterId) {
          if (isConnected && profile) {
            // 1. Ensure verified role and remove unverified/guest
            if (verifiedRole && !member.roles.cache.has(verifiedRole.id)) {
              await member.roles.add(verifiedRole).catch(() => {});
              this.logChapterEvent(client, guildChapterId, guild.id, 'account_linked', {
                member: member.user.tag,
                fullName: profile.full_name || member.user.username,
                elevatesId: profile.elevates_id || identity?.chapterId || 'Linked',
              }, 'membership').catch(() => {});
            }
            if (unverifiedRole && member.roles.cache.has(unverifiedRole.id)) {
              await member.roles.remove(unverifiedRole).catch(() => {});
            }
            if (guestRole && member.roles.cache.has(guestRole.id)) {
              await member.roles.remove(guestRole).catch(() => {});
            }

            // 2. Set Nickname to OS Full Name
            if (profile.full_name) {
              await member.setNickname(profile.full_name).catch(() => {});
            }

            // 3. Reconcile Chapter Roles: Campus Lead, Class Rep, Student, etc.
            const userChapterRoleKeys = new Set(
              userRoles
                .filter((r) => r.chapter_id === guildChapterId || !r.chapter_id)
                .map((r) => (r.role_key || r.role || '').toLowerCase().trim())
            );

            // Include profile designation and role ONLY if user has no assigned records in user_roles
            if (userRoles.length === 0 && (userChapterId === guildChapterId || !userChapterId)) {
              if (profile.designation) userChapterRoleKeys.add(profile.designation.toLowerCase().trim());
              if (profile.role) userChapterRoleKeys.add(profile.role.toLowerCase().trim());
            }

            // Also check if user is the assigned campus_lead for this chapter in chapters table
            try {
              const { data: chRow } = await supabase
                .from('chapters')
                .select('campus_lead_id')
                .eq('id', guildChapterId)
                .maybeSingle();
              if (chRow && chRow.campus_lead_id === profile.id) {
                userChapterRoleKeys.add('campus_lead');
              }
            } catch (_) {}

            // Fetch all OS role definitions to map them to Discord roles
            const allRoles = await this.getAllOsRoles();
            for (const rDef of allRoles) {
              const rName = rDef.name || rDef.key;
              const gRole = guild.roles.cache.find(
                (r) => !r.managed && (
                  r.name.toLowerCase().trim() === rName.toLowerCase().trim() ||
                  (rDef.key === 'class_representative' && r.name.toLowerCase().trim() === 'class rep') ||
                  (rDef.key === 'executive_member' && (r.name.toLowerCase().trim() === 'executive member' || r.name.toLowerCase().trim() === 'executive team' || r.name.toLowerCase().trim() === 'executive'))
                )
              );
              if (!gRole) continue;

              const shouldHave =
                userChapterRoleKeys.has(rDef.key.toLowerCase()) ||
                (rDef.key === 'campus_lead' && userChapterRoleKeys.has('campus_lead')) ||
                (rDef.key === 'class_representative' && (userChapterRoleKeys.has('class_representative') || userChapterRoleKeys.has('class_rep'))) ||
                (rDef.key === 'executive_member' && (userChapterRoleKeys.has('executive_member') || userChapterRoleKeys.has('exec_member') || userChapterRoleKeys.has('executive')));

              if (shouldHave && !member.roles.cache.has(gRole.id)) {
                await member.roles.add(gRole).catch(() => {});
                console.log(`[syncUserAcrossGuilds] Added chapter role "${gRole.name}" to ${member.user.tag}`);
                this.logChapterEvent(
                  client,
                  guildChapterId,
                  guild.id,
                  'role_assigned',
                  {
                    user: `<@${member.id}> (${profile.full_name || member.user.username})`,
                    role: gRole.name,
                    server: guild.name,
                    discord_user_id: member.id,
                  },
                  'role_changes'
                ).catch(() => {});
                this.updateChapterCurrentRolesTopic(client, guildChapterId).catch(() => {});
              } else if (!shouldHave && member.roles.cache.has(gRole.id)) {
                await member.roles.remove(gRole).catch(() => {});
                console.log(`[syncUserAcrossGuilds] Removed chapter role "${gRole.name}" from ${member.user.tag}`);
                this.logChapterEvent(
                  client,
                  guildChapterId,
                  guild.id,
                  'role_revoked',
                  {
                    user: `<@${member.id}> (${profile.full_name || member.user.username})`,
                    role: gRole.name,
                    server: guild.name,
                    discord_user_id: member.id,
                  },
                  'role_changes'
                ).catch(() => {});
                this.updateChapterCurrentRolesTopic(client, guildChapterId).catch(() => {});
              }
            }

            // Trigger welcome card if new verified member
            const { postVerificationWelcomeCard } = require('./generateWelcomeCard');
            await postVerificationWelcomeCard(guild, member, profile.full_name);
          } else {
            // Unlinked member in chapter server
            if (verifiedRole && member.roles.cache.has(verifiedRole.id)) {
              await member.roles.remove(verifiedRole).catch(() => {});
            }
            if (unverifiedRole && !member.roles.cache.has(unverifiedRole.id)) {
              await member.roles.add(unverifiedRole).catch(() => {});
            }
            const allRoles = await this.getAllOsRoles();
            for (const rDef of allRoles) {
              const gRole = guild.roles.cache.find(
                (r) => !r.managed && r.name.toLowerCase().trim() === (rDef.name || rDef.key).toLowerCase().trim()
              );
              if (gRole && member.roles.cache.has(gRole.id)) {
                await member.roles.remove(gRole).catch(() => {});
              }
            }
          }
          continue;
        }

        // CASE 3: Chapter Server for a DIFFERENT chapter (Assignment changed)
        if (guildType === 'chapter' && guildChapterId !== userChapterId) {
          // Remove chapter-specific roles from this old chapter server
          const allRoles = await this.getAllOsRoles();
          for (const rDef of allRoles) {
            const rName = rDef.name || rDef.key;
            const gRole = guild.roles.cache.find(
              (r) => !r.managed && r.name.toLowerCase().trim() === rName.toLowerCase().trim()
            );
            if (gRole && member.roles.cache.has(gRole.id)) {
              await member.roles.remove(gRole).catch(() => {});
            }
          }

          // Remove verified role from old chapter server
          if (verifiedRole && member.roles.cache.has(verifiedRole.id)) {
            await member.roles.remove(verifiedRole).catch(() => {});
          }
        }
      }
    });
  },

  /**
   * Unlinks an ElevatesOS identity completely.
   */
  async unlinkIdentity(discordUserId, guildId = null, reason = 'manual_unlink') {
    try {
      const now = new Date().toISOString();

      // 1. Update profiles table
      await supabase
        .from('profiles')
        .update({
          discord_connected: false,
          discord_user_id: null,
          discord_username: null,
          updated_at: now,
        })
        .eq('discord_user_id', discordUserId);

      // 2. Update discord_links table
      await supabase
        .from('discord_links')
        .update({
          status: 'unlinked',
          unlinked_at: now,
        })
        .eq('discord_user_id', discordUserId);

      // 3. Log event
      if (guildId) {
        try {
          await supabase
            .from('discord_events_log')
            .insert({
              guild_id: guildId,
              discord_user_id: discordUserId,
              event_type: 'unlink',
              detail: { reason },
            });
        } catch (_) {}
      }

      return { ok: true };
    } catch (err) {
      throw formatError(err, 'Failed to unlink identity');
    }
  },

  /**
   * Legacy alias: unlinkUser delegates to unlinkIdentity.
   */
  async unlinkUser(discordUserId, guildId, reason) {
    return this.unlinkIdentity(discordUserId, guildId, reason);
  },

  /**
   * Checks if a Discord user is currently linked in a guild (identity-based).
   */
  async getUserLink(discordUserId, guildId = null) {
    const identity = await this.getIdentityByDiscordId(discordUserId);
    if (!identity) return null;
    return {
      status: 'linked',
      os_user_id: identity.userId,
      discord_user_id: discordUserId,
      name: identity.name,
      elevatesId: identity.elevatesId,
      chapter_id: identity.chapterId,
      designation: identity.profile?.designation || identity.profile?.role || null,
      role: identity.profile?.role || null,
    };
  },

  /**
   * Fetches the current linked-member list for a chapter.
   */
  async getClusterMembers(chapterId) {
    try {
      const { data: profiles, error } = await supabase
        .from('profiles')
        .select('id, full_name, role, designation, elevates_id')
        .eq('chapter_id', chapterId)
        .eq('discord_connected', true);

      if (error) throw formatError(error, 'Failed to fetch cluster members');

      const members = (profiles || []).map((p) => ({
        name: p.full_name || 'Member',
        designation: p.designation || p.role || 'student',
        elevatesId: p.elevates_id,
      }));

      return { members };
    } catch (err) {
      throw formatError(err, 'Failed to fetch cluster members');
    }
  },

  /**
   * Logs an event to discord_events_log.
   */
  async logEvent(guildId, discordUserId, eventType, detail = {}) {
    try {
      const { data, error } = await supabase
        .from('discord_events_log')
        .insert({
          guild_id: guildId,
          discord_user_id: discordUserId,
          event_type: eventType,
          detail,
        })
        .select()
        .single();

      if (error) throw formatError(error, 'Failed to log event');
      return data;
    } catch (err) {
      return null;
    }
  },

  /**
   * Records a warning against a user.
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

      if (error) throw formatError(error, 'Failed to record warning');

      return {
        id: data.id,
        discordUserId: data.discord_user_id,
        guildId: data.guild_id,
        reason: data.reason,
        issuedBy: data.issued_by,
        createdAt: data.created_at,
      };
    } catch (err) {
      throw formatError(err, 'Failed to record warning');
    }
  },

  /**
   * Fetches warning history for a user in a guild ordered by created_at desc.
   */
  async getWarnings(guildId, discordUserId) {
    try {
      const { data, error } = await supabase
        .from('discord_warnings')
        .select('*')
        .eq('guild_id', guildId)
        .eq('discord_user_id', discordUserId)
        .order('created_at', { ascending: false });

      if (error) throw formatError(error, 'Failed to fetch warnings');

      const items = (data || []).map((row) => ({
        id: row.id,
        discordUserId: row.discord_user_id,
        guildId: row.guild_id,
        reason: row.reason,
        issuedBy: row.issued_by,
        createdAt: row.created_at,
      }));

      return { items };
    } catch (err) {
      throw formatError(err, 'Failed to fetch warnings');
    }
  },

  /**
   * Synchronizes Discord member roles directly.
   */
  async syncMemberRoles(guild, member, profile) {
    if (!guild || !member) return false;
    try {
      const verifiedRole = guild.roles.cache.find(
        (r) => !r.managed && r.name.toLowerCase() === (config.roles.verified || 'ELEVATES • Member').toLowerCase()
      );
      const unverifiedRole = guild.roles.cache.find(
        (r) => !r.managed && r.name.toLowerCase() === (config.roles.unverified || 'elevates').toLowerCase()
      );
      const guestRole = guild.roles.cache.find(
        (r) => !r.managed && r.name.toLowerCase() === (config.roles.guest || 'Guest').toLowerCase()
      );

      if (verifiedRole && !member.roles.cache.has(verifiedRole.id)) {
        await member.roles.add(verifiedRole).catch(() => {});
      }
      if (unverifiedRole && member.roles.cache.has(unverifiedRole.id)) {
        await member.roles.remove(unverifiedRole).catch(() => {});
      }
      if (guestRole && member.roles.cache.has(guestRole.id)) {
        await member.roles.remove(guestRole).catch(() => {});
      }

      if (profile?.name || profile?.full_name) {
        await member.setNickname(profile.name || profile.full_name).catch(() => {});
      }

      return true;
    } catch (err) {
      console.error('[syncMemberRoles] Error:', err);
      return false;
    }
  },
};
