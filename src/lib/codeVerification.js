const { PermissionFlagsBits } = require('discord.js');
const supabase = require('./supabase');
const api = require('./api');
const config = require('../config');
const { handleUserLinked } = require('./clusterSync');

const CODE_REGEX = /^[A-Za-z0-9]{6}$/;

// Rate limiting: max 5 invalid attempts within 10 minutes
const MAX_INVALID_ATTEMPTS = 5;
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes cooldown

const rateLimitMap = new Map(); // discordUserId -> { count, firstAttemptAt, cooldownUntil }

// Periodic cleanup for rateLimitMap every 10 minutes to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [userId, entry] of rateLimitMap.entries()) {
    if (entry.cooldownUntil && entry.cooldownUntil < now) {
      rateLimitMap.delete(userId);
    } else if (now - entry.firstAttemptAt > WINDOW_MS && !entry.cooldownUntil) {
      rateLimitMap.delete(userId);
    }
  }
}, 10 * 60 * 1000).unref();

/**
 * Checks if a user is currently rate-limited from submitting verification codes.
 */
function isRateLimited(discordUserId) {
  const now = Date.now();
  const entry = rateLimitMap.get(discordUserId);
  if (!entry) return false;

  if (entry.cooldownUntil) {
    if (now < entry.cooldownUntil) {
      return true;
    }
    // Cooldown expired
    rateLimitMap.delete(discordUserId);
    return false;
  }

  // Check if window expired
  if (now - entry.firstAttemptAt > WINDOW_MS) {
    rateLimitMap.delete(discordUserId);
    return false;
  }

  return false;
}

/**
 * Records a failed verification attempt and triggers cooldown if threshold exceeded.
 */
function recordFailedAttempt(discordUserId) {
  const now = Date.now();
  let entry = rateLimitMap.get(discordUserId);

  if (!entry || now - entry.firstAttemptAt > WINDOW_MS) {
    entry = { count: 1, firstAttemptAt: now, cooldownUntil: 0 };
    rateLimitMap.set(discordUserId, entry);
    return;
  }

  entry.count += 1;

  if (entry.count >= MAX_INVALID_ATTEMPTS) {
    entry.cooldownUntil = now + COOLDOWN_MS;
    console.warn(
      `[codeVerification] User ${discordUserId} exceeded ${MAX_INVALID_ATTEMPTS} invalid verification attempts within 10m. Entering cooldown until ${new Date(entry.cooldownUntil).toISOString()}. Possible abuse attempt.`
    );

    // Audit log abuse attempt
    try {
      supabase
        .from('discord_events_log')
        .insert({
          guild_id: 'global',
          discord_user_id: discordUserId,
          event_type: 'verification_rate_limit_exceeded',
          detail: {
            attempts: entry.count,
            cooldown_minutes: COOLDOWN_MS / (60 * 1000),
          },
          created_at: new Date().toISOString(),
        })
        .then(() => {})
        .catch(() => {});
    } catch (_) {}
  }
}

/**
 * Resets failed attempts after a successful verification.
 */
function resetRateLimit(discordUserId) {
  rateLimitMap.delete(discordUserId);
}

/**
 * Handles incoming messages specifically posted in #link-server.
 *
 * @param {import('discord.js').Message} message
 * @returns {Promise<boolean>} True if the message was handled by the verification flow.
 */
