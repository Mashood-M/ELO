const { ChannelType, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const supabase = require('./supabase');
const api = require('./api');
const syncQueue = require('./syncQueue');
const config = require('../config');

// Fixed generic emoji set for clusters (deterministic mapping, no OS changes)
const CLUSTER_EMOJIS = ['🧠', '📦', '🔧', '🎯', '📡', '🛡️', '🚀', '💡'];

/**
 * Deterministically pick an emoji from CLUSTER_EMOJIS based on cluster id or name.
 */
function getClusterEmoji(cluster) {
  const seed = String(cluster?.id || cluster?.name || 'cluster');
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash) + seed.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % CLUSTER_EMOJIS.length;
  return CLUSTER_EMOJIS[index];
}

/**
 * Normalizes a channel name according to Discord rules (lowercase, hyphens, alphanumeric).
 */
function sanitizeChannelName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'cluster';
}

/**
 * Helper to record sync outcomes to discord_sync_log table.
 *
 * @param {object} params
 * @param {string} params.eventType
 * @param {string} [params.userId=null]
 * @param {string} [params.clusterId=null]
 * @param {string} [params.discordRoleId=null]
 * @param {'granted'|'revoked'|'created'|'archived'} params.action
 * @param {boolean} params.success
 * @param {string} [params.errorMessage=null]
 */
async function logSync({
  eventType,
  userId = null,
  clusterId = null,
  discordRoleId = null,
  action,
  success,
  errorMessage = null,
}) {
  try {
    const { error } = await supabase
      .from('discord_sync_log')
      .insert({
        event_type: eventType,
        user_id: userId || null,
        cluster_id: clusterId || null,
        discord_role_id: discordRoleId || null,
        action,
        success: Boolean(success),
        error_message: errorMessage || null,
        created_at: new Date().toISOString(),
      });

    if (error) {
      console.warn('[clusterSync] Could not write to discord_sync_log:', error.message);
    }
  } catch (err) {
    console.warn('[clusterSync] Failed inserting into discord_sync_log:', err.message);
  }
}

// In-memory caches for high-throughput, sub-second execution
const clusterCache = new Map(); // clusterId -> { data, expiresAt }
const userToDiscordCache = new Map(); // userId -> { discordId, expiresAt }
const chapterGuildCache = new Map(); // chapterId -> { guildId, expiresAt }
let mainGuildCache = { guildId: null, expiresAt: 0 };

function clearClusterCaches() {
  clusterCache.clear();
  userToDiscordCache.clear();
  chapterGuildCache.clear();
  mainGuildCache = { guildId: null, expiresAt: 0 };
}

function invalidateClusterCache(clusterId) {
  if (clusterId) {
    clusterCache.delete(clusterId);
  } else {
    clusterCache.clear();
  }
}

function setUserToDiscordCache(userId, discordId, ttlMs = 120000) {
  if (!userId) return;
  userToDiscordCache.set(String(userId).trim(), { discordId, expiresAt: Date.now() + ttlMs });
}

function invalidateUserToDiscordCache(userId) {
  if (!userId) {
    userToDiscordCache.clear();
    return;
  }
  userToDiscordCache.delete(String(userId).trim());
}

// Periodic cleanup of expired cluster caches to prevent memory leaks over uptime
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of clusterCache.entries()) {
    if (v.expiresAt && v.expiresAt < now) clusterCache.delete(k);
  }
  for (const [k, v] of userToDiscordCache.entries()) {
    if (v.expiresAt && v.expiresAt < now) userToDiscordCache.delete(k);
  }
  for (const [k, v] of chapterGuildCache.entries()) {
    if (v.expiresAt && v.expiresAt < now) chapterGuildCache.delete(k);
  }
}, 10 * 60 * 1000).unref();

/**
 * Resolves the Discord User ID for a given Supabase User UUID (profiles.id).
 * Checks in-memory cache first, then discord_links and profiles tables in parallel.
 */
async function resolveDiscordIdForUser(userId) {
  if (!userId) return null;

  // 0. If userId is already a Discord snowflake string (17-20 digits), return directly!
  const trimmed = String(userId).trim();
  if (/^\d{17,20}$/.test(trimmed)) {
    return trimmed;
  }

  // Check in-memory cache
  const cached = userToDiscordCache.get(trimmed);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.discordId;
  }

  try {
    // Query discord_links and profiles in parallel
    const [{ data: link }, { data: profile }] = await Promise.all([
      supabase
        .from('discord_links')
        .select('discord_user_id')
        .eq('os_user_id', userId)
        .eq('status', 'linked')
        .order('linked_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('profiles')
        .select('discord_user_id, discord_connected')
        .eq('id', userId)
        .maybeSingle(),
    ]);

    const discordId = link?.discord_user_id || profile?.discord_user_id || null;
    if (discordId) {
      setUserToDiscordCache(trimmed, discordId);
      return discordId;
    }
  } catch (err) {
    console.warn(`[clusterSync] Error resolving Discord ID for user ${userId}:`, err.message);
  }

  return null;
}

/**
 * Resolves the Chapter Guild for a given chapterId using guild_config.
 * Uses in-memory cache with TTL.
 */
async function getChapterGuild(client, chapterId) {
  if (!client || !chapterId) return null;

  const cached = chapterGuildCache.get(chapterId);
  if (cached && Date.now() < cached.expiresAt) {
    const cachedGuild = client.guilds.cache.get(cached.guildId);
    if (cachedGuild) return cachedGuild;
  }

  const { data: guildConfig, error } = await supabase
    .from('guild_config')
    .select('guild_id')
    .eq('chapter_id', chapterId)
    .eq('guild_type', 'chapter')
    .maybeSingle();

  if (error || !guildConfig?.guild_id) {
    return null;
  }

  chapterGuildCache.set(chapterId, { guildId: guildConfig.guild_id, expiresAt: Date.now() + 300000 });

  return client.guilds.cache.get(guildConfig.guild_id) ||
    (await client.guilds.fetch(guildConfig.guild_id).catch(() => null));
}

/**
 * Helper to check if a user is HQ staff / Admin (Founder, HQ Admin, Admin).
 *
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
async function isUserHqOrAdmin(userId) {
  if (!userId) return false;
  try {
    const [{ data: profile }, { data: userRoles }] = await Promise.all([
      supabase
        .from('profiles')
        .select('role, designation')
        .eq('id', userId)
        .maybeSingle(),
      supabase
        .from('user_roles')
        .select('role_key, role, roles(name, key)')
        .eq('user_id', userId),
    ]);

    const pRole = (profile?.role || '').toLowerCase().trim();
    const pDes = (profile?.designation || '').toLowerCase().trim();
    if (['founder', 'elevates • founder', 'hq_admin', 'hq admin', 'admin', 'elevates • admin'].includes(pRole) ||
        ['founder', 'elevates • founder', 'hq_admin', 'hq admin', 'admin', 'elevates • admin'].includes(pDes)) {
      return true;
    }

    if (userRoles && Array.isArray(userRoles)) {
      for (const ur of userRoles) {
        const rKey = (ur.role_key || ur.role || ur.roles?.key || ur.roles?.name || '').toLowerCase().trim();
        if (['founder', 'elevates • founder', 'hq_admin', 'hq admin', 'admin', 'elevates • admin'].includes(rKey)) {
          return true;
        }
      }
    }
  } catch (_) {}
  return false;
}

/**
 * Helper to check if a user is Campus Lead or Executive Member, and retrieve their chapter ID.
 *
 * @param {string} userId
 * @returns {Promise<{ chapterId: string|null, isChapterLead: boolean }>}
 */
async function getCreatorChapterInfo(userId) {
  if (!userId) return { chapterId: null, isChapterLead: false };
  try {
    const [{ data: profile }, { data: userRoles }] = await Promise.all([
      supabase
        .from('profiles')
        .select('chapter_id, role')
        .eq('id', userId)
        .maybeSingle(),
      supabase
        .from('user_roles')
        .select('role_key, role, chapter_id')
        .eq('user_id', userId),
    ]);

    const pRole = (profile?.role || '').toLowerCase().trim();
    let isChapterLead = [
      'campus_lead', 'campus lead',
      'executive_member', 'executive member',
      'exec_member', 'exec member', 'executive',
    ].includes(pRole);
    let chapterId = profile?.chapter_id || null;

    if (userRoles) {
      for (const ur of userRoles) {
        const rKey = (ur.role_key || ur.role || '').toLowerCase().trim();
        if ([
          'campus_lead', 'campus lead',
          'executive_member', 'executive member',
          'exec_member', 'exec member', 'executive',
        ].includes(rKey)) {
          isChapterLead = true;
          if (ur.chapter_id) {
            chapterId = ur.chapter_id;
            break;
          }
        }
      }
    }

    return { chapterId, isChapterLead };
  } catch (_) {
    return { chapterId: null, isChapterLead: false };
  }
}

/**
 * Resolves the Main Server Discord Guild (via guild_config where guild_type = 'main', fallback config.mainGuildId).
 *
 * @param {import('discord.js').Client} client
 * @returns {Promise<import('discord.js').Guild|null>}
 */
async function getMainGuild(client) {
  if (!client) return null;

  if (mainGuildCache.guildId && Date.now() < mainGuildCache.expiresAt) {
    const cachedGuild = client.guilds.cache.get(mainGuildCache.guildId);
    if (cachedGuild) return cachedGuild;
  }

  try {
    const { data: mainConfig, error } = await supabase
      .from('guild_config')
      .select('guild_id')
      .eq('guild_type', 'main')
      .maybeSingle();

    const mainGuildId = (!error && mainConfig?.guild_id) ? mainConfig.guild_id : config.mainGuildId;
    if (mainGuildId) {
      mainGuildCache = { guildId: mainGuildId, expiresAt: Date.now() + 300000 };
      return client.guilds.cache.get(mainGuildId) ||
        (await client.guilds.fetch(mainGuildId).catch(() => null));
    }
  } catch (err) {
    console.warn('[clusterSync] Error resolving main guild:', err.message);
    if (config.mainGuildId) {
      return client.guilds.cache.get(config.mainGuildId) ||
        (await client.guilds.fetch(config.mainGuildId).catch(() => null));
    }
  }
  return null;
}

/**
 * Determines whether a guild is the Elevates Main Server.
 *
 * @param {import('discord.js').Guild} guild
 * @returns {Promise<boolean>}
 */
async function isGuildMainServer(guild) {
  if (!guild) return false;
  if (guild.id === config.mainGuildId) return true;
  try {
    const gConf = await api.getGuildConfig(guild.id);
    if (gConf?.guildType === 'main' || gConf?.guild_type === 'main') return true;
  } catch (_) {}
  return false;
}

