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
        .then(() => {}, () => {});
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

    // --- ENFORCE STRICT 1:1 ACCOUNT CONNECTION (Parallel validation queries) ---
    const [
      { data: existingProfilesForDiscord },
      { data: existingLinksForDiscord },
      { data: currentOsProfile },
      { data: currentOsLinks },
    ] = await Promise.all([
      supabase
        .from('profiles')
        .select('id, full_name, elevates_id, discord_user_id, discord_connected')
        .eq('discord_user_id', discordUserId)
        .eq('discord_connected', true),
      supabase
        .from('discord_links')
        .select('os_user_id, status')
        .eq('discord_user_id', discordUserId)
        .eq('status', 'linked'),
      supabase
        .from('profiles')
        .select('id, discord_user_id, discord_connected, full_name')
        .eq('id', osUserId)
        .maybeSingle(),
      supabase
        .from('discord_links')
        .select('discord_user_id, status')
        .eq('os_user_id', osUserId)
        .eq('status', 'linked'),
    ]);

    // Check 1: Is this Discord account already connected to a different ElevatesOS profile?
    const otherProfile = existingProfilesForDiscord?.find((p) => p.id !== osUserId);
    if (otherProfile) {
      console.warn(`[codeVerification] Rejected 1:N link attempt: Discord account ${discordUserId} is already connected to OS user ${otherProfile.id} (${otherProfile.full_name || 'Member'})`);
      const errorMsg = await message.channel.send(
        `❌ ${message.author} This Discord account is already connected to another ElevatesOS account. Each Discord account can only be linked to one ElevatesOS account. Please unlink your other account first.`
      ).catch(() => null);
      if (errorMsg) setTimeout(() => errorMsg.delete().catch(() => {}), 8000);
      return true;
    }

    const otherLink = existingLinksForDiscord?.find((l) => l.os_user_id && l.os_user_id !== osUserId);
    if (otherLink) {
      console.warn(`[codeVerification] Rejected 1:N link attempt: Discord account ${discordUserId} has active discord_links for OS user ${otherLink.os_user_id}`);
      const errorMsg = await message.channel.send(
        `❌ ${message.author} This Discord account is already connected to another ElevatesOS account. Each Discord account can only be linked to one ElevatesOS account. Please unlink your other account first.`
      ).catch(() => null);
      if (errorMsg) setTimeout(() => errorMsg.delete().catch(() => {}), 8000);
      return true;
    }

    // Check 2: Is this ElevatesOS account already connected to a different Discord account?
    if (
      currentOsProfile?.discord_connected &&
      currentOsProfile.discord_user_id &&
      currentOsProfile.discord_user_id !== discordUserId
    ) {
      console.warn(`[codeVerification] Rejected N:1 link attempt: OS user ${osUserId} is already connected to Discord account ${currentOsProfile.discord_user_id}`);
      const errorMsg = await message.channel.send(
        `❌ ${message.author} Your ElevatesOS account is already connected to a different Discord account (<@${currentOsProfile.discord_user_id}>). Only one Discord account can be linked to your ElevatesOS account. Please unlink that account first.`
      ).catch(() => null);
      if (errorMsg) setTimeout(() => errorMsg.delete().catch(() => {}), 8000);
      return true;
    }

    const otherDiscordLink = currentOsLinks?.find((l) => l.discord_user_id && l.discord_user_id !== discordUserId);
    if (otherDiscordLink) {
      console.warn(`[codeVerification] Rejected N:1 link attempt: OS user ${osUserId} has active discord_links for Discord account ${otherDiscordLink.discord_user_id}`);
      const errorMsg = await message.channel.send(
        `❌ ${message.author} Your ElevatesOS account is already connected to a different Discord account (<@${otherDiscordLink.discord_user_id}>). Only one Discord account can be linked to your ElevatesOS account. Please unlink that account first.`
      ).catch(() => null);
      if (errorMsg) setTimeout(() => errorMsg.delete().catch(() => {}), 8000);
      return true;
    }

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

    // Clean up any stale or residual associations for this discordUserId or osUserId to guarantee 1:1
    try {
      await supabase
        .from('profiles')
        .update({
          discord_connected: false,
          discord_user_id: null,
          discord_username: null,
          updated_at: now,
        })
        .eq('discord_user_id', discordUserId)
        .neq('id', osUserId);
    } catch (_) {}

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

    // Fetch profile to verify chapter membership
    const { data: userProfile } = await supabase
      .from('profiles')
      .select('chapter_id, role, full_name, discord_connected')
      .eq('id', osUserId)
      .maybeSingle();

    if (!isMainServer) {
      console.log(`[chapterRoleSync] Running code verification role sync for ${message.author.tag} (${discordUserId}) in chapter guild "${message.guild.name}" (${message.guild.id}, chapter_id: "${guildConfig?.chapterId}")`);
      console.log(`[chapterRoleSync] OS profile read: user_id=${osUserId}, full_name="${userProfile?.full_name || 'N/A'}", role="${userProfile?.role || 'none'}", profile_chapter_id="${userProfile?.chapter_id || 'none'}"`);

      const condition1_connected = true; // Just verified code
      const condition2_matchingChapter = Boolean(guildConfig?.chapterId && userProfile?.chapter_id && guildConfig.chapterId === userProfile.chapter_id);
      console.log(`[chapterRoleSync] Two-condition verification check for ${message.author.tag} in "${message.guild.name}":`);
      console.log(`  - Condition 1 (OS Account Linked & Connected): PASS`);
      console.log(`  - Condition 2 (Chapter Membership Match): ${condition2_matchingChapter ? 'PASS' : 'FAIL'} (guild.chapter_id="${guildConfig?.chapterId}", user.chapter_id="${userProfile?.chapter_id}")`);
    }

    const member = message.member || (await message.guild.members.fetch(discordUserId).catch(() => null));

    // Assign Verified Member role
    if (member) {
      const verifiedRoleName = isMainServer
        ? (config.mainRoles?.defaultRole || 'Verified Member')
        : (config.roles?.verified || 'ELEVATES • Member');

      const verifiedRole = message.guild.roles.cache.find(
        (r) => r.name.toLowerCase().trim() === verifiedRoleName.toLowerCase().trim()
      );
      console.log(`[chapterRoleSync] guild.roles.cache.find("${verifiedRoleName}") in "${message.guild.name}": ${verifiedRole ? `FOUND "${verifiedRole.name}" (id: ${verifiedRole.id}, position: ${verifiedRole.position})` : 'undefined'}`);

      const botMember = message.guild.members?.me || (message.guild.members?.fetchMe ? await message.guild.members.fetchMe().catch(() => null) : null);
      const botHighest = botMember?.roles?.highest;
      if (botHighest && verifiedRole && verifiedRole.position !== undefined && botHighest.position !== undefined && verifiedRole.position >= botHighest.position) {
        console.error(`[chapterRoleSync] ROLE HIERARCHY ERROR: Bot's highest role "${botHighest.name}" (position ${botHighest.position}) sits BELOW or EQUAL to target role "${verifiedRole.name}" (position ${verifiedRole.position}) in "${message.guild.name}". Bot lacks permission to assign this role!`);
      }

      if (verifiedRole && !member.roles.cache.has(verifiedRole.id)) {
        try {
          await member.roles.add(verifiedRole);
          console.log(`[chapterRoleSync] SUCCESS: Added verified role "${verifiedRole.name}" (${verifiedRole.id}) to ${member.user?.tag || member.id} in "${message.guild.name}"`);
        } catch (addErr) {
          console.error(`[chapterRoleSync] FAILED to add verified role "${verifiedRole.name}" (${verifiedRole.id}) to ${member.user?.tag || member.id} in "${message.guild.name}":`, {
            message: addErr.message,
            code: addErr.code,
            status: addErr.status,
            isHierarchyIssue: Boolean(botHighest && verifiedRole.position !== undefined && botHighest.position !== undefined && verifiedRole.position >= botHighest.position || addErr.code === 50013),
            botHighestRole: botHighest ? `${botHighest.name} (pos ${botHighest.position})` : 'unknown',
            targetRole: `${verifiedRole.name} (pos ${verifiedRole.position})`,
          });
        }
      }

      // Remove Unverified role
      const unverifiedRoleName = (config.roles?.unverified || 'elevates').toLowerCase().trim();
      const unverifiedRole = message.guild.roles.cache.find(
        (r) => r.name.toLowerCase().trim() === unverifiedRoleName
      );
      console.log(`[chapterRoleSync] guild.roles.cache.find("${unverifiedRoleName}") in "${message.guild.name}": ${unverifiedRole ? `FOUND "${unverifiedRole.name}" (id: ${unverifiedRole.id}, position: ${unverifiedRole.position})` : 'undefined'}`);

      if (unverifiedRole && member.roles.cache.has(unverifiedRole.id)) {
        try {
          await member.roles.remove(unverifiedRole);
          console.log(`[chapterRoleSync] SUCCESS: Removed unverified role "${unverifiedRole.name}" (${unverifiedRole.id}) from ${member.user?.tag || member.id} in "${message.guild.name}"`);
        } catch (remErr) {
          console.error(`[chapterRoleSync] FAILED to remove unverified role "${unverifiedRole.name}" (${unverifiedRole.id}) from ${member.user?.tag || member.id} in "${message.guild.name}":`, {
            message: remErr.message,
            code: remErr.code,
            status: remErr.status,
            isHierarchyIssue: Boolean(botHighest && unverifiedRole.position !== undefined && botHighest.position !== undefined && unverifiedRole.position >= botHighest.position || remErr.code === 50013),
            botHighestRole: botHighest ? `${botHighest.name} (pos ${botHighest.position})` : 'unknown',
            targetRole: `${unverifiedRole.name} (pos ${unverifiedRole.position})`,
          });
        }
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
    try {
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
        });
    } catch (_) {}

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