async function handleLinkServerMessage(message) {
  if (!message.guild || message.author.bot) return false;

  const channelName = message.channel.name.toLowerCase().trim();
  if (channelName !== 'link-server') return false;

  const rawContent = message.content.trim();
  if (!CODE_REGEX.test(rawContent)) {
    // Message does not match 6-character code pattern
    return false;
  }

  // 3.b Delete the user's message IMMEDIATELY, regardless of outcome
  // Codes should never linger visibly in the channel.
  await message.delete().catch(() => {});

  const discordUserId = message.author.id;
  const cleanCode = rawContent;

  // 3.e Rate-limiting check
  if (isRateLimited(discordUserId)) {
    console.warn(`[codeVerification] Ignored code verification attempt from rate-limited user ${discordUserId}`);
    return true;
  }

  try {
    const nowIso = new Date().toISOString();

    // 3.a Query discord_link_codes (OS-side table)
    // Check both exact code and uppercase code for user convenience
    const { data: codeRow, error: codeErr } = await supabase
      .from('discord_link_codes')
      .select('*')
      .or(`code.eq.${cleanCode},code.eq.${cleanCode.toUpperCase()}`)
      .eq('status', 'pending')
      .gt('expires_at', nowIso)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // 3.c IF no matching pending code found
    if (codeErr || !codeRow) {
      recordFailedAttempt(discordUserId);

      const errorMsg = await message.channel.send(
        `❌ ${message.author} Invalid or expired code. Generate a new one from your ElevatesOS profile.`
      ).catch(() => null);

      if (errorMsg) {
        setTimeout(() => errorMsg.delete().catch(() => {}), 8000);
      }
      return true;
    }

    // 3.d IF code is found and valid:
    resetRateLimit(discordUserId);

    const osUserId = codeRow.user_id || codeRow.os_user_id;

    // Mark code row status = 'used'
    await supabase
      .from('discord_link_codes')
      .update({
        status: 'used',
        used_at: new Date().toISOString(),
      })
      .eq('id', codeRow.id);

    // Perform actual linking
    const now = new Date().toISOString();

    // Update profiles table
    await supabase
      .from('profiles')
      .update({
        discord_connected: true,
        discord_user_id: discordUserId,
        discord_username: message.author.tag,
        discord_connected_at: now,
        updated_at: now,
      })
      .eq('id', osUserId);

    // Upsert discord_links table
    await supabase
      .from('discord_links')
      .upsert(
        {
          discord_user_id: discordUserId,
          discord_username: message.author.tag,
          os_user_id: osUserId,
          guild_id: message.guild.id,
          status: 'linked',
          linked_at: now,
          unlinked_at: null,
          updated_at: now,
        },
        { onConflict: 'discord_user_id,guild_id' }
      );

    // Determine guild type (main vs chapter)
    const guildConfig = await api.getGuildConfig(message.guild.id).catch(() => null);
    const isMainServer = guildConfig?.guildType === 'main' || message.guild.id === config.mainGuildId;

    const member = message.member || (await message.guild.members.fetch(discordUserId).catch(() => null));

    // Assign Verified Member role
    if (member) {
      const verifiedRoleName = isMainServer
        ? (config.mainRoles?.defaultRole || 'Verified Member')
        : (config.roles?.verified || 'ELEVATES • Member');

      const verifiedRole = message.guild.roles.cache.find(
        (r) => r.name.toLowerCase().trim() === verifiedRoleName.toLowerCase().trim()
      );

      if (verifiedRole && !member.roles.cache.has(verifiedRole.id)) {
        await member.roles.add(verifiedRole).catch(() => {});
      }

      // Remove Unverified role
      const unverifiedRoleName = (config.roles?.unverified || 'elevates').toLowerCase().trim();
      const unverifiedRole = message.guild.roles.cache.find(
        (r) => r.name.toLowerCase().trim() === unverifiedRoleName
      );
      if (unverifiedRole && member.roles.cache.has(unverifiedRole.id)) {
        await member.roles.remove(unverifiedRole).catch(() => {});
      }
    }

    // Synchronize nicknames and official OS roles
    await api.syncUserAcrossGuilds(message.client, discordUserId, osUserId).catch(() => {});

    // Resolve any pending_discord_roles for this user
    await handleUserLinked(message.client, {
      os_user_id: osUserId,
      discord_user_id: discordUserId,
    }).catch(() => {});

    // Post transient confirmation in #link-server (auto-delete after 8 seconds)
    const successMsg = await message.channel.send(
      `✅ ${message.author} Account verified and linked!`
    ).catch(() => null);

    if (successMsg) {
      setTimeout(() => successMsg.delete().catch(() => {}), 8000);
    }

    // Separately, post permanent welcome message in #welcome
    const welcomeChannel = message.guild.channels.cache.find(
      (c) => c.name === 'welcome' || c.name === 'welcome-chat' || c.name === 'general-chat'
    ) || message.guild.systemChannel;

    if (welcomeChannel && welcomeChannel.permissionsFor(message.guild.members.me)?.has(PermissionFlagsBits.SendMessages)) {
      await welcomeChannel.send(`🎉 Welcome ${message.author} to Elevates! You're all set.`).catch(() => {});
    }

    // Audit log linking
    await supabase
      .from('discord_events_log')
      .insert({
        guild_id: message.guild.id,
        discord_user_id: discordUserId,
        os_user_id: osUserId,
        event_type: 'code_verification_success',
        detail: {
          code_id: codeRow.id,
          username: message.author.tag,
        },
        created_at: now,
      })
      .catch(() => {});

    return true;
  } catch (err) {
    console.error(`[codeVerification] Error during code verification for ${discordUserId}:`, err);
    return true;
  }
}

module.exports = {
  handleLinkServerMessage,
  isRateLimited,
  recordFailedAttempt,
  resetRateLimit,
  rateLimitMap,
  CODE_REGEX,
};