/**
 * Determines whether a cluster is an open cluster (public to all verified members server-wide)
 * vs a private / invite-only cluster.
 *
 * A cluster is ONLY open if:
 * 1. access_mode === 'open'
 * 2. OR is_open === true
 * 3. OR created by admin or founder in OS with access_mode !== 'invite' and without chapter scoping
 *
 * NOTE: Invite-only clusters (access_mode === 'invite') are NEVER open, even when placed in the Main Server!
 *
 * @param {object} cluster
 * @returns {Promise<boolean>}
 */
async function isClusterOpen(cluster) {
  if (!cluster) return false;
  const rawAccessMode = typeof cluster.access_mode === 'string' ? cluster.access_mode.trim().toLowerCase() : '';
  // If explicitly invite-only or closed, it is NEVER open!
  if (rawAccessMode === 'invite' || rawAccessMode === 'closed') {
    return false;
  }
  // If explicitly marked open
  if (rawAccessMode === 'open' || cluster.is_open === true) {
    return true;
  }

  // If created by founder or admin in OS without invite access_mode and without chapter scoping
  if (cluster.created_by && (!cluster.chapter_id || cluster.chapter_id === 'null' || cluster.chapter_id === '')) {
    try {
      const isHq = await isUserHqOrAdmin(cluster.created_by);
      if (isHq) return true;
    } catch (_) {}
  }

  return false;
}

/**
 * Resolves the Discord Guild for a cluster:
 *
 * 1. Open clusters (access_mode = 'open' or is_open = true) -> MAIN server.
 * 2. HQ / Admin created clusters (invite-only or open created by Founder / HQ Admin, or with no chapter scoping):
 *    -> MAIN server.
 * 3. Chapter clusters (made under a chapter by Campus Lead, Executive Member, or scoped to a chapter):
 *    -> CHAPTER server for that chapter.
 * 4. Fallback: if no chapter scoping is found, resolves MAIN server.
 *
 * @param {import('discord.js').Client} client
 * @param {object} cluster - Cluster record
 * @returns {Promise<import('discord.js').Guild|null>}
 */
async function getClusterGuild(client, cluster) {
  if (!client || !cluster) return null;

  const rawAccessModeExact = typeof cluster.access_mode === 'string' ? cluster.access_mode : '';
  const rawAccessMode = rawAccessModeExact.trim().toLowerCase();

  // 1. Open clusters always live in the Main Server
  const isOpen = (await isClusterOpen(cluster)) || rawAccessMode === 'open';
  if (isOpen) {
    console.log(`[clusterSync] access_mode='${rawAccessModeExact}' -> targeting main guild`);
    return await getMainGuild(client);
  }

  // 2. Check if creator or leader is HQ / Admin
  const isHqCreator = cluster.created_by
    ? await isUserHqOrAdmin(cluster.created_by)
    : (cluster.leader_id ? await isUserHqOrAdmin(cluster.leader_id) : false);

  // 3. Check if created under a chapter by Campus Lead or Executive Member, or has chapter_id
  let targetChapterId = cluster.chapter_id;
  if (!targetChapterId || targetChapterId === 'null' || targetChapterId === '') {
    if (cluster.created_by) {
      const creatorInfo = await getCreatorChapterInfo(cluster.created_by);
      if (creatorInfo.isChapterLead && creatorInfo.chapterId) {
        targetChapterId = creatorInfo.chapterId;
      }
    }
  }

  // If created by HQ or Admin without a specific chapter -> MAIN server!
  if (isHqCreator && (!targetChapterId || targetChapterId === 'null' || targetChapterId === '')) {
    console.log(`[clusterSync] access_mode='${rawAccessModeExact}' (HQ/Admin creator with no chapter) -> targeting main guild`);
    return await getMainGuild(client);
  }

  // If cluster is associated with a chapter (or access_mode is invite)
  if (rawAccessMode === 'invite' || (targetChapterId && targetChapterId !== 'null' && targetChapterId !== '')) {
    if (targetChapterId && targetChapterId !== 'null' && targetChapterId !== '') {
      console.log(`[clusterSync] access_mode='${rawAccessModeExact}' -> resolving chapter guild for chapter_id=${targetChapterId}`);
      const chapterGuild = await getChapterGuild(client, targetChapterId);
      if (chapterGuild) return chapterGuild;

      console.warn(`[clusterSync] Chapter guild not found for chapter_id=${targetChapterId}, cluster NOT created anywhere`);
      return null;
    }

    console.warn(`[clusterSync] Chapter guild not found for chapter_id=${targetChapterId || 'null'}, cluster NOT created anywhere`);
    return null;
  }

  // 4. If creator was HQ/Admin, place in Main Server
  if (isHqCreator) {
    console.log(`[clusterSync] access_mode='${rawAccessModeExact}' (HQ/Admin creator) -> targeting main guild`);
    return await getMainGuild(client);
  }

  // 5. Fallback: place in Main Server
  console.log(`[clusterSync] access_mode='${rawAccessModeExact}' (fallback) -> targeting main guild`);
  return await getMainGuild(client);
}

/**
 * Builds standard category permission overwrites for a cluster category.
 *
 * For private / chapter-scoped clusters:
 * - @everyone: EXPLICIT DENY ViewChannel
 * - Verified Member (and variants like ELEVATES • Member, Member): EXPLICIT DENY ViewChannel
 * - <Cluster Name> Member: ALLOW ViewChannel, SendMessages, Connect
 * - <Cluster Name> Host: ALLOW ViewChannel, SendMessages, Connect, ManageMessages, ManageThreads, MuteMembers, DeafenMembers, MoveMembers
 * - Campus Lead: ALLOW ViewChannel, ManageChannels, ManageRoles, SendMessages, Connect
 * - Executive Member: No blanket access (only access clusters they're specifically added to)
 * - Founder / HQ Admin: ALLOW ViewChannel (oversight access)
 * - Bot's own role: ALLOW ViewChannel, ManageChannels, ManageRoles, SendMessages, Connect
 *
 * For open clusters (access_mode = 'open' in main server):
 * - @everyone: DENY ViewChannel
 * - Verified Member: ALLOW ViewChannel, ReadMessageHistory, SendMessages, Connect, Speak, AddReactions
 * - Founder / HQ Admin: ALLOW ViewChannel and Management
 * - Cluster Member / Host: ALLOW
 * - Bot: ALLOW
 *
 * @param {object} params
 * @param {import('discord.js').Guild} params.guild
 * @param {object} params.cluster
 * @param {import('discord.js').Role} [params.memberRole]
 * @param {import('discord.js').Role} [params.hostRole]
 * @param {import('discord.js').Role} [params.campusLeadRole]
 * @param {import('discord.js').GuildMember} [params.me]
 * @param {boolean} [params.isOpen]
 * @returns {Promise<Array<object>>}
 */
async function buildClusterCategoryPermissions({
  guild,
  cluster,
  memberRole,
  hostRole,
  campusLeadRole,
  me,
  isOpen = false,
}) {
  const clusterName = cluster.name || 'Unnamed Cluster';
  const permissionOverwrites = [];

  const botMember = me || guild.members?.me || (await guild.members?.fetchMe().catch(() => null));

  // Resolve member role if not passed
  let resolvedMemberRole = memberRole;
  if (!resolvedMemberRole && cluster.discord_role_id) {
    resolvedMemberRole = guild.roles.cache.get(cluster.discord_role_id) ||
      (await guild.roles.fetch(cluster.discord_role_id).catch(() => null));
  }
  if (!resolvedMemberRole) {
    const memberRoleName = `${clusterName} Member`.toLowerCase().trim();
    resolvedMemberRole = guild.roles.cache.find((r) => r.name.toLowerCase().trim() === memberRoleName);
  }

  // Resolve host role if not passed
  let resolvedHostRole = hostRole;
  if (!resolvedHostRole) {
    const hostRoleName = `${clusterName} Host`.toLowerCase().trim();
    resolvedHostRole = guild.roles.cache.find((r) => r.name.toLowerCase().trim() === hostRoleName);
  }
  if (!resolvedHostRole && typeof ensureHostRole === 'function') {
    resolvedHostRole = await ensureHostRole(guild, clusterName).catch(() => null);
  }

  // ALL CLUSTERS (both Open and Invite-Only): Strictly private ONLY to users with Cluster Member and Host roles!
  // No broad access for @everyone, Verified Member, or any other server-wide roles.
  // Access is granted exclusively by joining the cluster in OS and receiving the cluster's "<Cluster Name> Member" or "<Cluster Name> Host" role.

  // 1. @everyone: EXPLICIT DENY ViewChannel
  permissionOverwrites.push({
    id: guild.roles.everyone.id,
    deny: [PermissionFlagsBits.ViewChannel],
  });

  // 2. Verified Member (and variants like ELEVATES • Member, Member): EXPLICIT DENY ViewChannel
  const verifiedRoleNames = [
    'verified member',
    'elevates • member',
    'member',
    (config.roles?.verified || '').toLowerCase().trim(),
    (config.mainRoles?.defaultRole || '').toLowerCase().trim(),
  ].filter(Boolean);

  const verifiedRoles = guild.roles.cache.filter((r) => {
    if (resolvedMemberRole && r.id === resolvedMemberRole.id) return false;
    if (resolvedHostRole && r.id === resolvedHostRole.id) return false;
    return verifiedRoleNames.includes(r.name.toLowerCase().trim());
  });

  for (const [, vRole] of verifiedRoles) {
    permissionOverwrites.push({
      id: vRole.id,
      deny: [PermissionFlagsBits.ViewChannel],
    });
  }

  // 3. Cluster's own "<Cluster Name> Member" role: ALLOW ViewChannel, SendMessages, Connect
  if (resolvedMemberRole) {
    permissionOverwrites.push({
      id: resolvedMemberRole.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
        PermissionFlagsBits.AddReactions,
      ],
    });
  }

  // 4. "<Cluster Name> Host" role: ALLOW same as Member plus ManageMessages, pin, voice management
  if (resolvedHostRole) {
    permissionOverwrites.push({
      id: resolvedHostRole.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
        PermissionFlagsBits.AddReactions,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ManageThreads,
        PermissionFlagsBits.MuteMembers,
        PermissionFlagsBits.DeafenMembers,
        PermissionFlagsBits.MoveMembers,
      ],
    });
  }

  // 5. Bot's own role/member: ALLOW manage channels/roles
  if (botMember) {
    permissionOverwrites.push({
      id: botMember.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageRoles,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.Connect,
      ],
    });
  }

  // Deduplicate by role/user ID to prevent Discord 50035 error
  const seenIds = new Set();
  const deduplicated = [];
  for (const ow of permissionOverwrites) {
    if (ow && ow.id && !seenIds.has(ow.id)) {
      seenIds.add(ow.id);
      deduplicated.push(ow);
    }
  }

  return deduplicated;
}

