const crypto = require('crypto');
const { ChannelType, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const supabase = require('./supabase');
const syncQueue = require('./syncQueue');
const config = require('../config');

// In-memory fallback token store if DB table chapter_setup_tokens is not yet migrated
const inMemorySetupTokens = new Map();

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
            return {
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

        return {
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
      }

      const chapterObj = Array.isArray(data.chapters) ? data.chapters[0] : data.chapters;
      const chapterName = chapterObj?.name || null;
      const chapterElevatesId = chapterObj?.elevates_id || null;

      return {
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
    } catch (err) {
      if (guildId === config.mainGuildId) {
        return {
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

    return {
      chapterName,
      chapterSlug,
      chapterId,
      elevatesId: chapterElevatesId,
      guildId: guild.id,
      campusLeadRole,
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

      const chapterName = chapter.name || 'Chapter';
      const chapterSlug = (chapter.slug || chapterName).toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const channelName = `chp-${chapterSlug}`.slice(0, 100);

      // 1. Locate Main Server
      let mainGuild = null;
      const mainConfig = await this.getMainGuildConfig();
      if (mainConfig?.guildId) {
        mainGuild = client.guilds.cache.get(mainConfig.guildId) ||
          (await client.guilds.fetch(mainConfig.guildId).catch(() => null));
      }
      if (!mainGuild) {
        mainGuild = client.guilds.cache.find((g) => g.id !== mainConfig?.guildId) || client.guilds.cache.first();
      }
      if (!mainGuild) return null;

      // 2. Find or create "Chapter Management" category
      let category = mainGuild.channels.cache.find(
        (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase().includes('chapter management')
      );
      if (!category) {
        category = await mainGuild.channels.create({
          name: 'Chapter Management',
          type: ChannelType.GuildCategory,
          reason: 'ElevatesOS Chapter Oversight',
        });
      }

      // 3. Setup Founders-only permissions
      const founderRole = mainGuild.roles.cache.find(
        (r) =>
          r.name.toLowerCase().includes('founder') ||
          r.name.toLowerCase() === (config.roles.founder || '').toLowerCase()
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

      // 4. Find or create Forum channel
      let forumChannel = mainGuild.channels.cache.find(
        (c) => c.name === channelName && c.parentId === category.id
      );

      // If existing channel is flat text, delete it to replace with Forum
      if (forumChannel && forumChannel.type !== ChannelType.GuildForum) {
        await forumChannel.delete('Replacing flat text log channel with Forum channel').catch(() => {});
        forumChannel = null;
      }

      if (!forumChannel) {
        try {
          forumChannel = await mainGuild.channels.create({
            name: channelName,
            type: ChannelType.GuildForum,
            parent: category.id,
            topic: `ElevatesOS Official Audit Log for ${chapterName} Chapter (${chapterId})`,
            permissionOverwrites,
            reason: `Forum audit log channel for ${chapterName} Chapter`,
          });
        } catch (forumErr) {
          // Fallback to GuildText if guild lacks COMMUNITY feature
          console.warn(`[ensureChapterLogForum] GuildForum creation failed, falling back to GuildText:`, forumErr.message);
          forumChannel = await mainGuild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: category.id,
            topic: `ElevatesOS Official Audit Log for ${chapterName} Chapter (${chapterId})`,
            permissionOverwrites,
            reason: `Fallback audit log channel for ${chapterName} Chapter`,
          }).catch(() => null);
        }
      }

      if (!forumChannel) return null;

      // 5. Ensure the 4 starter threads exist
      const STARTER_THREADS = [
        {
          key: 'moderation',
          name: '🛡️ Moderation',
          description: 'kicks, bans, mutes, warns, and unlinks',
        },
        {
          key: 'cluster_activity',
          name: '🧠 Cluster Activity',
          description: 'cluster created, member added/removed, host assigned/removed',
        },
        {
          key: 'channel_role_changes',
          name: '⚙️ Channel & Role Changes',
          description: 'any role or channel created or modified for this chapter',
        },
        {
          key: 'membership',
          name: '👤 Membership',
          description: 'member joined/left the chapter server, account linked/unlinked',
        },
      ];

      const threadMap = {};

      if (forumChannel.type === ChannelType.GuildForum) {
        const fetchedActive = await forumChannel.threads.fetchActive().catch(() => ({ threads: new Map() }));
        const activeThreads = fetchedActive.threads || new Map();

        for (const tSpec of STARTER_THREADS) {
          let thread = Array.from(activeThreads.values()).find(
            (th) =>
              th.name.toLowerCase().trim() === tSpec.name.toLowerCase().trim() ||
              th.name.toLowerCase().replace(/[^a-z0-9]/g, '') === tSpec.name.toLowerCase().replace(/[^a-z0-9]/g, '')
          );

          if (!thread) {
            try {
              thread = await forumChannel.threads.create({
                name: tSpec.name,
                message: {
                  content: `**${tSpec.name} Audit Log Thread**\nOfficial log of all ${tSpec.description} for **${chapterName}**.\n\n_Auto-managed by ElevatesOS._`,
                },
                reason: `Starter audit thread for ${chapterName}`,
              });
            } catch (thErr) {
              console.error(`[ensureChapterLogForum] Could not create thread ${tSpec.name}:`, thErr.message);
            }
          }

          if (thread) {
            threadMap[tSpec.key] = thread;
          }
        }
      }

      // 6. Update references in chapter_log_channels table
      try {
        await supabase
          .from('chapter_log_channels')
          .upsert(
            {
              chapter_id: chapterId,
              main_guild_id: mainGuild.id,
              channel_id: forumChannel.id,
              moderation_thread_id: threadMap['moderation']?.id || null,
              cluster_activity_thread_id: threadMap['cluster_activity']?.id || null,
              channel_role_changes_thread_id: threadMap['channel_role_changes']?.id || null,
              membership_thread_id: threadMap['membership']?.id || null,
            },
            { onConflict: 'chapter_id' }
          );
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
   * Centralized event logger that logs to discord_events_log
   * AND routes chapter-specific events to the appropriate starter thread in the chapter's log forum.
   *
   * Categories:
   * - "moderation": kicks, bans, mutes, warns, unlinks
   * - "cluster_activity": cluster created, member added/removed, host assigned/removed
   * - "channel_role_changes": any role or channel created/modified for this chapter
   * - "membership": member joined/left the chapter server, account linked/unlinked
   */
  async logChapterEvent(client, chapterId, guildId, eventType, detail = {}, category = null) {
    try {
      // 1. Insert into database audit log
      try {
        await supabase.from('discord_events_log').insert({
          guild_id: guildId || 'global',
          discord_user_id: detail.discord_user_id || detail.userId || detail.targetId || null,
          event_type: eventType,
          detail,
        });
      } catch (_) {}

      // 2. Resolve chapterId if not provided
      if (!chapterId && guildId) {
        const guildConfig = await this.getGuildConfig(guildId);
        chapterId = guildConfig?.chapterId;
      }

      if (!chapterId || !client) return;

      // 3. Determine log category
      let targetCategory = category;
      if (!targetCategory) {
        const t = (eventType || '').toLowerCase();
        if (
          t.includes('kick') ||
          t.includes('ban') ||
          t.includes('mute') ||
          t.includes('warn') ||
          t.includes('unlink') ||
          t === 'moderation'
        ) {
          targetCategory = 'moderation';
        } else if (t.includes('cluster') || t.includes('host')) {
          targetCategory = 'cluster_activity';
        } else if (
          t.includes('join') ||
          t.includes('leave') ||
          t.includes('link') ||
          t.includes('member_join') ||
          t.includes('member_leave') ||
          t === 'membership'
        ) {
          targetCategory = 'membership';
        } else {
          targetCategory = 'channel_role_changes';
        }
      }

      // 4. Ensure Forum channel and starter threads exist in Main Guild
      const forumData = await this.ensureChapterLogForum(client, chapterId);
      if (!forumData) return;

      const { forumChannel, threadMap, chapterName } = forumData;
      const targetDestination = threadMap[targetCategory] || forumChannel;

      // 5. Post embed into the target thread
      const embed = new EmbedBuilder()
        .setColor(
          eventType.includes('ban') || eventType.includes('kick') || eventType.includes('unlink')
            ? 0xEF4444
            : eventType.includes('warn')
            ? 0xF59E0B
            : eventType.includes('cluster')
            ? 0x8B5CF6
            : eventType.includes('join') || eventType.includes('activate')
            ? 0x22C55E
            : 0x3B82F6
        )
        .setTitle(`📌 Event: ${eventType.toUpperCase().replace(/_/g, ' ')}`)
        .setDescription(
          Object.entries(detail)
            .map(([k, v]) => `• **${k}:** ${typeof v === 'object' ? JSON.stringify(v) : v}`)
            .join('\n') || 'No additional details.'
        )
        .setFooter({ text: `${chapterName} Audit Log • ${targetCategory}` })
        .setTimestamp();

      if (targetDestination && typeof targetDestination.send === 'function') {
        await targetDestination.send({ embeds: [embed] }).catch((err) => {
          console.error(`[logChapterEvent] Could not send message to log thread:`, err.message);
        });
      }
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
                } catch (err) {
                  console.warn(`[syncUserAcrossGuilds] Could not add main role "${discordRole.name}" to ${member.user.tag}:`, err.message);
                }
              } else if (!shouldHave && currentlyHas) {
                try {
                  await member.roles.remove(discordRole);
                  console.log(`[syncUserAcrossGuilds] Removed main role "${discordRole.name}" from ${member.user.tag}`);
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
                  (rDef.key === 'class_representative' && r.name.toLowerCase().trim() === 'class rep')
                )
              );
              if (!gRole) continue;

              const shouldHave =
                userChapterRoleKeys.has(rDef.key.toLowerCase()) ||
                (rDef.key === 'campus_lead' && userChapterRoleKeys.has('campus_lead')) ||
                (rDef.key === 'class_representative' && (userChapterRoleKeys.has('class_representative') || userChapterRoleKeys.has('class_rep')));

              if (shouldHave && !member.roles.cache.has(gRole.id)) {
                await member.roles.add(gRole).catch(() => {});
                console.log(`[syncUserAcrossGuilds] Added chapter role "${gRole.name}" to ${member.user.tag}`);
              } else if (!shouldHave && member.roles.cache.has(gRole.id)) {
                await member.roles.remove(gRole).catch(() => {});
                console.log(`[syncUserAcrossGuilds] Removed chapter role "${gRole.name}" from ${member.user.tag}`);
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
