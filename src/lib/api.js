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
        const { data: chapter } = await supabase
          .from('chapters')
          .select('name')
          .eq('id', foundProfile.chapter_id)
          .maybeSingle();
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
        // Fetch active user roles
        const { data: userRoles } = await supabase
          .from('user_roles')
          .select('*')
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
            .select('*')
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
        .select('*')
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
   * Looks up which chapter a guild is mapped to.
   */
  async getGuildConfig(guildId) {
    try {
      const { data, error } = await supabase
        .from('guild_config')
        .select('*, chapters(name, slug)')
        .eq('guild_id', guildId)
        .maybeSingle();

      if (error || !data) {
        const { data: simpleData, error: simpleErr } = await supabase
          .from('guild_config')
          .select('*')
          .eq('guild_id', guildId)
          .maybeSingle();

        if (simpleErr || !simpleData) return null;

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
        };
      }

      const chapterObj = Array.isArray(data.chapters) ? data.chapters[0] : data.chapters;
      const chapterName = chapterObj?.name || null;

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
      };
    } catch (err) {
      return null;
    }
  },

  /**
   * Sets or updates guild configuration.
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

      if (error) throw formatError(error, 'Failed to set guild configuration');

      let chapterName = null;
      if (chapterId) {
        const { data: chapter } = await supabase
          .from('chapters')
          .select('name')
          .eq('id', chapterId)
          .maybeSingle();
        if (chapter) chapterName = chapter.name;
      }

      return {
        guildId: data.guild_id,
        guild_id: data.guild_id,
        chapterId: data.chapter_id,
        chapter_id: data.chapter_id,
        guildType: data.guild_type,
        guild_type: data.guild_type,
        chapterName,
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

      if (error || !data) return null;
      return {
        guildId: data.guild_id,
        guild_id: data.guild_id,
        guildType: data.guild_type,
        chapterId: data.chapter_id,
      };
    } catch (_) {
      return null;
    }
  },

  /**
   * Creates a one-time chapter setup token tied to chapter_id and campus_lead's discord_user_id.
   * Valid for 1 hour.
   */
  async createChapterSetupToken(chapterId, campusLeadDiscordId, campusLeadId = null) {
    const token = 'chp_' + crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const tokenData = {
      chapter_id: chapterId,
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
      return { ok: false, reason: 'invalid_token', message: 'Setup token not found or invalid.' };
    }

    if (tokenData.used_at) {
      return { ok: false, reason: 'already_used', message: 'This setup token has already been used.' };
    }

    if (new Date(tokenData.expires_at) < now) {
      return { ok: false, reason: 'expired', message: 'This setup token has expired (1-hour validity limit).' };
    }

    // Mark as used
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
        discord_user_id: callerDiscordId,
        event_type: 'chapter_setup_token_used',
        detail: { token: cleanToken, chapter_id: tokenData.chapter_id },
      });
    } catch (_) {}

    return { ok: true, tokenData };
  },

  /**
   * Provisions a new chapter guild upon /activate-chapter command.
   */
  async provisionChapterGuild(client, guild, chapterId, campusLeadMember) {
    // 1. Fetch chapter info
    const { data: chapter, error: chapErr } = await supabase
      .from('chapters')
      .select('*')
      .eq('id', chapterId)
      .maybeSingle();

    if (chapErr || !chapter) {
      throw formatError(chapErr, 'Failed to fetch chapter info during provisioning');
    }

    const chapterName = chapter.name || 'Chapter';
    const chapterSlug = (chapter.slug || chapterName).toLowerCase().replace(/[^a-z0-9]+/g, '-');

    // 2. Set guild_config
    await this.setGuildConfig(guild.id, chapterId, 'chapter');

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

    // 4. In the MAIN server, create Chapter Management category & dedicated channel
    let mainGuild = null;
    const mainConfig = await this.getMainGuildConfig();
    if (mainConfig?.guildId) {
      mainGuild = client.guilds.cache.get(mainConfig.guildId) ||
        (await client.guilds.fetch(mainConfig.guildId).catch(() => null));
    }
    if (!mainGuild) {
      // Fallback: look for guild configured as main or first guild
      mainGuild = client.guilds.cache.find((g) => g.id !== guild.id) || client.guilds.cache.first();
    }

    let chapterManagementLogChannel = null;
    if (mainGuild) {
      try {
        // Find or create "Chapter Management" category
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

        // Find Founder / HQ Admin role in main guild for channel permissions
        const founderRole = mainGuild.roles.cache.find(
          (r) =>
            r.name.toLowerCase().includes('founder') ||
            r.name.toLowerCase() === (config.roles.founder || '').toLowerCase()
        );

        const channelName = `chp-${chapterSlug}`.slice(0, 100);
        chapterManagementLogChannel = mainGuild.channels.cache.find(
          (c) => c.name === channelName && c.parentId === category.id
        );

        if (!chapterManagementLogChannel) {
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
                PermissionFlagsBits.EmbedLinks,
              ],
            },
          ];

          if (founderRole) {
            permissionOverwrites.push({
              id: founderRole.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
              ],
            });
          }

          chapterManagementLogChannel = await mainGuild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: category.id,
            topic: `ElevatesOS Official Audit Log for ${chapterName} Chapter (${chapterId})`,
            permissionOverwrites,
            reason: `Log channel for ${chapterName} Chapter`,
          });
        }

        // Post chapter activated log message
        const activationEmbed = new EmbedBuilder()
          .setColor(0x22C55E)
          .setTitle(`🏛️ Chapter Activated: ${chapterName}`)
          .setDescription(
            `A new chapter Discord server has been successfully provisioned and linked to ElevatesOS!\n\n` +
            `• **Chapter Name:** ${chapterName}\n` +
            `• **Chapter ID:** \`${chapterId}\`\n` +
            `• **Guild ID:** \`${guild.id}\`\n` +
            `• **Campus Lead:** ${campusLeadMember ? `<@${campusLeadMember.id}>` : 'None'}\n` +
            `• **Activated At:** <t:${Math.floor(Date.now() / 1000)}:F>`
          )
          .setFooter({ text: 'ElevatesOS Chapter Oversight' })
          .setTimestamp();

        await chapterManagementLogChannel.send({ embeds: [activationEmbed] }).catch(() => {});
      } catch (mainErr) {
        console.error('[provisionChapterGuild] Error setting up main server log channel:', mainErr);
      }
    }

    // 5. Post public account link message in chapter server
    const { ensureLinkChannel } = require('./accountLinking');
    await ensureLinkChannel(guild).catch((err) =>
      console.warn('[provisionChapterGuild] ensureLinkChannel error:', err.message)
    );

    return {
      chapterName,
      chapterSlug,
      guildId: guild.id,
      campusLeadRole,
      logChannel: chapterManagementLogChannel,
    };
  },

  /**
   * Centralized event logger that logs to discord_events_log
   * AND forwards chapter-specific events to the Chapter Management channel in the main server.
   */
  async logChapterEvent(client, chapterId, guildId, eventType, detail = {}) {
    try {
      // 1. Insert into database audit log
      await supabase.from('discord_events_log').insert({
        guild_id: guildId || 'global',
        discord_user_id: detail.discord_user_id || detail.userId || null,
        event_type: eventType,
        detail,
      });

      // 2. Forward to Main Server's dedicated chapter channel if this is a chapter
      if (!chapterId || !client) return;

      const { data: chapter } = await supabase
        .from('chapters')
        .select('name, slug')
        .eq('id', chapterId)
        .maybeSingle();

      if (!chapter) return;

      const chapterSlug = (chapter.slug || chapter.name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const channelName = `chp-${chapterSlug}`.slice(0, 100);

      // Locate channel in main guild
      for (const [, guild] of client.guilds.cache) {
        const logChannel = guild.channels.cache.find(
          (c) => c.name === channelName && c.isTextBased && c.isTextBased()
        );
        if (logChannel) {
          const embed = new EmbedBuilder()
            .setColor(
              eventType.includes('ban') || eventType.includes('kick') || eventType.includes('unlink')
                ? 0xEF4444
                : eventType.includes('warn')
                ? 0xF59E0B
                : 0x3B82F6
            )
            .setTitle(`📌 Chapter Event: ${eventType.toUpperCase()}`)
            .setDescription(
              Object.entries(detail)
                .map(([k, v]) => `• **${k}:** ${typeof v === 'object' ? JSON.stringify(v) : v}`)
                .join('\n') || 'No additional details.'
            )
            .setFooter({ text: `${chapter.name} Chapter Audit Log` })
            .setTimestamp();

          await logChannel.send({ embeds: [embed] }).catch(() => {});
          break;
        }
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
      } else if (osUserId) {
        identity = await this.getIdentityByOsUserId(osUserId);
      }

      if (!identity || !identity.profile) {
        return;
      }

      const profile = identity.profile;
      const targetDiscordId = profile.discord_user_id || discordUserId;
      if (!targetDiscordId) return;

      const userChapterId = profile.chapter_id;
      const userRoles = identity.userRoles || [];

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
          (r) => !r.managed && r.name.toLowerCase() === (config.roles.unverified || 'elevates').toLowerCase()
        );
        const guestRole = guild.roles.cache.find(
          (r) => !r.managed && r.name.toLowerCase() === (config.roles.guest || 'Guest').toLowerCase()
        );

        // CASE 1: Main Server
        if (guildType === 'main') {
          if (profile.discord_connected) {
            if (verifiedRole && !member.roles.cache.has(verifiedRole.id)) {
              await member.roles.add(verifiedRole).catch(() => {});
            }
            if (unverifiedRole && member.roles.cache.has(unverifiedRole.id)) {
              await member.roles.remove(unverifiedRole).catch(() => {});
            }
            if (profile.full_name) {
              await member.setNickname(profile.full_name).catch(() => {});
            }
          }
          continue;
        }

        // CASE 2: Chapter Server matching member's current OS chapter
        if (guildType === 'chapter' && guildChapterId === userChapterId) {
          if (profile.discord_connected) {
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
                .filter((r) => r.chapter_id === userChapterId || !r.chapter_id)
                .map((r) => (r.role_key || r.role || '').toLowerCase().trim())
            );

            if (profile.designation) userChapterRoleKeys.add(profile.designation.toLowerCase().trim());
            if (profile.role) userChapterRoleKeys.add(profile.role.toLowerCase().trim());

            // Fetch all OS role definitions to map them to Discord roles
            const allRoles = await this.getAllOsRoles();
            for (const rDef of allRoles) {
              const rName = rDef.name || rDef.key;
              const gRole = guild.roles.cache.find(
                (r) => r.name.toLowerCase().trim() === rName.toLowerCase().trim()
              );
              if (!gRole) continue;

              const shouldHave =
                userChapterRoleKeys.has(rDef.key.toLowerCase()) ||
                (rDef.key === 'campus_lead' && userChapterRoleKeys.has('campus_lead')) ||
                (rDef.key === 'class_representative' && (userChapterRoleKeys.has('class_representative') || userChapterRoleKeys.has('class_rep')));

              if (shouldHave && !member.roles.cache.has(gRole.id)) {
                await member.roles.add(gRole).catch(() => {});
              } else if (!shouldHave && member.roles.cache.has(gRole.id)) {
                // Remove outdated role
                await member.roles.remove(gRole).catch(() => {});
              }
            }

            // Trigger welcome card if new verified member
            const { postVerificationWelcomeCard } = require('./generateWelcomeCard');
            await postVerificationWelcomeCard(guild, member, profile.full_name);
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
              (r) => r.name.toLowerCase().trim() === rName.toLowerCase().trim()
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