/**
 * Detects and removes duplicate categories and duplicate child channels for a cluster.
 * Keeps the canonical category (matching cluster.discord_category_id, exact name, or oldest)
 * and deletes any redundant duplicate categories and all channels inside them.
 * Also deduplicates child channels within the canonical category.
 *
 * @param {import('discord.js').Guild} guild
 * @param {object} cluster
 * @returns {Promise<import('discord.js').CategoryChannel|null>} Canonical category channel
 */
async function cleanupDuplicateClusterCategoriesAndChannels(guild, cluster) {
  if (!guild || !cluster) return null;

  try {
    // 1. Fetch all channels in guild if cache is not yet populated
    if (typeof guild.channels?.fetch === 'function' && guild.channels.cache.size <= 2) {
      await guild.channels.fetch().catch(() => {});
    }

    const clusterName = cluster.name || 'Unnamed Cluster';
    const clusterEmoji = getClusterEmoji(cluster);
    const expectedCategoryName = `${clusterEmoji}・${clusterName.toUpperCase()}`.trim().toLowerCase();
    const rawClusterName = clusterName.toLowerCase().replace(/[^a-z0-9]/g, '');

    // 2. Identify all categories in the guild that belong to this cluster
    const matchingCategories = [];

    for (const [, ch] of guild.channels.cache) {
      if (ch.type !== ChannelType.GuildCategory) continue;

      const chNameLower = ch.name.trim().toLowerCase();
      const chNameRaw = ch.name.toLowerCase().replace(/[^a-z0-9]/g, '');

      const isExactId = cluster.discord_category_id && ch.id === cluster.discord_category_id;
      const isExactName = chNameLower === expectedCategoryName;
      const isRawMatch = rawClusterName.length >= 3 && chNameRaw === rawClusterName;
      const isNameContains = rawClusterName.length >= 3 && (chNameRaw.includes(rawClusterName) || rawClusterName.includes(chNameRaw));

      if (isExactId || isExactName || isRawMatch || isNameContains) {
        matchingCategories.push(ch);
      }
    }

    if (matchingCategories.length === 0) {
      return null;
    }

    // 3. Determine the canonical category:
    // Priority:
    // A. The category matching cluster.discord_category_id
    // B. The category with the exact expected name
    // C. The category with the most existing child channels
    // D. The oldest category
    let canonicalCategory = null;

    if (cluster.discord_category_id) {
      canonicalCategory = matchingCategories.find((c) => c.id === cluster.discord_category_id);
    }
    if (!canonicalCategory) {
      canonicalCategory = matchingCategories.find((c) => c.name.trim().toLowerCase() === expectedCategoryName);
    }
    if (!canonicalCategory) {
      canonicalCategory = matchingCategories.reduce((best, curr) => {
        const countBest = guild.channels.cache.filter((ch) => ch.parentId === best.id).size;
        const countCurr = guild.channels.cache.filter((ch) => ch.parentId === curr.id).size;
        return countCurr > countBest ? curr : best;
      }, matchingCategories[0]);
    }

    // 4. Delete all DUPLICATE categories and all their child channels
    for (const dupCat of matchingCategories) {
      if (dupCat.id === canonicalCategory.id) continue;

      console.log(`[cleanupDuplicates] Found duplicate category "${dupCat.name}" (${dupCat.id}) for cluster "${clusterName}". Cleaning up...`);

      // Find all channels under this duplicate category
      const dupChildren = guild.channels.cache.filter((ch) => ch.parentId === dupCat.id);
      for (const [, child] of dupChildren) {
        try {
          console.log(`[cleanupDuplicates] Deleting child channel "${child.name}" (${child.id}) under duplicate category "${dupCat.name}"`);
          if (typeof child.delete === 'function') {
            await child.delete(`Removing duplicate cluster channel for ${clusterName}`);
          }
        } catch (delErr) {
          console.warn(`[cleanupDuplicates] Failed to delete child channel ${child.name}:`, delErr.message);
        }
      }

      // Delete the duplicate category itself
      try {
        if (typeof dupCat.delete === 'function') {
          await dupCat.delete(`Removing duplicate cluster category for ${clusterName}`);
        }
        console.log(`[cleanupDuplicates] Successfully deleted duplicate category "${dupCat.name}" (${dupCat.id})`);
      } catch (catDelErr) {
        console.warn(`[cleanupDuplicates] Failed to delete duplicate category ${dupCat.name}:`, catDelErr.message);
      }
    }

    // 5. Update clusters.discord_category_id in database if needed
    if (canonicalCategory && cluster.discord_category_id !== canonicalCategory.id) {
      cluster.discord_category_id = canonicalCategory.id;
      try {
        await supabase
          .from('clusters')
          .update({ discord_category_id: canonicalCategory.id })
          .eq('id', cluster.id);
      } catch (_) {}
    }

    // 6. Deduplicate child channels under the canonical category
    const canonicalChildren = guild.channels.cache.filter((ch) => ch.parentId === canonicalCategory.id);
    const seenChildNames = new Map();

    for (const [, child] of canonicalChildren) {
      const normChildName = child.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (seenChildNames.has(normChildName)) {
        console.log(`[cleanupDuplicates] Deleting duplicate child channel "${child.name}" (${child.id}) under canonical category "${canonicalCategory.name}"`);
        try {
          if (typeof child.delete === 'function') {
            await child.delete(`Removing duplicate child channel for ${clusterName}`);
          }
        } catch (childDelErr) {
          console.warn(`[cleanupDuplicates] Failed to delete duplicate child channel ${child.name}:`, childDelErr.message);
        }
      } else {
        seenChildNames.set(normChildName, child);
      }
    }

    return canonicalCategory;
  } catch (err) {
    console.error(`[cleanupDuplicates] Error cleaning duplicates for cluster ${cluster.name}:`, err.message);
    return null;
  }
}

/**
 * SECTION 3: CLUSTER CREATION (handleClusterCreated)
 *
 * Exact order:
 * 1. Create role: `<Cluster Name> Member` (mentionable: false, hoist: false).
 *    Immediately UPDATE clusters.discord_role_id with the new role ID before doing anything else.
 * 2. Create the private category with permission overwrites set AT CREATION (not applied after):
 *    - @everyone: deny ViewChannel
 *    - the new cluster role: allow ViewChannel, SendMessages, Connect
 *    - the bot's own role: allow manage channels/roles
 *    - chapter's Campus Lead role: allow ViewChannel + manage permissions
 *    - cluster's Host role: allow ViewChannel, SendMessages, Connect, ManageMessages, ManageThreads, Voice Management
 *    - Founder / HQ Admin: allow ViewChannel (oversight)
 *    - Verified Member (and equivalents): explicit deny ViewChannel
 * 3. Create child channels under that category (inherit category overwrites via parent_id):
 *    - #announcements (Announcement type)
 *    - #discussion, #resources, #challenges, #projects (Forum type)
 *    - cluster-room, cluster-room 1 (Voice channels)
 *    Use the existing emoji-and-uppercase-naming convention already established for cluster categories.
 * 4. UPDATE clusters.discord_category_id.
 * 5. INSERT into discord_sync_log (event_type: 'cluster_created', success: true/false).
 *
 * @param {import('discord.js').Client} client
 * @param {object} clusterData
 */
async function handleClusterCreated(client, clusterData) {
  if (!client || !clusterData) return null;

  // 1. Add log line at the very start of cluster creation showing raw values read:
  const rawAccessModeStr = clusterData.access_mode !== undefined ? `"${clusterData.access_mode}"` : 'undefined';
  const rawChapterIdStr = clusterData.chapter_id !== undefined ? `"${clusterData.chapter_id}"` : 'undefined';
  console.log(`[clusterSync] Starting cluster creation: id="${clusterData.id}", access_mode=${rawAccessModeStr}, chapter_id=${rawChapterIdStr}`);

  return await syncQueue.enqueueAsync('cluster', `${clusterData.id}:provision_category`, async () => {
    let cluster = clusterData;

    // Idempotency check: Before creating ANYTHING, check if clusters.discord_category_id is already set
    let existingCatId = cluster.discord_category_id;
    if (!existingCatId) {
      const { data: dbCluster } = await supabase
        .from('clusters')
        .select('*')
        .eq('id', cluster.id)
        .maybeSingle();
      if (dbCluster) {
        if (!cluster.name || !cluster.chapter_id || cluster.access_mode === undefined) {
          cluster = { ...cluster, ...dbCluster };
        }
        existingCatId = dbCluster.discord_category_id;
        cluster.discord_category_id = existingCatId;
      }
    }

    if (existingCatId) {
      console.log(`[clusterSync] Cluster ${cluster.name || cluster.id} already has a category (${existingCatId}), skipping duplicate creation`);
      const targetGuild = await getClusterGuild(client, cluster);
      const category = (targetGuild && existingCatId) ? (targetGuild.channels.cache.get(existingCatId) || null) : null;
      const memberRole = (targetGuild && cluster.discord_role_id) ? (targetGuild.roles.cache.get(cluster.discord_role_id) || null) : null;
      return {
        memberRole,
        category,
        channelMap: {},
        skipped: true,
      };
    }

    const isInitiallyOpen = await isClusterOpen(cluster);
    if (!cluster.name || (!cluster.chapter_id && !isInitiallyOpen)) {
      const { data: fetched, error } = await supabase
        .from('clusters')
        .select('*')
        .eq('id', cluster.id)
        .maybeSingle();
      if (error || !fetched) {
        await logSync({
          eventType: 'cluster_created',
          clusterId: cluster.id,
          action: 'created',
          success: false,
          errorMessage: error?.message || 'Cluster not found in Supabase',
        });
        return null;
      }
      cluster = fetched;
    }

    try {
      const guild = await getClusterGuild(client, cluster);
      if (!guild) {
        const failMsg = `Chapter guild not found for chapter_id=${cluster.chapter_id}, cluster NOT created anywhere`;
        console.warn(`[clusterSync] ${failMsg}`);
        await logSync({
          eventType: 'cluster_created',
          clusterId: cluster.id,
          action: 'created',
          success: false,
          errorMessage: failMsg,
        });
        return null;
      }

      // Ensure cache is hydrated if needed
      if (typeof guild.channels?.fetch === 'function' && guild.channels.cache.size <= 2) {
        await guild.channels.fetch().catch(() => {});
      }
      if (typeof guild.roles?.fetch === 'function' && guild.roles.cache.size <= 2) {
        await guild.roles.fetch().catch(() => {});
      }

      const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
      if (!me || !me.permissions.has([PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles])) {
        throw new Error(`Bot lacks ManageChannels or ManageRoles permissions in guild ${guild.id}`);
      }

      const clusterName = cluster.name || 'Unnamed Cluster';
      const memberRoleName = `${clusterName} Member`;
      const isOpen = (await isClusterOpen(cluster)) || (cluster.access_mode === 'open');

      // 1. Create role: `<Cluster Name> Member` (mentionable: false, hoist: false)
      let memberRole = null;
      if (cluster.discord_role_id) {
        memberRole = guild.roles.cache.get(cluster.discord_role_id) ||
          (await guild.roles.fetch(cluster.discord_role_id).catch(() => null));
      }

      if (!memberRole) {
        // Check existing role by name to prevent duplicates
        memberRole = guild.roles.cache.find(
          (r) => r.name.toLowerCase().trim() === memberRoleName.toLowerCase().trim()
        );
      }

      if (!memberRole) {
        memberRole = await syncQueue.enqueueAsync('cluster', `${cluster.id}:role:member`, async () => {
          return await guild.roles.create({
            name: memberRoleName,
            mentionable: false,
            hoist: false,
            color: 0x3B82F6, // Blue
            reason: `Role for members of cluster: ${clusterName}`,
          });
        });
      }

      // Immediately UPDATE clusters.discord_role_id before doing anything else
      if (memberRole && cluster.discord_role_id !== memberRole.id) {
        try {
          await supabase
            .from('clusters')
            .update({ discord_role_id: memberRole.id })
            .eq('id', cluster.id);
        } catch (_) {}
        cluster.discord_role_id = memberRole.id;
      }

      // 2. Build Category Permission Overwrites
      const isMainServer = await isGuildMainServer(guild);

      // Find or create Campus Lead role (for chapter servers only)
      const campusLeadRoleName = config.roles?.campusLead || 'Campus Lead';
      let campusLeadRole = guild.roles.cache.find(
        (r) => r.name.toLowerCase().trim() === campusLeadRoleName.toLowerCase().trim()
      );
      if (!campusLeadRole && !isOpen && !isMainServer) {
        campusLeadRole = await syncQueue.enqueueAsync('guild', `${guild.id}:role:campus_lead`, async () => {
          return await guild.roles.create({
            name: campusLeadRoleName,
            color: 0xF59E0B,
            reason: 'ElevatesOS Campus Lead Role',
          });
        }).catch(() => null);
      }

      // Ensure Host role exists
      const hostRole = await ensureHostRole(guild, clusterName).catch(() => null);

      const clusterEmoji = getClusterEmoji(cluster);
      const categoryName = `${clusterEmoji}・${clusterName.toUpperCase()}`;

      // Build comprehensive, secure category permission overwrites
      const permissionOverwrites = await buildClusterCategoryPermissions({
        guild,
        cluster,
        memberRole,
        hostRole,
        campusLeadRole,
        me,
        isOpen,
      });

      // Run cleanup on any existing duplicate categories and channels first!
      let category = await cleanupDuplicateClusterCategoriesAndChannels(guild, cluster);

      if (!category && cluster.discord_category_id) {
        category = guild.channels.cache.get(cluster.discord_category_id) ||
          (await guild.channels.fetch(cluster.discord_category_id).catch(() => null));
      }

      if (!category) {
        category = guild.channels.cache.find(
          (c) =>
            c.type === ChannelType.GuildCategory &&
            (c.name.trim().toLowerCase() === categoryName.trim().toLowerCase() ||
             c.name.toLowerCase().replace(/[^a-z0-9]/g, '') === clusterName.toLowerCase().replace(/[^a-z0-9]/g, ''))
        );
      }

      if (category) {
        // Ensure category permissions are up-to-date and secure
        try {
          if (typeof category.permissionOverwrites?.set === 'function') {
            await category.permissionOverwrites.set(
              permissionOverwrites,
              `Update cluster category permissions: ${clusterName} (isOpen: ${isOpen})`
            );
          }
          category.appliedOverwrites = permissionOverwrites;
        } catch (catPermErr) {
          console.warn(`[clusterSync] Could not update category permissions for ${clusterName}:`, catPermErr.message);
        }
      } else {
        category = await syncQueue.enqueueAsync('cluster', `${cluster.id}:category`, async () => {
          return await guild.channels.create({
            name: categoryName,
            type: ChannelType.GuildCategory,
            permissionOverwrites,
            reason: `${isOpen ? 'Open' : 'Private'} category for cluster: ${clusterName}`,
          });
        });
      }

      // Early write-back: update clusters.discord_category_id IMMEDIATELY after category creation,
      // before creating child channels so near-simultaneous duplicate triggers bail out early
      if (category) {
        cluster.discord_category_id = category.id;
        clusterCache.set(cluster.id, { data: cluster, expiresAt: Date.now() + 60000 });
        try {
          const { error: earlyCatErr } = await supabase
            .from('clusters')
            .update({ discord_category_id: category.id })
            .eq('id', cluster.id);
          if (earlyCatErr) {
            console.warn(`[clusterSync] Early update of discord_category_id for cluster ${cluster.id} failed:`, earlyCatErr.message);
          } else {
            console.log(`[clusterSync] discord_category_id written back early: categoryId=${category.id} for cluster ${cluster.id}`);
          }
        } catch (catUpdErr) {
          console.warn(`[clusterSync] Error writing back discord_category_id early:`, catUpdErr.message);
        }
      }

      // 3. Create child channels under that category (inherit category overwrites via parent_id):
      // - #announcements (Announcement type)
      // - #discussion, #resources, #challenges, #projects (Forum type)
      // - cluster-room, cluster-room 1 (Voice channels)
      const childChannelSpecs = [
        {
          name: 'announcements',
          type: ChannelType.GuildAnnouncement,
          topic: `${clusterName} • Official announcements and updates.`,
          fallbackType: ChannelType.GuildText,
        },
        {
          name: 'discussion',
          type: ChannelType.GuildForum,
          topic: `${clusterName} • Open discussion and questions.`,
          fallbackType: ChannelType.GuildText,
        },
        {
          name: 'resources',
          type: ChannelType.GuildForum,
          topic: `${clusterName} • Curated learning materials and resources.`,
          fallbackType: ChannelType.GuildText,
        },
        {
          name: 'challenges',
          type: ChannelType.GuildForum,
          topic: `${clusterName} • Weekly challenges and task submissions.`,
          fallbackType: ChannelType.GuildText,
        },
        {
          name: 'projects',
          type: ChannelType.GuildForum,
          topic: `${clusterName} • Showcase projects and collaborations.`,
          fallbackType: ChannelType.GuildText,
        },
        {
          name: 'cluster-room',
          type: ChannelType.GuildVoice,
        },
        {
          name: 'cluster-room 1',
          type: ChannelType.GuildVoice,
        },
      ];

      const channelMap = {};

      await Promise.all(
        childChannelSpecs.map(async (spec) => {
          const normSpecName = spec.name.toLowerCase().replace(/[^a-z0-9]/g, '');
          let existingChild = guild.channels.cache.find(
            (c) => c.parentId === category.id && (
              c.name.toLowerCase().trim() === spec.name.toLowerCase().trim() ||
              c.name.toLowerCase().replace(/[^a-z0-9]/g, '') === normSpecName
            )
          );

          if (!existingChild) {
            existingChild = await syncQueue.enqueueAsync('channel', `${category.id}:${spec.name}`, async () => {
              try {
                return await guild.channels.create({
                  name: spec.name,
                  type: spec.type,
                  parent: category.id,
                  topic: spec.topic || undefined,
                  reason: `Cluster child channel for ${clusterName}`,
                });
              } catch (createErr) {
                if (spec.fallbackType) {
                  return await guild.channels.create({
                    name: spec.name,
                    type: spec.fallbackType,
                    parent: category.id,
                    topic: spec.topic || undefined,
                    reason: `Cluster child channel fallback for ${clusterName}`,
                  });
                }
                throw createErr;
              }
            }).catch((err) => {
              console.warn(`[clusterSync] Could not create child channel ${spec.name}:`, err.message);
              return null;
            });
          }

          if (existingChild) {
            channelMap[spec.name] = existingChild.id;

            // Ensure child channel inherits the category's open overwrites
            if (typeof existingChild.lockPermissions === 'function' && !existingChild.permissionsLocked) {
              try {
                await existingChild.lockPermissions();
              } catch (_) {}
            }
          }
        })
      );

      // Send a welcome notice in #announcements if newly created or empty
      if (isOpen && channelMap['announcements']) {
        try {
          const annChannel = guild.channels.cache.get(channelMap['announcements']) ||
            (await guild.channels.fetch(channelMap['announcements']).catch(() => null));
          if (annChannel && typeof annChannel.messages?.fetch === 'function') {
            const msgs = await annChannel.messages.fetch({ limit: 1 }).catch(() => null);
            if (!msgs || msgs.size === 0) {
              const welcomeEmbed = new EmbedBuilder()
                .setColor(0x3B82F6)
                .setTitle(`🌐 Welcome to ${clusterName} Open Cluster!`)
                .setDescription(
                  cluster.description
                    ? `**${cluster.description}**\n\nThis open cluster was created by Elevates HQ and is open to the entire Elevates community. Explore resources, participate in challenges, and join discussions!`
                    : `This open cluster was created by Elevates HQ and is open to the entire Elevates community. Explore resources, participate in challenges, and join discussions!`
                )
                .addFields(
                  { name: '💬 Discussions', value: 'Share ideas and ask questions in `#discussion`', inline: true },
                  { name: '📚 Resources', value: 'Access learning materials in `#resources`', inline: true },
                  { name: '🎯 Challenges', value: 'Participate in weekly tasks in `#challenges`', inline: true }
                )
                .setFooter({ text: 'ElevatesOS Open Cluster System' })
                .setTimestamp();

              await annChannel.send({ embeds: [welcomeEmbed] }).catch(() => {});
            }
          }
        } catch (_) {}
      }

      // Initial member & host assignment: ensure leader_id and created_by have roles in parallel
      const initialUserIds = new Set();
      if (cluster.leader_id) initialUserIds.add(cluster.leader_id);
      if (cluster.created_by) initialUserIds.add(cluster.created_by);
      if (Array.isArray(cluster.member_ids)) {
        for (const mId of cluster.member_ids) {
          if (mId) initialUserIds.add(mId);
        }
      }

      await Promise.all(
        Array.from(initialUserIds).map(async (uId) => {
          const isLeader = uId === cluster.leader_id || (!cluster.leader_id && uId === cluster.created_by);
          return handleMemberAdded(client, {
            cluster_id: cluster.id,
            user_id: uId,
            role_in_cluster: isLeader ? 'host' : 'member',
          }).catch((err) => console.warn(`[clusterSync] Initial member add error for ${uId}:`, err.message));
        })
      );

      // 4. UPDATE clusters.discord_category_id
      const { error: updateCatErr } = await supabase
        .from('clusters')
        .update({ discord_category_id: category.id })
        .eq('id', cluster.id);

      if (updateCatErr) {
        console.error(`[clusterSync] Error updating discord_category_id for cluster ${cluster.id}:`, updateCatErr.message);
      }
      cluster.discord_category_id = category.id;
      clusterCache.set(cluster.id, { data: cluster, expiresAt: Date.now() + 60000 });

      // Maintain backward-compatible cluster_discord_mappings table
      try {
        await supabase
          .from('cluster_discord_mappings')
          .upsert(
            {
              cluster_id: cluster.id,
              guild_id: guild.id,
              category_id: category.id,
              member_role_id: memberRole.id,
              discussion_channel_id: channelMap['discussion'] || null,
              resources_channel_id: channelMap['resources'] || null,
              challenges_channel_id: channelMap['challenges'] || null,
              projects_channel_id: channelMap['projects'] || null,
              voice_channel_id: channelMap['cluster-room'] || channelMap['cluster-room 1'] || channelMap[`${clusterName} Voice`] || null,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'cluster_id,guild_id' }
          );
      } catch (_) {}

      // 5. INSERT into discord_sync_log
      await logSync({
        eventType: 'cluster_created',
        clusterId: cluster.id,
        discordRoleId: memberRole.id,
        action: 'created',
        success: true,
      });

      return {
        memberRole,
        category,
        channelMap,
      };
    } catch (err) {
      console.error(`[clusterSync] handleClusterCreated failed for cluster ${cluster.id}:`, err.message);
      await logSync({
        eventType: 'cluster_created',
        clusterId: cluster.id,
        discordRoleId: cluster.discord_role_id || null,
        action: 'created',
        success: false,
        errorMessage: err.message,
      });
      throw err;
    }
  });
}

/**
 * Helper to ensure a Cluster Host role exists in a guild.
 */
async function ensureHostRole(guild, clusterName) {
  const hostRoleName = `${clusterName} Host`;
  let hostRole = guild.roles.cache.find(
    (r) => r.name.toLowerCase().trim() === hostRoleName.toLowerCase().trim()
  );
  if (!hostRole) {
    hostRole = await syncQueue.enqueueAsync('guild', `${guild.id}:role:${hostRoleName}`, async () => {
      return await guild.roles.create({
        name: hostRoleName,
        color: 0x8B5CF6, // Purple
        reason: `Host role for cluster: ${clusterName}`,
      });
    }).catch(() => null);
  }
  return hostRole;
}

/**
 * SECTION 4: MEMBER ADD (handleMemberAdded)
 *
 * On cluster_members INSERT:
 * 1. Look up user_id in the identity/link table.
 * 2. IF linked:
 *    a. Fetch the guild member in that chapter's guild.
 *    b. IF present in guild: add the cluster's discord_role_id (and the Host role too if role_in_cluster = 'host'). Log success.
 *    c. IF linked but not in this specific guild: INSERT into pending_discord_roles (role_type: 'cluster_member' or 'cluster_host', target_id: cluster_id).
 * 3. IF NOT linked: INSERT into pending_discord_roles same as above.
 * Log every outcome (success, pending, or failure) to discord_sync_log.
 * Reject if cluster is archived.
 *
 * @param {import('discord.js').Client} client
 * @param {object} memberRow
 */
async function handleMemberAdded(client, memberRow) {
  if (!client || !memberRow) return;

  const clusterId = memberRow.cluster_id || memberRow.clusterId;
  const userId = memberRow.user_id || memberRow.userId || memberRow.member_id || memberRow.memberId || memberRow.profile_id;
  if (!clusterId || !userId) return;

  const roleInCluster = (memberRow.role_in_cluster || memberRow.role || 'member').toLowerCase().trim();
  const roleType = roleInCluster === 'host' ? 'cluster_host' : 'cluster_member';

  try {
    // 1. Fetch cluster and check if archived (check cache first)
    let cluster = null;
    const cachedCl = clusterCache.get(clusterId);
    if (cachedCl && Date.now() < cachedCl.expiresAt) {
      cluster = cachedCl.data;
    } else {
      const { data: fetched, error: clErr } = await supabase
        .from('clusters')
        .select('*')
        .eq('id', clusterId)
        .maybeSingle();

      if (clErr || !fetched) {
        await logSync({
          eventType: 'cluster_member_added',
          userId,
          clusterId,
          action: 'granted',
          success: false,
          errorMessage: 'Cluster not found in Supabase',
        });
        return;
      }
      cluster = fetched;
      clusterCache.set(clusterId, { data: fetched, expiresAt: Date.now() + 60000 });
    }

    if (cluster.status === 'archived') {
      await logSync({
        eventType: 'cluster_member_added',
        userId,
        clusterId,
        discordRoleId: cluster.discord_role_id || null,
        action: 'granted',
        success: false,
        errorMessage: 'Cannot add member to archived cluster; auto-assignment rejected',
      });
      return;
    }

    // 2. Look up user_id in identity table
    const discordUserId = await resolveDiscordIdForUser(userId);

    // 3. IF NOT linked: queue pending_discord_roles
    if (!discordUserId) {
      await supabase
        .from('pending_discord_roles')
        .upsert(
          {
            user_id: userId,
            role_type: roleType,
            target_id: clusterId,
            created_at: new Date().toISOString(),
          },
          { onConflict: 'user_id,role_type,target_id' }
        );

      await logSync({
        eventType: 'cluster_member_added',
        userId,
        clusterId,
        discordRoleId: cluster.discord_role_id || null,
        action: 'granted',
        success: true,
        errorMessage: 'User not linked to Discord; queued in pending_discord_roles',
      });
      return;
    }

    // 2. IF linked:
    const guild = await getClusterGuild(client, cluster);
    if (!guild) {
      await supabase
        .from('pending_discord_roles')
        .upsert(
          {
            user_id: userId,
            role_type: roleType,
            target_id: clusterId,
            created_at: new Date().toISOString(),
          },
          { onConflict: 'user_id,role_type,target_id' }
        );

      await logSync({
        eventType: 'cluster_member_added',
        userId,
        clusterId,
        discordRoleId: cluster.discord_role_id || null,
        action: 'granted',
        success: true,
        errorMessage: 'Target guild not reachable yet; queued in pending_discord_roles',
      });
      return;
    }

    // a. Fetch the guild member in that chapter's guild
    const member = guild.members.cache.get(discordUserId) ||
      (await guild.members.fetch(discordUserId).catch(() => null));

    // c. IF linked but not in this specific guild: INSERT into pending_discord_roles
    if (!member) {
      await supabase
        .from('pending_discord_roles')
        .upsert(
          {
            user_id: userId,
            role_type: roleType,
            target_id: clusterId,
            created_at: new Date().toISOString(),
          },
          { onConflict: 'user_id,role_type,target_id' }
        );

      await logSync({
        eventType: 'cluster_member_added',
        userId,
        clusterId,
        discordRoleId: cluster.discord_role_id || null,
        action: 'granted',
        success: true,
        errorMessage: 'User linked but not currently in chapter guild; queued in pending_discord_roles',
      });
      return;
    }

    // b. IF present in guild: add role(s)
    let memberRoleId = cluster.discord_role_id;
    let memberRole = memberRoleId
      ? (guild.roles.cache.get(memberRoleId) || (await guild.roles.fetch(memberRoleId).catch(() => null)))
      : null;

    if (!memberRole) {
      const clusterRoleName = `${cluster.name} Member`.toLowerCase().trim();
      memberRole = guild.roles.cache.find((r) => r.name.toLowerCase().trim() === clusterRoleName);
    }

    if (!memberRole) {
      // Ensure cluster roles and channels exist
      const setup = await handleClusterCreated(client, cluster);
      memberRole = setup?.memberRole || null;
      memberRoleId = memberRole?.id;
    } else {
      memberRoleId = memberRole.id;
      if (cluster.discord_role_id !== memberRole.id) {
        cluster.discord_role_id = memberRole.id;
        try {
          await supabase.from('clusters').update({ discord_role_id: memberRole.id }).eq('id', cluster.id);
        } catch (_) {}
      }
    }

    // Check member.roles.cache.has(roleId) first (idempotency)
    if (memberRole && !member.roles.cache.has(memberRole.id)) {
      await syncQueue.enqueueAsync('role', `${member.id}:${memberRole.id}`, async () => {
        await member.roles.add(memberRole);
      });
      console.log(`[clusterSync] Assigned member role "${memberRole.name}" to ${member.user?.tag || member.id}`);
    }

    let hostRole = null;
    if (roleInCluster === 'host') {
      hostRole = await ensureHostRole(guild, cluster.name);
      if (hostRole && !member.roles.cache.has(hostRole.id)) {
        await syncQueue.enqueueAsync('role', `${member.id}:${hostRole.id}`, async () => {
          await member.roles.add(hostRole);
        });
        console.log(`[clusterSync] Assigned host role "${hostRole.name}" to ${member.user?.tag || member.id}`);
      }
    }

    // If there was any stale pending row, clean it up
    await supabase
      .from('pending_discord_roles')
      .delete()
      .eq('user_id', userId)
      .eq('target_id', clusterId);

    await logSync({
      eventType: 'cluster_member_added',
      userId,
      clusterId,
      discordRoleId: roleInCluster === 'host' ? (hostRole?.id || memberRoleId) : memberRoleId,
      action: 'granted',
      success: true,
    });
  } catch (err) {
    console.error(`[clusterSync] handleMemberAdded failed for user ${userId} in cluster ${clusterId}:`, err.message);
    await logSync({
      eventType: 'cluster_member_added',
      userId,
      clusterId,
      action: 'granted',
      success: false,
      errorMessage: err.message,
    });
  }
}

/**
 * SECTION 5: MEMBER REMOVE (handleMemberRemoved)
 *
 * On cluster_members DELETE:
 * 1. Look up discord_id via the identity table.
 * 2. IF found and holds the role: remove it (and Host role if applicable).
 * 3. CRITICAL: also DELETE any matching pending_discord_roles row for this user_id + cluster_id combination.
 * 4. Log the revocation (or the fact that no role needed removing).
 *
 * @param {import('discord.js').Client} client
 * @param {object} memberRow
 */
async function handleMemberRemoved(client, memberRow) {
  if (!client || !memberRow) return;

  const clusterId = memberRow.cluster_id || memberRow.clusterId;
  const userId = memberRow.user_id || memberRow.userId || memberRow.member_id || memberRow.memberId || memberRow.profile_id;
  if (!clusterId || !userId) return;

  try {
    // Run pending_discord_roles deletion, discordId resolution, and cluster resolution in parallel
    const [, discordUserId, cluster] = await Promise.all([
      supabase
        .from('pending_discord_roles')
        .delete()
        .eq('user_id', userId)
        .eq('target_id', clusterId),
      resolveDiscordIdForUser(userId),
      (async () => {
        const cachedCl = clusterCache.get(clusterId);
        if (cachedCl && Date.now() < cachedCl.expiresAt) {
          return cachedCl.data;
        }
        const { data: fetched } = await supabase
          .from('clusters')
          .select('*')
          .eq('id', clusterId)
          .maybeSingle();
        if (fetched) {
          clusterCache.set(clusterId, { data: fetched, expiresAt: Date.now() + 60000 });
        }
        return fetched;
      })(),
    ]);

    let roleRevoked = false;

    const roleInCluster = memberRow.role_in_cluster || 'member';

    if (discordUserId && cluster) {
      const guild = await getClusterGuild(client, cluster);
      if (guild) {
        const member = guild.members.cache.get(discordUserId) ||
          (await guild.members.fetch(discordUserId).catch(() => null));

        if (member) {
          // 2. Remove cluster member role if held (only if not exclusively host revocation)
          if (roleInCluster !== 'host' && cluster.discord_role_id && member.roles.cache.has(cluster.discord_role_id)) {
            await syncQueue.enqueueAsync('role_remove', `${member.id}:${cluster.discord_role_id}`, async () => {
              await member.roles.remove(cluster.discord_role_id);
            });
            roleRevoked = true;
          }

          // Remove host role if held
          const hostRoleName = `${cluster.name} Host`;
          const hostRole = guild.roles.cache.find(
            (r) => r.name.toLowerCase().trim() === hostRoleName.toLowerCase().trim()
          );
          if (hostRole && member.roles.cache.has(hostRole.id)) {
            await syncQueue.enqueueAsync('role_remove', `${member.id}:${hostRole.id}`, async () => {
              await member.roles.remove(hostRole.id);
            });
            roleRevoked = true;
          }
        }
      }
    }

    // 4. Log the outcome
    await logSync({
      eventType: 'cluster_member_removed',
      userId,
      clusterId,
      discordRoleId: cluster?.discord_role_id || null,
      action: 'revoked',
      success: true,
      errorMessage: roleRevoked ? null : 'No active cluster role held in guild by user or user unlinked',
    });
  } catch (err) {
    console.error(`[clusterSync] handleMemberRemoved failed for user ${userId} in cluster ${clusterId}:`, err.message);
    await logSync({
      eventType: 'cluster_member_removed',
      userId,
      clusterId,
      action: 'revoked',
      success: false,
      errorMessage: err.message,
    });
  }
}

/**
 * SECTION 6: LINK RESOLUTION (handleUserLinked)
 *
 * On a new identity link:
 * 1. Query all pending_discord_roles for that user_id.
 * 2. For each: resolve target cluster/chapter's discord_role_id (skip and log a failure if target was archived/deleted since queuing),
 *    assign role to now-linked discord_id, delete pending row, log outcome.
 * 3. One failed row must not block processing the rest of user's pending roles — wrap each in its own try/catch.
 *
 * @param {import('discord.js').Client} client
 * @param {object} linkData - Row from discord_links or profiles
 */
async function handleUserLinked(client, linkData) {
  if (!client || !linkData) return;

  const userId = linkData.os_user_id || linkData.user_id || linkData.id;
  let discordUserId = linkData.discord_user_id;

  if (!userId) return;
  if (!discordUserId) {
    discordUserId = await resolveDiscordIdForUser(userId);
  }
  if (!discordUserId) return;

  try {
    // 1. Query all pending_discord_roles for that user_id
    const { data: pendingRoles, error: pErr } = await supabase
      .from('pending_discord_roles')
      .select('*')
      .eq('user_id', userId);

    const pendingList = (!pErr && Array.isArray(pendingRoles)) ? pendingRoles : [];

    if (pendingList.length > 0) {
      console.log(`[clusterSync] Resolving ${pendingList.length} pending Discord role(s) for user ${userId} (${discordUserId})`);

      // 2. Process each pending role independently
      for (const pending of pendingList) {
        // 3. Wrap each in its own try/catch so one failed row does not block the rest
        try {
          if (pending.role_type === 'cluster_member' || pending.role_type === 'cluster_host') {
            const clusterId = pending.target_id;
            const { data: cluster } = await supabase
              .from('clusters')
              .select('*')
              .eq('id', clusterId)
              .maybeSingle();

            // Skip and log failure if target cluster was archived or deleted since queuing
            if (!cluster || cluster.status === 'archived') {
              await logSync({
                eventType: 'pending_role_resolved',
                userId,
                clusterId,
                discordRoleId: cluster?.discord_role_id || null,
                action: 'granted',
                success: false,
                errorMessage: cluster ? 'Target cluster was archived since queuing' : 'Target cluster was deleted since queuing',
              });
              await supabase.from('pending_discord_roles').delete().eq('id', pending.id);
              continue;
            }

            const guild = await getClusterGuild(client, cluster);
            if (!guild) {
              throw new Error(`Target guild for cluster ${cluster.name || clusterId} not reachable`);
            }

            const member = guild.members.cache.get(discordUserId) ||
              (await guild.members.fetch(discordUserId).catch(() => null));

            if (!member) {
              // User linked but not yet in this chapter's guild; retain pending row until they join
              continue;
            }

            let memberRoleId = cluster.discord_role_id;
            let memberRole = memberRoleId
              ? (guild.roles.cache.get(memberRoleId) || (await guild.roles.fetch(memberRoleId).catch(() => null)))
              : null;

            if (!memberRole) {
              const clusterRoleName = `${cluster.name} Member`.toLowerCase().trim();
              memberRole = guild.roles.cache.find((r) => r.name.toLowerCase().trim() === clusterRoleName);
            }

            if (!memberRole) {
              const setup = await handleClusterCreated(client, cluster);
              memberRole = setup?.memberRole || null;
              memberRoleId = memberRole?.id;
            } else {
              memberRoleId = memberRole.id;
              if (cluster.discord_role_id !== memberRole.id) {
                cluster.discord_role_id = memberRole.id;
                try {
                  await supabase.from('clusters').update({ discord_role_id: memberRole.id }).eq('id', cluster.id);
                } catch (_) {}
              }
            }

            if (memberRole && !member.roles.cache.has(memberRole.id)) {
              await syncQueue.enqueueAsync('role', `${member.id}:${memberRole.id}`, async () => {
                await member.roles.add(memberRole);
              });
            }

            let assignedRoleId = memberRoleId;

            if (pending.role_type === 'cluster_host') {
              const hostRole = await ensureHostRole(guild, cluster.name);
              if (hostRole && !member.roles.cache.has(hostRole.id)) {
                await syncQueue.enqueueAsync('role', `${member.id}:${hostRole.id}`, async () => {
                  await member.roles.add(hostRole);
                });
                assignedRoleId = hostRole.id;
              }
            }

            // Delete the pending row and log success
            await supabase.from('pending_discord_roles').delete().eq('id', pending.id);

            await logSync({
              eventType: 'pending_role_resolved',
              userId,
              clusterId,
              discordRoleId: assignedRoleId,
              action: 'granted',
              success: true,
            });
          } else if (pending.role_type === 'chapter_role') {
            const chapterId = pending.target_id;
            const guild = await getChapterGuild(client, chapterId);
            if (guild) {
              const member = guild.members.cache.get(discordUserId) ||
                (await guild.members.fetch(discordUserId).catch(() => null));
              if (member) {
                await api.syncUserAcrossGuilds(client, discordUserId, userId);
                await supabase.from('pending_discord_roles').delete().eq('id', pending.id);
                await logSync({
                  eventType: 'pending_role_resolved',
                  userId,
                  clusterId: null,
                  action: 'granted',
                  success: true,
                });
              }
            }
          }
        } catch (innerErr) {
          console.error(`[clusterSync] Failed to resolve pending role ${pending.id} for user ${userId}:`, innerErr.message);
          await logSync({
            eventType: 'pending_role_resolved',
            userId,
            clusterId: pending.target_id,
            action: 'granted',
            success: false,
            errorMessage: innerErr.message,
          });
        }
      }
    }

    // 4. Auto-assign cluster roles for any clusters this user is already part of in OS (member_ids or cluster_members)
    try {
      const { data: memberClusters } = await supabase
        .from('clusters')
        .select('*');

      if (memberClusters) {
        for (const cluster of memberClusters) {
          if (cluster.status === 'archived') continue;
          const isMember = Array.isArray(cluster.member_ids) && cluster.member_ids.includes(userId);
          const isLeader = cluster.leader_id === userId;
          const isCreator = cluster.created_by === userId;

          if (isMember || isLeader || isCreator) {
            await handleMemberAdded(client, {
              cluster_id: cluster.id,
              user_id: userId,
              role_in_cluster: (isLeader || isCreator) ? 'host' : 'member',
            }).catch(() => {});
          }
        }
      }
    } catch (_) {}

    try {
      const { data: cmRows } = await supabase
        .from('cluster_members')
        .select('cluster_id, role_in_cluster')
        .eq('user_id', userId);

      if (cmRows) {
        for (const cm of cmRows) {
          await handleMemberAdded(client, {
            cluster_id: cm.cluster_id,
            user_id: userId,
            role_in_cluster: cm.role_in_cluster || 'member',
          }).catch(() => {});
        }
      }
    } catch (_) {}
  } catch (err) {
    console.error(`[clusterSync] handleUserLinked error for user ${userId}:`, err.message);
  }
}

/**
 * SECTION 7: ARCHIVAL (handleClusterArchived)
 *
 * On clusters status -> archived:
 * - Rename category to "[ARCHIVED] <original name>".
 * - Remove role from auto-assignment going forward (new cluster_members inserts for an archived cluster are rejected).
 * - Keep role itself and channels intact for a 30-day grace period — do not hard-delete anything at archive time.
 * - Log to discord_sync_log.
 *
 * @param {import('discord.js').Client} client
 * @param {object} clusterData
 */
async function handleClusterArchived(client, clusterData) {
  if (!client || !clusterData) return;

  const clusterId = clusterData.id;
  try {
    const { data: cluster, error } = await supabase
      .from('clusters')
      .select('*')
      .eq('id', clusterId)
      .maybeSingle();

    if (error || !cluster) return;

    const guild = await getClusterGuild(client, cluster);
    if (guild) {
      let category = null;
      if (cluster.discord_category_id) {
        category = guild.channels.cache.get(cluster.discord_category_id) ||
          (await guild.channels.fetch(cluster.discord_category_id).catch(() => null));
      }

      if (!category) {
        const clusterEmoji = getClusterEmoji(cluster);
        const categoryName = `${clusterEmoji}・${cluster.name.toUpperCase()}`;
        category = guild.channels.cache.find(
          (c) =>
            c.type === ChannelType.GuildCategory &&
            (c.name.trim().toLowerCase() === categoryName.trim().toLowerCase() ||
             c.name.toLowerCase().replace(/[^a-z0-9]/g, '') === cluster.name.toLowerCase().replace(/[^a-z0-9]/g, ''))
        );
      }

      if (category && !category.name.startsWith('[ARCHIVED]')) {
        const newCategoryName = `[ARCHIVED] ${category.name}`.slice(0, 100);
        await syncQueue.enqueueAsync('channel', `${category.id}:archive`, async () => {
          await category.setName(newCategoryName);
        });
      }
    }

    // TODO: Scheduled cleanup job to hard-delete channels and cluster role after 30-day grace period.
    // Do NOT auto-delete channels or roles immediately at archive time.

    await logSync({
      eventType: 'cluster_archived',
      clusterId: cluster.id,
      discordRoleId: cluster.discord_role_id || null,
      action: 'archived',
      success: true,
    });
  } catch (err) {
    console.error(`[clusterSync] handleClusterArchived failed for cluster ${clusterId}:`, err.message);
    await logSync({
      eventType: 'cluster_archived',
      clusterId,
      action: 'archived',
      success: false,
      errorMessage: err.message,
    });
  }
}

/**
 * SECTION 8: RECONCILIATION FUNCTION
 *
 * For a given active cluster:
 * Compares cluster_members in Supabase against actual Discord role holders in that cluster's role,
 * and corrects any drift (grants missing roles, revokes roles nobody in Supabase says they should have).
 * Logs every correction made.
/**
 * Reconciles and re-applies category permission overwrites to an existing cluster category,
 * ensuring all child channels inherit and lock permissions without stray overrides.
 *
 * @param {import('discord.js').Client} client
 * @param {object|string} clusterOrId
 * @returns {Promise<object|null>}
 */
async function reconcileClusterCategoryPermissions(client, clusterOrId) {
  if (!client || !clusterOrId) return null;

  try {
    let cluster = typeof clusterOrId === 'object' ? clusterOrId : null;
    if (!cluster || !cluster.name) {
      const clusterId = typeof clusterOrId === 'string' ? clusterOrId : clusterOrId.id;
      const { data, error } = await supabase
        .from('clusters')
        .select('*')
        .eq('id', clusterId)
        .maybeSingle();

      if (error || !data) {
        console.warn(`[reconcileClusterCategoryPermissions] Cluster ${clusterId} not found:`, error?.message);
        return null;
      }
      cluster = data;
    }

    if (cluster.status === 'archived') {
      return null;
    }

    const guild = await getClusterGuild(client, cluster);
    if (!guild) {
      return null;
    }

    const isOpen = (await isClusterOpen(cluster)) || (cluster.access_mode === 'open');
    const clusterEmoji = getClusterEmoji(cluster);
    const clusterName = cluster.name || 'Unnamed Cluster';
    const categoryName = `${clusterEmoji}・${clusterName.toUpperCase()}`;

    // Clean up any duplicate categories or duplicate channels first
    let category = await cleanupDuplicateClusterCategoriesAndChannels(guild, cluster);

    if (!category && cluster.discord_category_id) {
      category = guild.channels.cache.get(cluster.discord_category_id) ||
        (await guild.channels.fetch(cluster.discord_category_id).catch(() => null));
    }

    if (!category) {
      category = guild.channels.cache.find(
        (c) =>
          c.type === ChannelType.GuildCategory &&
          (c.name.trim().toLowerCase() === categoryName.trim().toLowerCase() ||
           c.name.toLowerCase().replace(/[^a-z0-9]/g, '') === clusterName.toLowerCase().replace(/[^a-z0-9]/g, ''))
      );
    }

    if (!category) {
      return null;
    }

    const permissionOverwrites = await buildClusterCategoryPermissions({
      guild,
      cluster,
      isOpen,
    });

    if (typeof category.permissionOverwrites?.set === 'function') {
      await category.permissionOverwrites.set(
        permissionOverwrites,
        `Reconcile cluster category permissions: enforce privacy for ${clusterName}`
      );
    }
    category.appliedOverwrites = permissionOverwrites;

    // Lock all child channels under category so they inherit category overwrites without custom bypass
    const childChannels = guild.channels.cache.filter((c) => c.parentId === category.id);
    for (const [, child] of childChannels) {
      if (typeof child.lockPermissions === 'function') {
        try {
          await child.lockPermissions();
          child.appliedOverwrites = permissionOverwrites;
        } catch (lockErr) {
          console.warn(`[reconcileClusterCategoryPermissions] Could not lock permissions for child channel ${child.name}:`, lockErr.message);
        }
      }
    }

    return {
      success: true,
      categoryId: category.id,
      overwritesCount: permissionOverwrites.length,
    };
  } catch (err) {
    console.error(`[reconcileClusterCategoryPermissions] Error reconciling category permissions for cluster:`, err.message);
    return null;
  }
}

/**
 * Reconciles membership of a cluster against clusters.member_ids and cluster_members:
 * 1. Grants `<Cluster Name> Member` role to any linked user holding membership in Supabase who lacks it in Discord.
 * 2. Revokes `<Cluster Name> Member` role from any member in Discord who is NOT in clusters.member_ids or cluster_members.
 * 3. Corrects `<Cluster Name> Host` role drift.
 *
 * @param {import('discord.js').Client} client
 * @param {string} clusterId
 * @returns {Promise<{clusterId: string, clusterName: string, granted: string[], revoked: string[]}>}
 */
async function reconcileClusterMembers(client, clusterId) {
  if (!client || !clusterId) return null;

  const result = {
    clusterId,
    clusterName: 'Unknown',
    granted: [],
    revoked: [],
  };

  try {
    const { data: cluster, error: clErr } = await supabase
      .from('clusters')
      .select('*')
      .eq('id', clusterId)
      .maybeSingle();

    if (clErr || !cluster) {
      console.warn(`[reconcileClusterMembers] Cluster ${clusterId} not found.`);
      return result;
    }

    result.clusterName = cluster.name || 'Unnamed Cluster';

    // Skip archived clusters
    if (cluster.status === 'archived') {
      return result;
    }

    const guild = await getClusterGuild(client, cluster);
    if (!guild) {
      console.warn(`[reconcileClusterMembers] No target guild for cluster ${cluster.name} (${clusterId})`);
      return result;
    }

    // Ensure member role exists
    let memberRoleId = cluster.discord_role_id;
    let memberRole = memberRoleId ? (guild.roles.cache.get(memberRoleId) || await guild.roles.fetch(memberRoleId).catch(() => null)) : null;

    if (!memberRole) {
      const memberRoleName = `${cluster.name} Member`;
      memberRole = guild.roles.cache.find(
        (r) => r.name.toLowerCase().trim() === memberRoleName.toLowerCase().trim()
      );
    }

    if (!memberRole) {
      const created = await handleClusterCreated(client, cluster);
      memberRole = created?.memberRole;
      memberRoleId = memberRole?.id;
    } else if (!cluster.discord_role_id) {
      await supabase.from('clusters').update({ discord_role_id: memberRole.id }).eq('id', cluster.id);
      memberRoleId = memberRole.id;
    }

    if (!memberRole) {
      console.error(`[reconcileClusterMembers] Could not resolve member role for ${cluster.name}`);
      return result;
    }

    // Reconcile and re-apply correct category permissions + lock child channels
    try {
      await reconcileClusterCategoryPermissions(client, cluster);
    } catch (permErr) {
      console.warn(`[reconcileClusterMembers] Could not reconcile category permissions for ${cluster.name}:`, permErr.message);
    }

    // 1. Fetch expected member user IDs from clusters.member_ids UUID[]
    const expectedUserIds = new Set();
    const hostUserIds = new Set();

    if (Array.isArray(cluster.member_ids)) {
      for (const mId of cluster.member_ids) {
        if (mId) expectedUserIds.add(mId);
      }
    }

    // Also support fallback query from cluster_members table if present
    try {
      const { data: dbMembers } = await supabase
        .from('cluster_members')
        .select('user_id, role_in_cluster')
        .eq('cluster_id', cluster.id);

      if (dbMembers) {
        for (const m of dbMembers) {
          if (m.user_id) {
            expectedUserIds.add(m.user_id);
            if (m.role_in_cluster === 'host') {
              hostUserIds.add(m.user_id);
            }
          }
        }
      }
    } catch (_) {}

    // Also include cluster.leader_id if configured
    if (cluster.leader_id) {
      expectedUserIds.add(cluster.leader_id);
      hostUserIds.add(cluster.leader_id);
    }

    // Also include cluster.created_by (creator of the cluster)
    if (cluster.created_by) {
      expectedUserIds.add(cluster.created_by);
      if (!cluster.leader_id) {
        hostUserIds.add(cluster.created_by);
      }
    }

    // Resolve expected Discord IDs in parallel
    const expectedDiscordIds = new Set();
    const hostDiscordIds = new Set();
    const userIdToDiscordMap = new Map();

    await Promise.all(
      Array.from(expectedUserIds).map(async (uId) => {
        const dId = await resolveDiscordIdForUser(uId);
        if (dId) {
          expectedDiscordIds.add(dId);
          userIdToDiscordMap.set(dId, uId);
          if (hostUserIds.has(uId)) {
            hostDiscordIds.add(dId);
          }
        }
      })
    );

    // 2. Fetch actual Discord role holders
    // In discord.js, role.members has cache of members with that role; avoid API spam if cache is populated
    if (guild.members.cache.size === 0 && typeof guild.members.fetch === 'function') {
      await guild.members.fetch().catch(() => {});
    }
    const actualRoleHolders = new Set();

    for (const [memberId, member] of guild.members.cache) {
      if (member.roles.cache.has(memberRole.id)) {
        actualRoleHolders.add(memberId);
      }
    }

    // 3. Drift Correction: Grant missing roles in parallel
    await Promise.all(
      Array.from(expectedDiscordIds).map(async (discordId) => {
        if (!actualRoleHolders.has(discordId)) {
          const member = guild.members.cache.get(discordId) ||
            (await guild.members.fetch(discordId).catch(() => null));

          if (member) {
            if (!member.roles.cache.has(memberRole.id)) {
              await syncQueue.enqueueAsync('role', `${member.id}:${memberRole.id}`, async () => {
                await member.roles.add(memberRole);
              });
              result.granted.push(discordId);

              await logSync({
                eventType: 'reconciliation_drift_corrected',
                userId: userIdToDiscordMap.get(discordId) || null,
                clusterId: cluster.id,
                discordRoleId: memberRole.id,
                action: 'granted',
                success: true,
                errorMessage: `Drift correction: granted missing cluster role to ${member.user?.tag || discordId}`,
              });
            }
          }
        }
      })
    );

    // 4. Drift Correction: Revoke excess roles in parallel
    await Promise.all(
      Array.from(actualRoleHolders).map(async (discordId) => {
        if (!expectedDiscordIds.has(discordId)) {
          const member = guild.members.cache.get(discordId) ||
            (await guild.members.fetch(discordId).catch(() => null));

          if (member && member.roles.cache.has(memberRole.id)) {
            await syncQueue.enqueueAsync('role_remove', `${member.id}:${memberRole.id}`, async () => {
              await member.roles.remove(memberRole);
            });
            result.revoked.push(discordId);

            await logSync({
              eventType: 'reconciliation_drift_corrected',
              userId: null,
              clusterId: cluster.id,
              discordRoleId: memberRole.id,
              action: 'revoked',
              success: true,
              errorMessage: `Drift correction: revoked excess cluster role from ${member.user?.tag || discordId}`,
            });
          }
        }
      })
    );

    // 5. Host role drift correction in parallel
    const hostRole = await ensureHostRole(guild, cluster.name);
    if (hostRole) {
      await Promise.all(
        Array.from(hostDiscordIds).map(async (hostDiscordId) => {
          const member = guild.members.cache.get(hostDiscordId);
          if (member && !member.roles.cache.has(hostRole.id)) {
            await syncQueue.enqueueAsync('role', `${member.id}:${hostRole.id}`, async () => {
              await member.roles.add(hostRole);
            });
          }
        })
      );

      await Promise.all(
        Array.from(guild.members.cache.values()).map(async (member) => {
          if (member.roles.cache.has(hostRole.id) && !hostDiscordIds.has(member.id)) {
            await syncQueue.enqueueAsync('role_remove', `${member.id}:${hostRole.id}`, async () => {
              await member.roles.remove(hostRole);
            });
          }
        })
      );
    }

    return result;
  } catch (err) {
    console.error(`[reconcileClusterMembers] Error reconciling cluster ${clusterId}:`, err);
    return result;
  }
}

/**
 * Reconciles all active clusters across all chapters.
 *
 * @param {import('discord.js').Client} client
 * @returns {Promise<Array<object>>}
 */
async function reconcileAllClusters(client) {
  if (!client) return [];
  console.log('[clusterSync] Starting full reconciliation for all active clusters...');

  const results = [];
  try {
    const { data: clusters, error } = await supabase
      .from('clusters')
      .select('*')
      .neq('status', 'archived');

    if (error || !clusters) {
      console.error('[reconcileAllClusters] Could not fetch clusters:', error?.message);
      return results;
    }

    for (const c of clusters) {
      // Re-apply correct category permission overwrites retroactively
      try {
        await reconcileClusterCategoryPermissions(client, c);
      } catch (permErr) {
        console.warn(`[reconcileAllClusters] Could not reconcile category permissions for cluster ${c.name || c.id}:`, permErr.message);
      }

      const res = await reconcileClusterMembers(client, c.id);
      if (res) results.push(res);
    }

    console.log(`[clusterSync] Reconciliation complete for ${results.length} active cluster(s).`);
  } catch (err) {
    console.error('[reconcileAllClusters] Fatal error during reconciliation:', err);
  }

  return results;
}

/**
 * Backwards-compatible cluster sync entrypoint.
 *
 * @param {import('discord.js').Client} client
 * @param {string} clusterId
 */
async function syncCluster(client, clusterId) {
  if (!client || !clusterId) return;
  try {
    const { data: cluster } = await supabase
      .from('clusters')
      .select('*')
      .eq('id', clusterId)
      .maybeSingle();

    if (!cluster) return;

    if (cluster.status === 'archived') {
      await handleClusterArchived(client, cluster);
      return;
    }

    const guild = await getClusterGuild(client, cluster);
    if (!guild) {
      console.warn(`[syncCluster] Target guild for cluster "${cluster.name || clusterId}" (access_mode: ${cluster.access_mode || 'invite'}, chapter: ${cluster.chapter_id}) is not provisioned or bot is not in guild. Skipping.`);
      return;
    }

    // Always run handleClusterCreated to ensure role, category permissions, child channels, and welcome embed are synced
    await handleClusterCreated(client, cluster);

    await reconcileClusterMembers(client, cluster.id);
  } catch (err) {
    console.error(`[syncCluster] Error syncing cluster ${clusterId}:`, err);
  }
}

/**
 * Synchronizes all clusters for a given chapter.
 */
async function syncChapterClusters(client, chapterIdOrIdentifier) {
  if (!client || !chapterIdOrIdentifier) return;
  try {
    let chapterId = chapterIdOrIdentifier;
    const chapter = await api.getChapterByIdentifier(chapterIdOrIdentifier);
    if (chapter) {
      chapterId = chapter.id;
    }

    const { data: clusters, error } = await supabase
      .from('clusters')
      .select('id')
      .eq('chapter_id', chapterId);

    if (error || !clusters) return;

    for (const c of clusters) {
      await syncCluster(client, c.id);
    }
  } catch (err) {
    console.error('[syncChapterClusters] Error:', err);
  }
}

/**
 * Synchronizes all clusters across all chapters.
 */
async function syncAllClusters(client) {
  if (!client) return;
  try {
    const { data: clusters, error } = await supabase
      .from('clusters')
      .select('id');

    if (error || !clusters) return;

    for (const c of clusters) {
      await syncCluster(client, c.id);
    }
  } catch (err) {
    console.error('[syncAllClusters] Error:', err);
  }
}

/**
 * Processes cluster creation logic (used for live INSERT events and boot reconciliation).
 * Runs the exact same creation steps as a live INSERT event:
 * - handleClusterCreated (creates role, category with overwrites, channels, initial members, updates discord_category_id, logs sync)
 * - initial member_ids and leader_id/created_by role assignment
 * - logs chapter event under 'cluster_activity'
 *
 * @param {import('discord.js').Client} client
 * @param {object} cluster
 * @returns {Promise<object|null>}
 */
async function processClusterInsert(client, cluster) {
  if (!client || !cluster) return null;
  const clusterId = cluster.id;

  const rawAccessMode = cluster.access_mode !== undefined ? `"${cluster.access_mode}"` : 'undefined';
  const rawChapterId = cluster.chapter_id !== undefined ? `"${cluster.chapter_id}"` : 'undefined';
  console.log(`[clusterSync] processClusterInsert: id="${cluster.id}", access_mode=${rawAccessMode}, chapter_id=${rawChapterId}`);

  // Idempotency check: Before creating ANYTHING, check if clusters.discord_category_id is already set
  if (cluster.discord_category_id) {
    console.log(`[clusterSync] Cluster ${cluster.name || cluster.id} already has a category (${cluster.discord_category_id}), skipping duplicate creation`);
    return { skipped: true, categoryId: cluster.discord_category_id };
  }

  const result = await handleClusterCreated(client, cluster);
  if (!result || result.skipped) return result;

  // Initial member_ids sync on cluster creation
  if (Array.isArray(cluster.member_ids)) {
    for (const uId of cluster.member_ids) {
      await handleMemberAdded(client, {
        cluster_id: clusterId,
        user_id: uId,
        role_in_cluster: 'member',
      }).catch((err) => console.warn(`[clusterSync] Initial member add error for ${uId}:`, err.message));
    }
  }

  // Initial leader / creator sync
  if (cluster.leader_id) {
    await handleMemberAdded(client, {
      cluster_id: clusterId,
      user_id: cluster.leader_id,
      role_in_cluster: 'host',
    }).catch((err) => console.warn(`[clusterSync] Initial leader add error for ${cluster.leader_id}:`, err.message));
  } else if (cluster.created_by) {
    await handleMemberAdded(client, {
      cluster_id: clusterId,
      user_id: cluster.created_by,
      role_in_cluster: 'host',
    }).catch((err) => console.warn(`[clusterSync] Initial creator add error for ${cluster.created_by}:`, err.message));
  }

  // Activity log in chapter if applicable
  const chapterId = cluster.chapter_id;
  if (chapterId) {
    const clusterName = cluster.name || 'Cluster';
    await api.logChapterEvent(
      client,
      chapterId,
      null,
      'cluster_created',
      {
        cluster: clusterName,
        status: cluster.status || 'active',
        change_type: 'INSERT',
      },
      'cluster_activity'
    ).catch(() => {});
  }

  return result;
}

/**
 * Reconciles unprovisioned clusters on bot startup.
 * Queries all clusters where discord_category_id IS NULL (never successfully provisioned)
 * and executes the same creation logic used for a live INSERT event for each one found.
 * Logs each one processed.
 *
 * @param {import('discord.js').Client} client
 * @returns {Promise<Array>}
 */
async function reconcileUnprovisionedClusters(client) {
  if (!client) return [];
  try {
    console.log('[ClusterReconciliation] Querying unprovisioned clusters (discord_category_id IS NULL)...');
    let query = supabase.from('clusters').select('*');
    if (typeof query.is === 'function') {
      query = query.is('discord_category_id', null);
    } else if (typeof query.filter === 'function') {
      query = query.filter('discord_category_id', 'is', null);
    } else {
      query = query.eq('discord_category_id', null);
    }

    const { data: unprovisioned, error } = await query;

    if (error) {
      console.error('[ClusterReconciliation] Error querying unprovisioned clusters:', error.message);
      return [];
    }

    if (!unprovisioned || unprovisioned.length === 0) {
      console.log('[ClusterReconciliation] No unprovisioned clusters found (all clusters provisioned).');
      return [];
    }

    console.log(`[ClusterReconciliation] Found ${unprovisioned.length} unprovisioned cluster(s). Starting reconciliation...`);
    const processed = [];

    for (const cluster of unprovisioned) {
      if (cluster.discord_category_id) {
        console.log(`[ClusterReconciliation] Cluster "${cluster.name || cluster.id}" (${cluster.id}) already has discord_category_id (${cluster.discord_category_id}), skipping duplicate creation.`);
        continue;
      }
      try {
        console.log(`[ClusterReconciliation] Processing unprovisioned cluster "${cluster.name || cluster.id}" (${cluster.id})...`);
        const result = await processClusterInsert(client, cluster);
        console.log(`[ClusterReconciliation] Successfully reconciled cluster "${cluster.name || cluster.id}" (${cluster.id}).`);
        processed.push({ cluster, result });
      } catch (err) {
        console.error(`[ClusterReconciliation] Failed to reconcile cluster "${cluster.name || cluster.id}" (${cluster.id}):`, err.message);
      }
    }

    return processed;
  } catch (err) {
    console.error('[ClusterReconciliation] Fatal error during unprovisioned cluster reconciliation:', err.message);
    return [];
  }
}

module.exports = {
  getClusterEmoji,
  sanitizeChannelName,
  logSync,
  isClusterOpen,
  getChapterGuild,
  getClusterGuild,
  handleClusterCreated,
  handleMemberAdded,
  handleMemberRemoved,
  handleUserLinked,
  handleClusterArchived,
  reconcileClusterMembers,
  reconcileAllClusters,
  syncCluster,
  syncChapterClusters,
  syncAllClusters,
  processClusterInsert,
  reconcileUnprovisionedClusters,
  reconcileClustersOnBoot: reconcileUnprovisionedClusters,
  buildClusterCategoryPermissions,
  reconcileClusterCategoryPermissions,
  isUserHqOrAdmin,
  getCreatorChapterInfo,
  isGuildMainServer,
  getMainGuild,
  cleanupDuplicateClusterCategoriesAndChannels,
  clearClusterCaches,
  invalidateClusterCache,
  setUserToDiscordCache,
  invalidateUserToDiscordCache,
};
