const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} = require('discord.js');
const supabase = require('./supabase');
const config = require('../config');
const api = require('./api');
const verifySessions = require('./verifySessions');

// Local fallback persistence directory and file
const DATA_DIR = path.join(__dirname, '../../data');
const DATA_FILE = path.join(DATA_DIR, 'tickets.json');

// Memory caches
const inMemoryTickets = new Map(); // ticketId -> ticketRecord
const threadIdToTicketMap = new Map(); // threadId -> ticketRecord
const cachedForumChannelIds = new Map(); // `${guildId}:${lane}` -> forumChannelId

// In-flight mutex locks to prevent duplicate thread creations on concurrent clicks/messages
const activeCreationLocks = new Map(); // `${userId}:${lane}` -> Promise

// Temporary in-memory pending storage for DM interactions
// userId -> { content, attachments, createdAt }
const pendingDmMessages = new Map();
// userId -> messageText (captured before lane picker modal)
const pendingIssueDescriptions = new Map();
// userId -> [{ name, url, contentType }]
const pendingInitialAttachments = new Map();
// userId -> { lane, chapterId, timestamp } (active lane selection waiting for user chat message)
const pendingLaneSelections = new Map();
// Deduplication & debouncing for staff replies
const processedStaffMessageIds = new Set();
const lastStaffRelayByTicket = new Map(); // ticketId -> { contentKey, timestamp }
const lastSolvePromptMsgByTicket = new Map(); // ticketId -> Message object

/**
 * Saves a pending attachment provided via slash command or direct interaction.
 *
 * @param {string} userId
 * @param {{ name: string, url: string, contentType?: string }} attachment
 */
function setPendingAttachment(userId, attachment) {
  if (!userId || !attachment) return;
  const list = pendingInitialAttachments.get(userId) || [];
  list.push(attachment);
  pendingInitialAttachments.set(userId, list);
}

/**
 * Lane definitions and configuration
 */
const TICKET_LANES = {
  founder: {
    key: 'founder',
    displayName: 'Founder',
    emoji: '👑',
    categoryName: 'FOUNDER TICKETS',
    forumChannelName: 'founder-tickets',
    requiresVerification: false,
    scope: 'main',
    description: 'Reach out directly to the Founders for high-level matters or strategic inquiries.',
  },
  admin: {
    key: 'admin',
    displayName: 'Admin',
    emoji: '🛡️',
    categoryName: 'ADMIN TICKETS',
    forumChannelName: 'admin-tickets',
    requiresVerification: false,
    scope: 'main',
    description: 'General support, platform administration, bot issues, and permissions.',
  },
  exec: {
    key: 'exec',
    displayName: 'Executive Member',
    emoji: '⚡',
    categoryName: 'EXECUTIVE TICKETS',
    forumChannelName: 'executive-tickets',
    requiresVerification: true,
    scope: 'chapter',
    description: 'Contact your chapter Executive Members regarding events, clusters, and local activities.',
  },
  campus_lead: {
    key: 'campus_lead',
    displayName: 'Campus Lead',
    emoji: '🎓',
    categoryName: 'CAMPUS LEAD TICKETS',
    forumChannelName: 'campus-lead-tickets',
    requiresVerification: true,
    scope: 'chapter',
    description: 'Direct, confidential channel with your Campus Lead for chapter leadership matters.',
  },
};

/**
 * Helper to get lane display name
 */
function getLaneDisplayName(lane) {
  return TICKET_LANES[lane]?.displayName || lane;
}

/**
 * Helper to get lane emoji
 */
function getLaneEmoji(lane) {
  return TICKET_LANES[lane]?.emoji || '🎫';
}

/**
 * Helper to sanitize chapterId for Supabase compatibility.
 * Founder and Admin tickets must have null chapterId (never 'global').
 * Executive and Campus Lead tickets should have a valid UUID or null.
 *
 * @param {string} lane
 * @param {string|null} chapterId
 * @returns {string|null}
 */
function sanitizeChapterId(lane, chapterId) {
  if (lane === 'founder' || lane === 'admin') return null;
  if (!chapterId || chapterId === 'global' || typeof chapterId !== 'string' || chapterId.trim() === '') {
    return null;
  }
  return chapterId.trim();
}

/**
 * Loads persisted ticket records from local disk.
 */
function loadLocalStore() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      for (const [id, rec] of Object.entries(parsed)) {
        if (id && rec) {
          rec.chapter_id = sanitizeChapterId(rec.lane, rec.chapter_id);
          inMemoryTickets.set(id, rec);
          if (rec.thread_id) {
            threadIdToTicketMap.set(rec.thread_id, rec);
          }
        }
      }
    }
  } catch (err) {
    console.warn('[ticketSystem] Could not load local tickets store:', err.message);
  }
}

/**
 * Saves current ticket records to local disk.
 */
function saveLocalStore() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const obj = Object.fromEntries(inMemoryTickets.entries());
    fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (err) {
    console.warn('[ticketSystem] Could not save local tickets store:', err.message);
  }
}

// Initialize store from disk on module load
loadLocalStore();

/**
 * Retrieves all open tickets for a given Discord user.
 *
 * @param {string} discordUserId
 * @returns {Promise<Array<object>>}
 */
async function getOpenTicketsForUser(discordUserId) {
  if (!discordUserId) return [];

  const map = new Map();

  // Query Supabase for active tickets
  try {
    const { data, error } = await supabase
      .from('discord_tickets')
      .select('*')
      .eq('discord_user_id', discordUserId)
      .eq('status', 'open')
      .order('created_at', { ascending: false });

    if (!error && Array.isArray(data)) {
      for (const rec of data) {
        rec.chapter_id = sanitizeChapterId(rec.lane, rec.chapter_id);
        inMemoryTickets.set(rec.id, rec);
        if (rec.thread_id) threadIdToTicketMap.set(rec.thread_id, rec);
        map.set(rec.id, rec);
      }
      saveLocalStore();
    }
  } catch (err) {
    console.warn(`[ticketSystem] Supabase query open tickets error for ${discordUserId}:`, err.message);
  }

  // Fallback / merge with in-memory store so active tickets in memory are not lost
  for (const [, rec] of inMemoryTickets) {
    if (rec.discord_user_id === discordUserId && rec.status === 'open') {
      if (!map.has(rec.id)) {
        map.set(rec.id, rec);
      }
    }
  }

  return Array.from(map.values()).sort(
    (a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)
  );
}

/**
 * Retrieves an open ticket for a user in a specific lane (at most one open per user per lane).
 *
 * @param {string} discordUserId
 * @param {string} lane
 * @returns {Promise<object|null>}
 */
async function getOpenTicketForUserAndLane(discordUserId, lane) {
  if (!discordUserId || !lane) return null;

  try {
    const { data, error } = await supabase
      .from('discord_tickets')
      .select('*')
      .eq('discord_user_id', discordUserId)
      .eq('lane', lane)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!error && data) {
      data.chapter_id = sanitizeChapterId(data.lane, data.chapter_id);
      inMemoryTickets.set(data.id, data);
      if (data.thread_id) threadIdToTicketMap.set(data.thread_id, data);
      saveLocalStore();
      return data;
    }
  } catch (err) {
    console.warn(`[ticketSystem] Supabase query ticket error (${discordUserId}, ${lane}):`, err.message);
  }

  // Fallback to in-memory store
  for (const [, rec] of inMemoryTickets) {
    if (rec.discord_user_id === discordUserId && rec.lane === lane && rec.status === 'open') {
      return rec;
    }
  }
  return null;
}

/**
 * Retrieves the latest ticket record for a user in a specific lane (open or closed).
 * Used to maintain one permanent post per user per lane so follow-ups reuse the same post.
 *
 * @param {string} discordUserId
 * @param {string} lane
 * @param {string|null} [chapterId=null]
 * @returns {Promise<object|null>}
 */
async function getLatestTicketForUserAndLane(discordUserId, lane, chapterId = null) {
  if (!discordUserId || !lane) return null;
  const sanitizedChapterId = sanitizeChapterId(lane, chapterId);

  try {
    let query = supabase
      .from('discord_tickets')
      .select('*')
      .eq('discord_user_id', discordUserId)
      .eq('lane', lane);

    if (lane === 'exec' || lane === 'campus_lead') {
      if (sanitizedChapterId) {
        query = query.eq('chapter_id', sanitizedChapterId);
      }
    }

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!error && data) {
      data.chapter_id = sanitizeChapterId(data.lane, data.chapter_id);
      inMemoryTickets.set(data.id, data);
      if (data.thread_id) threadIdToTicketMap.set(data.thread_id, data);
      saveLocalStore();
      return data;
    }
  } catch (err) {
    console.warn(`[ticketSystem] Supabase query latest ticket error (${discordUserId}, ${lane}):`, err.message);
  }

  // Fallback to in-memory store
  let latest = null;
  for (const [, rec] of inMemoryTickets) {
    if (rec.discord_user_id === discordUserId && rec.lane === lane) {
      if (lane === 'founder' || lane === 'admin') {
        if (!latest || new Date(rec.created_at || 0) > new Date(latest.created_at || 0)) {
          latest = rec;
        }
      } else {
        const recChapter = sanitizeChapterId(rec.lane, rec.chapter_id);
        if (!sanitizedChapterId || recChapter === sanitizedChapterId) {
          if (!latest || new Date(rec.created_at || 0) > new Date(latest.created_at || 0)) {
            latest = rec;
          }
        }
      }
    }
  }
  return latest;
}

/**
 * Retrieves a ticket record by its Discord Forum thread ID.
 *
 * @param {string} threadId
 * @returns {Promise<object|null>}
 */
async function getTicketByThreadId(threadId) {
  if (!threadId) return null;

  if (threadIdToTicketMap.has(threadId)) {
    return threadIdToTicketMap.get(threadId);
  }

  try {
    const { data, error } = await supabase
      .from('discord_tickets')
      .select('*')
      .eq('thread_id', threadId)
      .maybeSingle();

    if (!error && data) {
      data.chapter_id = sanitizeChapterId(data.lane, data.chapter_id);
      inMemoryTickets.set(data.id, data);
      threadIdToTicketMap.set(threadId, data);
      saveLocalStore();
      return data;
    }
  } catch (err) {
    console.warn(`[ticketSystem] Supabase query ticket by thread ${threadId}:`, err.message);
  }

  for (const [, rec] of inMemoryTickets) {
    if (rec.thread_id === threadId) return rec;
  }

  return null;
}

/**
 * Inserts a new ticket record into Supabase and updates in-memory / local storage.
 *
 * @param {object} params
 * @param {string} params.discordUserId
 * @param {'founder'|'admin'|'exec'|'campus_lead'} params.lane
 * @param {string|null} [params.chapterId=null]
 * @param {string} params.forumChannelId
 * @param {string} params.threadId
 * @returns {Promise<object>}
 */
async function createTicketRecord({ discordUserId, lane, chapterId = null, forumChannelId, threadId }) {
  const sanitizedChapterId = sanitizeChapterId(lane, chapterId);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const record = {
    id,
    discord_user_id: discordUserId,
    lane,
    chapter_id: sanitizedChapterId,
    forum_channel_id: forumChannelId,
    thread_id: threadId,
    status: 'open',
    created_at: now,
    closed_at: null,
    last_message_at: now,
  };

  inMemoryTickets.set(id, record);
  threadIdToTicketMap.set(threadId, record);
  saveLocalStore();

  try {
    const { data, error } = await supabase
      .from('discord_tickets')
      .insert({
        id,
        discord_user_id: discordUserId,
        lane,
        chapter_id: sanitizedChapterId,
        forum_channel_id: forumChannelId,
        thread_id: threadId,
        status: 'open',
        created_at: now,
        last_message_at: now,
      })
      .select()
      .maybeSingle();

    if (error) {
      console.error('[ticketSystem] Supabase error inserting ticket:', error.message);
    } else if (data) {
      data.chapter_id = sanitizeChapterId(data.lane, data.chapter_id);
      inMemoryTickets.set(data.id, data);
      threadIdToTicketMap.set(threadId, data);
      saveLocalStore();
      return data;
    }
  } catch (err) {
    console.error('[ticketSystem] Exception inserting ticket into Supabase:', err.message);
  }

  return record;
}

/**
 * Updates a ticket record in Supabase and local cache.
 *
 * @param {string} ticketId
 * @param {object} updates
 * @returns {Promise<object>}
 */
async function updateTicketRecord(ticketId, updates) {
  const existing = inMemoryTickets.get(ticketId) || {};
  const cleanedUpdates = { ...updates };
  if (cleanedUpdates.chapter_id !== undefined) {
    const lane = cleanedUpdates.lane || existing.lane;
    cleanedUpdates.chapter_id = sanitizeChapterId(lane, cleanedUpdates.chapter_id);
  }

  const updated = { ...existing, ...cleanedUpdates, id: ticketId };

  inMemoryTickets.set(ticketId, updated);
  if (updated.thread_id) {
    threadIdToTicketMap.set(updated.thread_id, updated);
  }
  saveLocalStore();

  try {
    const { data, error } = await supabase
      .from('discord_tickets')
      .update(cleanedUpdates)
      .eq('id', ticketId)
      .select()
      .maybeSingle();

    if (error) {
      console.error(`[ticketSystem] Supabase error updating ticket ${ticketId}:`, error.message);
    } else if (data) {
      data.chapter_id = sanitizeChapterId(data.lane, data.chapter_id);
      inMemoryTickets.set(ticketId, data);
      if (data.thread_id) threadIdToTicketMap.set(data.thread_id, data);
      saveLocalStore();
      return data;
    }
  } catch (err) {
    console.error(`[ticketSystem] Exception updating ticket ${ticketId} in Supabase:`, err.message);
  }

  return updated;
}

/**
 * Marks a ticket as closed and archives it.
 *
 * @param {string} ticketId
 * @param {string} [reason='closed']
 * @returns {Promise<object>}
 */
async function closeTicketRecord(ticketId, reason = 'closed') {
  const now = new Date().toISOString();
  return updateTicketRecord(ticketId, {
    status: 'closed',
    closed_at: now,
    last_message_at: now,
  });
}

/**
 * Verifies if a guild member is authorized for a specific ticket lane.
 * Follows the existing OS-role -> Discord-permission mapping:
 * - Founder: Founders + bot only
 * - Admin: Admins + bot only
 * - Executive Team (chapter): chapter Executive Team + Campus Lead + bot
 * - Campus Lead (chapter): chapter Campus Lead + bot (Executive Team CANNOT see Campus-Lead-only)
 *
 * @param {import('discord.js').GuildMember} member
 * @param {'founder'|'admin'|'exec'|'campus_lead'} lane
 * @param {string|null} [chapterId=null]
 * @param {import('discord.js').Client} [client=null]
 * @returns {Promise<boolean>}
 */
async function isUserAuthorizedForLane(member, lane, chapterId = null, client = null) {
  if (!member) return false;

  // Bot itself is always authorized
  if (member.id === client?.user?.id || member.user?.bot) return true;

  // Resolve ElevatesOS identity
  let identity = null;
  try {
    identity = await api.getIdentityByDiscordId(member.id);
  } catch (_) {}

  const profile = identity?.profile || null;
  const userRoles = identity?.userRoles || [];
  const profileRole = (profile?.role || '').toLowerCase().trim();
  const profileDesignation = (profile?.designation || '').toLowerCase().trim();

  // Normalize all user's OS role keys
  const osRoleKeys = new Set();
  if (profileRole) osRoleKeys.add(profileRole);
  if (profileDesignation) osRoleKeys.add(profileDesignation);
  for (const r of userRoles) {
    const k = (r.role_key || r.role || '').toLowerCase().trim();
    if (k) osRoleKeys.add(k);
    if (r.roles?.key) osRoleKeys.add(r.roles.key.toLowerCase().trim());
  }

  // Guild roles on this member
  const memberRoleNames = member.roles?.cache
    ? Array.from(member.roles.cache.values()).map((r) => r.name.toLowerCase().trim())
    : [];

  const isServerOwner = member.guild?.ownerId === member.id;
  const isDiscordAdmin = member.permissions?.has(PermissionFlagsBits.Administrator);

  // 1. FOUNDER LANE
  if (lane === 'founder') {
    if (osRoleKeys.has('founder')) return true;
    if (memberRoleNames.some((n) => n === 'founder' || n === 'elevates • founder' || n === (config.roles?.founder || '').toLowerCase())) {
      return true;
    }
    // Safety fallback for main guild owner
    if (isServerOwner && member.guild.id === config.mainGuildId) return true;
    return false;
  }

  // 2. ADMIN LANE
  if (lane === 'admin') {
    if (osRoleKeys.has('hq_admin') || osRoleKeys.has('admin')) return true;
    if (memberRoleNames.some((n) => n === 'hq admin' || n === 'admin' || n === 'elevates • admin' || n === (config.roles?.admin || '').toLowerCase())) {
      return true;
    }
    // Safety fallback for main guild owner
    if (isServerOwner && member.guild.id === config.mainGuildId) return true;
    return false;
  }

  // 3. CAMPUS LEAD LANE (Chapter Server)
  // Visible ONLY to that chapter's Campus Lead + bot (Executive Team must NOT see Campus Lead tickets)
  if (lane === 'campus_lead') {
    // Check chapter's assigned campus_lead_id
    if (chapterId && profile?.id) {
      try {
        const chapter = await api.getChapterByIdentifier(chapterId);
        if (chapter && (chapter.campus_lead_id === profile.id || chapter.campus_lead_id === identity.userId)) {
          return true;
        }
      } catch (_) {}
    }

    // Check guild_config campus_lead_discord_id
    if (member.guild) {
      try {
        const guildConfig = await api.getGuildConfig(member.guild.id);
        if (guildConfig) {
          if (guildConfig.campusLeadDiscordId === member.id || guildConfig.campus_lead_discord_id === member.id) {
            return true;
          }
          if (profile?.id && (guildConfig.campusLeadId === profile.id || guildConfig.campus_lead_id === profile.id)) {
            return true;
          }
        }
      } catch (_) {}
    }

    // Check chapter server guild roles for Campus Lead
    const campusLeadRoleName = (config.roles?.campusLead || 'Campus Lead').toLowerCase().trim();
    if (memberRoleNames.some((n) => n === campusLeadRoleName || n === 'campus lead')) {
      return true;
    }

    // Check OS roles: campus_lead for this chapter
    const isLeadForThisChapter = userRoles.some(
      (r) =>
        (r.role_key || r.role || '').toLowerCase().trim() === 'campus_lead' &&
        (!chapterId || !r.chapter_id || r.chapter_id === chapterId)
    );
    if (isLeadForThisChapter) return true;

    // Safety fallback: chapter guild owner
    if (isServerOwner) return true;

    return false;
  }

  // 4. EXECUTIVE TEAM LANE (Chapter Server)
  // Visible to that chapter's Executive Members + Campus Lead + bot
  if (lane === 'exec') {
    // Campus Lead is always authorized for Executive Member tickets
    const isLead = await isUserAuthorizedForLane(member, 'campus_lead', chapterId, client);
    if (isLead) return true;

    // Check if member has Executive Member / Team roles in Discord
    const execRolePatterns = [
      'executive member',
      'executive team',
      'executive',
      'core team',
      'vice lead',
      'tech lead',
      'co-lead',
      'head',
      'coordinator',
      'manager',
      'class rep',
      'class representative',
    ];

    if (memberRoleNames.some((n) => execRolePatterns.some((pattern) => n.includes(pattern)))) {
      return true;
    }

    // Check OS user_roles for this chapter
    const hasChapterExecRole = userRoles.some((r) => {
      const k = (r.role_key || r.role || '').toLowerCase().trim();
      const isChapterMatch = !chapterId || !r.chapter_id || r.chapter_id === chapterId;
      if (!isChapterMatch) return false;
      return (
        k === 'exec' ||
        k === 'executive' ||
        k === 'executive_member' ||
        k === 'exec_member' ||
        k === 'executive_team' ||
        k === 'core_team' ||
        k.includes('lead') ||
        k.includes('head') ||
        k.includes('coordinator') ||
        k.includes('manager') ||
        k.includes('rep')
      );
    });

    if (hasChapterExecRole) return true;

    return false;
  }

  return false;
}

/**
 * Resolves which Discord Guild a ticket belongs to:
 * - Founder / Admin: Main Server
 * - Executive Team / Campus Lead: Chapter Server
 *
 * @param {import('discord.js').Client} client
 * @param {'founder'|'admin'|'exec'|'campus_lead'} lane
 * @param {string|null} [chapterId=null]
 * @returns {Promise<import('discord.js').Guild|null>}
 */
async function resolveGuildForLane(client, lane, chapterId = null) {
  if (!client) return null;

  // Main server lanes
  if (lane === 'founder' || lane === 'admin') {
    const mainConfig = await api.getMainGuildConfig().catch(() => null);
    const targetGuildId = mainConfig?.guildId || config.mainGuildId;
    let mainGuild = null;

    if (targetGuildId) {
      mainGuild =
        client.guilds.cache.get(targetGuildId) ||
        (await client.guilds.fetch(targetGuildId).catch(() => null));
    }

    if (!mainGuild) {
      mainGuild = client.guilds.cache.first();
    }

    return mainGuild;
  }

  // Chapter server lanes
  if (chapterId) {
    try {
      const { data: guildRow } = await supabase
        .from('guild_config')
        .select('*')
        .eq('chapter_id', chapterId)
        .eq('guild_type', 'chapter')
        .maybeSingle();

      if (guildRow?.guild_id) {
        const guild =
          client.guilds.cache.get(guildRow.guild_id) ||
          (await client.guilds.fetch(guildRow.guild_id).catch(() => null));
        if (guild) return guild;
      }
    } catch (err) {
      console.warn(`[ticketSystem] Error finding guild_config for chapter ${chapterId}:`, err.message);
    }

    // Fallback: search client guilds cache where chapter matches
    for (const [, g] of client.guilds.cache) {
      const gConfig = await api.getGuildConfig(g.id).catch(() => null);
      if (gConfig?.chapterId === chapterId || gConfig?.chapter_id === chapterId) {
        return g;
      }
    }
  }

  return null;
}

/**
 * Ensures the category and dedicated forum channel exist for a specific lane in a guild,
 * with strict role-based private permissions:
 * - Founder forum: Founders + bot only
 * - Admin forum: Admins + bot only
 * - Executive Team forum: Executive Team + Campus Lead + bot
 * - Campus Lead forum: Campus Lead + bot (Executive Team denied)
 *
 * @param {import('discord.js').Guild} guild
 * @param {'founder'|'admin'|'exec'|'campus_lead'} lane
 * @param {object|null} [chapter=null]
 * @returns {Promise<import('discord.js').ForumChannel|import('discord.js').TextChannel|null>}
 */
async function ensureTicketForum(guild, lane, chapter = null) {
  if (!guild) return null;

  const laneDef = TICKET_LANES[lane];
  if (!laneDef) return null;

  const cacheKey = `${guild.id}:${lane}`;
  if (cachedForumChannelIds.has(cacheKey)) {
    const chId = cachedForumChannelIds.get(cacheKey);
    const existing =
      guild.channels.cache.get(chId) ||
      (await guild.channels.fetch(chId).catch(() => null));
    if (existing) return existing;
  }

  // Make sure channels and roles caches are refreshed
  await guild.channels.fetch().catch(() => {});
  await guild.roles.fetch().catch(() => {});

  const categoryName = laneDef.categoryName;
  const channelName = laneDef.forumChannelName;

  // 1. Build private permission overwrites based on lane and server roles
  const permissionOverwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: guild.client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.SendMessagesInThreads,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.CreatePrivateThreads,
        PermissionFlagsBits.ManageThreads,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
      ],
    },
  ];

  if (lane === 'founder') {
    // Only Founders + bot
    const founderRole = guild.roles.cache.find((r) =>
      ['founder', 'elevates • founder', (config.roles?.founder || '').toLowerCase()].includes(
        r.name.toLowerCase().trim()
      )
    );
    if (founderRole) {
      permissionOverwrites.push({
        id: founderRole.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.SendMessagesInThreads,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
        ],
      });
    }
  } else if (lane === 'admin') {
    // Only Admins + bot
    const adminRole = guild.roles.cache.find((r) =>
      ['hq admin', 'admin', 'elevates • admin', (config.roles?.admin || '').toLowerCase()].includes(
        r.name.toLowerCase().trim()
      )
    );
    if (adminRole) {
      permissionOverwrites.push({
        id: adminRole.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.SendMessagesInThreads,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
        ],
      });
    }
  } else if (lane === 'campus_lead') {
    // Campus Lead + bot ONLY. Executive Team is explicitly denied.
    const campusLeadRole = guild.roles.cache.find((r) =>
      r.name.toLowerCase().trim() === (config.roles?.campusLead || 'campus lead').toLowerCase()
    );
    if (campusLeadRole) {
      permissionOverwrites.push({
        id: campusLeadRole.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.SendMessagesInThreads,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
        ],
      });
    }

    // Deny Executive Member / Executive Team roles if they exist in the server
    const execRoles = guild.roles.cache.filter((r) =>
      ['executive member', 'executive team', 'executive', 'core team'].includes(r.name.toLowerCase().trim())
    );
    for (const [, r] of execRoles) {
      permissionOverwrites.push({
        id: r.id,
        deny: [PermissionFlagsBits.ViewChannel],
      });
    }
  } else if (lane === 'exec') {
    // Executive Member + Campus Lead + bot
    const campusLeadRole = guild.roles.cache.find((r) =>
      r.name.toLowerCase().trim() === (config.roles?.campusLead || 'campus lead').toLowerCase()
    );
    if (campusLeadRole) {
      permissionOverwrites.push({
        id: campusLeadRole.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.SendMessagesInThreads,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
        ],
      });
    }

    // Find or create Executive Member role if missing in chapter server
    let execRoles = guild.roles.cache.filter((r) =>
      ['executive member', 'executive team', 'executive', 'core team'].includes(r.name.toLowerCase().trim())
    );
    if (execRoles.size === 0 && guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      try {
        const createdRole = await guild.roles.create({
          name: 'Executive Member',
          color: 0x3B82F6,
          reason: 'Elevates chapter Executive Member ticket access',
        });
        execRoles = guild.roles.cache.filter((r) => r.id === createdRole.id);
      } catch (_) {}
    }

    for (const [, r] of execRoles) {
      permissionOverwrites.push({
        id: r.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.SendMessagesInThreads,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
        ],
      });
    }
  }

  // 2. Ensure Category exists
  let category = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name.toUpperCase() === categoryName.toUpperCase()
  );

  if (!category) {
    try {
      category = await guild.channels.create({
        name: categoryName,
        type: ChannelType.GuildCategory,
        permissionOverwrites,
        reason: `Ticket category for ${laneDef.displayName} lane`,
      });
    } catch (catErr) {
      console.warn(`[ticketSystem] Failed to create category ${categoryName}:`, catErr.message);
    }
  }

  // 3. Locate or create Forum channel
  let forumChannel = guild.channels.cache.find(
    (c) =>
      c.name === channelName &&
      (c.type === ChannelType.GuildForum || c.type === ChannelType.GuildText) &&
      (!category || c.parentId === category.id)
  );

  if (!forumChannel) {
    const topic = `Elevates ${laneDef.displayName} Tickets (${laneDef.description})`;
    try {
      forumChannel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildForum,
        parent: category ? category.id : undefined,
        topic,
        permissionOverwrites,
        reason: `Dedicated forum for ${laneDef.displayName} tickets`,
      });
    } catch (forumErr) {
      console.warn(`[ticketSystem] GuildForum creation failed, falling back to GuildText:`, forumErr.message);
      try {
        forumChannel = await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          parent: category ? category.id : undefined,
          topic,
          permissionOverwrites,
          reason: `Dedicated fallback channel for ${laneDef.displayName} tickets`,
        });
      } catch (textErr) {
        console.error(`[ticketSystem] Failed to create channel ${channelName}:`, textErr.message);
        return null;
      }
    }
  }

  if (forumChannel) {
    cachedForumChannelIds.set(cacheKey, forumChannel.id);
    console.log(`[ticketSystem] Ready forum #${forumChannel.name} (${forumChannel.id}) for lane [${lane}] in guild "${guild.name}"`);
  }

  return forumChannel;
}

/**
 * Initializes Main Server ticket forums on bot startup.
 *
 * @param {import('discord.js').Client} client
 */
async function ensureAllMainTicketForums(client) {
  const mainGuild = await resolveGuildForLane(client, 'founder');
  if (!mainGuild) {
    console.warn('[ticketSystem] Main guild could not be resolved on startup.');
    return;
  }
  await ensureTicketForum(mainGuild, 'founder');
  await ensureTicketForum(mainGuild, 'admin');
}

/**
 * Builds the 4-button lane picker ActionRow.
 * Options: Founder, Admin, Campus Lead, Executive Member
 *
 * @returns {ActionRowBuilder<ButtonBuilder>}
 */
function createLanePickerRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('ticket_lane_founder')
      .setLabel('Founder')
      .setEmoji('👑')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('ticket_lane_admin')
      .setLabel('Admin')
      .setEmoji('🛡️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('ticket_lane_campus_lead')
      .setLabel('Campus Lead')
      .setEmoji('🎓')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('ticket_lane_exec')
      .setLabel('Executive Member')
      .setEmoji('⚡')
      .setStyle(ButtonStyle.Secondary)
  );
}

/**
 * Sends the ticket lane picker message.
 *
 * @param {import('discord.js').User|import('discord.js').CommandInteraction} target
 * @param {string} [customText]
 */
async function sendLanePicker(target, customText = null) {
  const description =
    customText ||
    'Please select the appropriate team to assist with your inquiry:\n\n' +
    '• 👑 **Founder** — High-level strategic matters and organization leadership\n' +
    '• 🛡️ **Admin** — ElevatesOS platform administration, bot issues, and permissions\n' +
    '• 🎓 **Campus Lead** — Confidential leadership matters with your Campus Lead *(requires linked account)*\n' +
    '• ⚡ **Executive Member** — Chapter events, cluster activities, and local operations *(requires linked account)*\n\n' +
    '📎 *You can include links or attachments in your ticket, or drop files directly in this chat anytime.*';

  const embed = new EmbedBuilder()
    .setColor(0xFF6B00)
    .setTitle('🎫 Elevates Support Portal')
    .setDescription(description)
    .setFooter({ text: 'ElevatesOS Support • Select a category below' });

  const row = createLanePickerRow();

  if (typeof target.isRepliable === 'function' && target.isRepliable()) {
    return target.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
  }

  if (typeof target.reply === 'function') {
    return target.reply({ embeds: [embed], components: [row] });
  }

  if (typeof target.send === 'function') {
    return target.send({ embeds: [embed], components: [row] });
  }

  return null;
}

/**
 * Handles incoming Direct Messages to the bot.
 * Entry Point (Section 1):
 * - If user has no open tickets OR types /ticket: show 4-button row
 * - If user has exactly one open ticket and just DMs plain text: route straight into thread
 * - If user has >1 open tickets and just DMs plain text: ask which ticket this message is for
 *
 * @param {import('discord.js').Message} message
 */
async function handleIncomingDm(message) {
  if (!message || message.guild || message.author.bot) return;

  console.log(`[ticketSystem] DM from ${message.author.tag} (${message.author.id}): "${message.content}"`);

  // Guard: do not intercept active OTP account-verification sessions
  if (verifySessions.get(message.author.id)) {
    return;
  }

  const trimmed = (message.content || '').trim();
  const isExplicitTicketCommand = trimmed.toLowerCase() === '/ticket' || trimmed.toLowerCase().startsWith('/ticket ');

  // Fetch all currently open tickets for this user
  const openTickets = await getOpenTicketsForUser(message.author.id);

  // 1. Explicit /ticket in DM: ALWAYS show the full lane picker
  if (isExplicitTicketCommand) {
    return sendLanePicker(message, 'Choose a lane below to open a new support ticket:');
  }

  // 2. Exactly one open ticket AND plain text DM: route straight into that ticket's thread
  if (openTickets.length === 1) {
    const ticket = openTickets[0];
    return appendUserMessageToTicket(message, ticket);
  }

  // 3. More than one open ticket AND plain text DM: ask which open ticket this message is for
  if (openTickets.length > 1) {
    // Store pending message so it can be forwarded upon selection
    pendingDmMessages.set(message.author.id, {
      content: message.content,
      attachments: Array.from(message.attachments.values()).map((a) => a.url),
      messageId: message.id,
      timestamp: Date.now(),
    });

    const routeButtons = openTickets.map((t) => {
      const laneDef = TICKET_LANES[t.lane];
      return new ButtonBuilder()
        .setCustomId(`ticket_route_${t.id}`)
        .setLabel(`${laneDef?.displayName || t.lane} Ticket`)
        .setEmoji(laneDef?.emoji || '🎫')
        .setStyle(ButtonStyle.Primary);
    });

    const routeRow = new ActionRowBuilder().addComponents(routeButtons);

    const embed = new EmbedBuilder()
      .setColor(0x3B82F6)
      .setTitle('📬 Route Your Message')
      .setDescription(
        `You currently have **${openTickets.length} open tickets**.\n` +
        'Please select which ticket this message is for:'
      )
      .setFooter({ text: 'Click an option to forward your message' });

    return message.reply({ embeds: [embed], components: [routeRow] });
  }

  // 4. User has an active lane selection (clicked a lane button and is now chatting like normal Discord):
  const pendingLane = pendingLaneSelections.get(message.author.id);
  if (pendingLane) {
    pendingLaneSelections.delete(message.author.id);
    const attachments = Array.from(message.attachments.values()).map((a) => ({
      name: a.name,
      url: a.url,
      contentType: a.contentType,
    }));
    if (typeof message.react === 'function') {
      await message.react('✅').catch(() => {});
    }
    return createOrReopenTicket(
      message.client,
      message.author,
      pendingLane.lane,
      pendingLane.chapterId,
      message.content || '*(Attachment only)*',
      attachments
    );
  }

  // 5. No open tickets: save pending description and attachments, then show 4 lane options
  if (trimmed.length > 0) {
    pendingIssueDescriptions.set(message.author.id, trimmed);
  }
  if (message.attachments?.size > 0) {
    pendingInitialAttachments.set(
      message.author.id,
      Array.from(message.attachments.values()).map((a) => ({
        name: a.name,
        url: a.url,
        contentType: a.contentType,
      }))
    );
  }

  return sendLanePicker(message);
}

/**
 * Appends a user's follow-up DM message to an active ticket's forum thread.
 *
 * @param {import('discord.js').Message} message
 * @param {object} ticket
 */
async function appendUserMessageToTicket(message, ticket) {
  try {
    const thread =
      message.client.channels.cache.get(ticket.thread_id) ||
      (await message.client.channels.fetch(ticket.thread_id).catch(() => null));

    if (!thread) {
      console.warn(`[ticketSystem] Ticket thread ${ticket.thread_id} not found in Discord.`);
      return message.reply(
        '⚠️ Your ticket thread could not be located. It may have been closed or deleted. Use `/ticket` to open a new one.'
      );
    }

    // Unarchive thread if Discord auto-archived it
    if (thread.archived) {
      await thread.setArchived(false).catch(() => {});
    }

    const authorIcon = typeof message.author.displayAvatarURL === 'function'
      ? message.author.displayAvatarURL()
      : undefined;

    const embed = new EmbedBuilder()
      .setColor(0x3B82F6)
      .setAuthor({
        name: `${message.author.displayName || message.author.username} (${message.author.tag})`,
        iconURL: authorIcon,
      })
      .setTitle('📩 User Reply')
      .setDescription(message.content || '*(Attachment only)*')
      .setFooter({ text: `Ticket ID: ${ticket.id} • Lane: ${getLaneDisplayName(ticket.lane)}` })
      .setTimestamp(message.createdAt);

    const payload = { embeds: [embed] };
    if (message.attachments.size > 0) {
      const attachmentsList = Array.from(message.attachments.values());
      const links = attachmentsList
        .map((a) => `[${a.name || 'Attachment'}](${a.url})`)
        .join('\n');
      embed.addFields({ name: '📎 Attachments', value: links });

      const firstImg = attachmentsList.find((a) => {
        const ct = a.contentType || '';
        return ct.startsWith('image/') || /\.(png|jpe?g|webp|gif)($|\?)/i.test(a.name || a.url);
      });
      if (firstImg) {
        embed.setImage(firstImg.url);
      }

      payload.files = attachmentsList.map((a) => a.url);
    }

    await thread.send(payload);
    if (typeof message.react === 'function') {
      await message.react('✅').catch(() => {});
    }

    // Update last message timestamp
    await updateTicketRecord(ticket.id, {
      last_message_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`[ticketSystem] Error forwarding user message to thread ${ticket.thread_id}:`, err);
    if (typeof message.reply === 'function') {
      await message.reply('⚠️ Failed to deliver your message to the support thread. Please try again shortly.').catch(() => {});
    }
  }
}

/**
 * Handles the selection of a lane from the lane picker buttons:
 * - Founder / Admin: opens modal directly (no verification)
 * - Executive Team / Campus Lead: verifies linked OS account and chapter;
 *   if not linked, informs user to link first and halts.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {'founder'|'admin'|'exec'|'campus_lead'} lane
 */
async function handleLaneButtonClick(interaction, lane) {
  const laneDef = TICKET_LANES[lane];
  if (!laneDef) return;

  // 1. Check if user already has an open ticket in this lane
  const existingTicket = await getOpenTicketForUserAndLane(interaction.user.id, lane);
  if (existingTicket) {
    const msg =
      `⚠️ You already have an open ticket in the **${laneDef.displayName}** category.\n` +
      'You can only have one open ticket per lane at a time. Please reply directly in this DM to follow up on your existing ticket.';
    if (!interaction.replied && !interaction.deferred) {
      return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
    } else {
      return interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral });
    }
  }

  // 2. Verification check for Chapter lanes (Executive Team & Campus Lead)
  let resolvedChapterId = null;
  if (laneDef.requiresVerification) {
    let identity = null;
    try {
      identity = await api.getIdentityByDiscordId(interaction.user.id);
    } catch (_) {}

    if (!identity || !identity.profile) {
      const linkEmbed = new EmbedBuilder()
        .setColor(0xEF4444)
        .setTitle('🔒 ElevatesOS Account Linking Required')
        .setDescription(
          `Opening a ticket for **${laneDef.displayName}** routes directly to your local chapter team.\n\n` +
          'Please connect your ElevatesOS account first so we can identify your chapter:\n' +
          '• Run `/connect` in DM or any server\n' +
          '• Or click **🔗 Connect Account** in your chapter’s `#link-server` channel.'
        )
        .setFooter({ text: 'ElevatesOS Identity Verification' });

      if (!interaction.replied && !interaction.deferred) {
        return interaction.reply({ embeds: [linkEmbed], flags: MessageFlags.Ephemeral });
      } else {
        return interaction.followUp({ embeds: [linkEmbed], flags: MessageFlags.Ephemeral });
      }
    }

    const chapterId = identity.chapterId || identity.chapter_id || identity.profile?.chapter_id;
    if (!chapterId) {
      const msg =
        '⚠️ Your linked ElevatesOS account is not currently assigned to an active chapter.\n' +
        'Please join a chapter on ElevatesOS, or contact **Founder** / **Admin** support for help.';
      if (!interaction.replied && !interaction.deferred) {
        return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
      } else {
        return interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral });
      }
    }

    const chapterObj = await api.getChapterByIdentifier(chapterId);
    if (!chapterObj) {
      const msg = '⚠️ Could not resolve your assigned chapter details. Please contact Admin support.';
      if (!interaction.replied && !interaction.deferred) {
        return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
      } else {
        return interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral });
      }
    }

    // Verify chapter Discord server is set up
    const chapterGuild = await resolveGuildForLane(interaction.client, lane, chapterObj.id);
    if (!chapterGuild) {
      const msg =
        `⚠️ The Discord server for **${chapterObj.name}** has not been provisioned yet.\n` +
        'Please reach out to **Founder** or **Admin** support for assistance in the meantime.';
      if (!interaction.replied && !interaction.deferred) {
        return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
      } else {
        return interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral });
      }
    }

    resolvedChapterId = chapterObj.id;
  }

  // 3. Check if user already typed a message or sent attachments before clicking the button
  const prefillText = pendingIssueDescriptions.get(interaction.user.id) || '';
  const initialAttachments = pendingInitialAttachments.get(interaction.user.id) || [];
  pendingIssueDescriptions.delete(interaction.user.id);
  pendingInitialAttachments.delete(interaction.user.id);

  if (prefillText || initialAttachments.length > 0) {
    if (typeof interaction.update === 'function') {
      await interaction.update({
        content: `✅ **Connecting to ${laneDef.displayName}...**`,
        components: [],
        embeds: [],
      }).catch(async () => {
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: `✅ **Connecting to ${laneDef.displayName}...**`, flags: MessageFlags.Ephemeral }).catch(() => {});
        }
      });
    } else if (typeof interaction.reply === 'function') {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: `✅ **Connecting to ${laneDef.displayName}...**`,
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
      }
    }

    return createOrReopenTicket(
      interaction.client,
      interaction.user,
      lane,
      resolvedChapterId,
      prefillText || '*(Attachment only)*',
      initialAttachments
    );
  }

  // 4. User clicked button without pre-sending text: activate lane selection for direct Discord chat
  pendingLaneSelections.set(interaction.user.id, {
    lane,
    chapterId: resolvedChapterId,
    timestamp: Date.now(),
  });

  const chatPromptEmbed = new EmbedBuilder()
    .setColor(lane === 'founder' ? 0xF59E0B : lane === 'admin' ? 0xEF4444 : 0x3B82F6)
    .setTitle(`${laneDef.emoji} Connected to ${laneDef.displayName} Team`)
    .setDescription(
      `You are now chatting with the **${laneDef.displayName}** team!\n\n` +
      '💬 **Chat like normal Discord**: Type your message below and send any screenshots or file attachments.\n' +
      'Everything you send will be directly forwarded to your dedicated ticket post.'
    )
    .setFooter({ text: 'Elevates Support • Send your message below' });

  const sendPromptReply = async () => {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ embeds: [chatPromptEmbed], flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.followUp({ embeds: [chatPromptEmbed], flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  };

  if (typeof interaction.update === 'function') {
    await interaction.update({
      content: null,
      embeds: [chatPromptEmbed],
      components: [],
    }).catch(async () => {
      await sendPromptReply();
    });
  } else if (typeof interaction.reply === 'function') {
    await sendPromptReply();
  }
}

/**
 * Creates a new ticket or reopens an existing post for a user in a given lane.
 * Sends starter/reopened embed into the forum thread and notifies the user in DM.
 *
 * @param {import('discord.js').Client} client
 * @param {import('discord.js').User} user
 * @param {string} lane
 * @param {string|null} chapterId
 * @param {string} issueDescription
 * @param {Array<{ name: string, url: string, contentType?: string }>} [attachmentsList=[]]
 * @param {import('discord.js').Interaction} [interaction=null]
 * @returns {Promise<object|null>}
 */
async function _executeCreateOrReopenTicket(client, user, lane, chapterId, issueDescription, attachmentsList = [], interaction = null) {
  const laneDef = TICKET_LANES[lane];
  if (!laneDef) return null;

  try {
    // 1. Resolve target guild
    const targetGuild = await resolveGuildForLane(client, lane, chapterId);
    if (!targetGuild) {
      const errMsg = '⚠️ Could not resolve target Discord server for this ticket. Please contact an Admin.';
      if (interaction) await interaction.editReply({ content: errMsg }).catch(() => {});
      else await user.send(errMsg).catch(() => {});
      return null;
    }

    // 2. Fetch chapter info if chapter ticket
    let chapterObj = null;
    if (chapterId) {
      chapterObj = await api.getChapterByIdentifier(chapterId);
    }

    // 3. Ensure forum channel exists with appropriate permissions
    const forumChannel = await ensureTicketForum(targetGuild, lane, chapterObj);
    if (!forumChannel) {
      const errMsg = '⚠️ Target support forum channel is currently unavailable. Please try again later.';
      if (interaction) await interaction.editReply({ content: errMsg }).catch(() => {});
      else await user.send(errMsg).catch(() => {});
      return null;
    }

    // 4. Resolve user's linked identity if available
    let identity = null;
    try {
      identity = await api.getIdentityByDiscordId(user.id);
    } catch (_) {}

    const profile = identity?.profile || null;
    const fullName = profile?.full_name || null;
    const elevatesId = profile?.elevates_id || null;
    const authorName = user.displayName || user.username;

    // Build attachment files & links
    const attachedFiles = (attachmentsList || []).map((a) => a.url);
    const attachmentLinks = (attachmentsList || []).map((a) => `[${a.name || 'Attachment'}](${a.url})`);

    // 5. ONE POST PER USER PER LANE: Check if user already has an existing thread in this lane
    const sanitizedChapterId = sanitizeChapterId(lane, chapterId);
    let existingTicket = await getLatestTicketForUserAndLane(
      user.id,
      lane,
      chapterObj?.id || sanitizedChapterId
    );

    let targetThread = null;
    if (existingTicket?.thread_id) {
      try {
        targetThread =
          client.channels.cache.get(existingTicket.thread_id) ||
          targetGuild.channels.cache.get(existingTicket.thread_id) ||
          (await client.channels.fetch(existingTicket.thread_id).catch(() => null)) ||
          (await targetGuild.channels.fetch(existingTicket.thread_id).catch(() => null));
      } catch (_) {}
    }

    // FALLBACK DISCORD FORUM SCAN:
    // If targetThread was not found via database lookup, scan the forum channel's
    // active and archived threads to see if a post already exists for this user in this lane!
    if (!targetThread && forumChannel && forumChannel.threads) {
      try {
        const cachedThreads = forumChannel.threads.cache
          ? Array.from(forumChannel.threads.cache.values())
          : [];

        let activeThreads = [];
        let archivedThreads = [];

        if (typeof forumChannel.threads.fetchActive === 'function') {
          const res = await forumChannel.threads.fetchActive().catch(() => ({ threads: new Map() }));
          activeThreads = res?.threads ? Array.from(res.threads.values()) : [];
        }
        if (typeof forumChannel.threads.fetchArchived === 'function') {
          const res = await forumChannel.threads.fetchArchived().catch(() => ({ threads: new Map() }));
          archivedThreads = res?.threads ? Array.from(res.threads.values()) : [];
        }

        const map = new Map();
        for (const th of [...cachedThreads, ...activeThreads, ...archivedThreads]) {
          if (th && th.id) map.set(th.id, th);
        }

        const allThreads = Array.from(map.values());
        // Sort descending by snowflake ID so the newest thread is chosen
        allThreads.sort((a, b) => {
          try {
            return BigInt(b.id) > BigInt(a.id) ? 1 : -1;
          } catch (_) {
            return (b.id || '').localeCompare(a.id || '');
          }
        });

        const userAuthorName = (user.displayName || user.username || '').toLowerCase();
        const userRawName = (user.username || '').toLowerCase();
        const userTag = (user.tag || '').toLowerCase();

        for (const th of allThreads) {
          const thName = (th.name || '').toLowerCase();
          let matchesUser =
            thName.includes(userAuthorName) ||
            thName.includes(userRawName) ||
            (userTag && thName.includes(userTag));

          if (!matchesUser && typeof th.messages?.fetch === 'function') {
            try {
              const msgs = await th.messages.fetch({ limit: 3 }).catch(() => null);
              if (msgs) {
                for (const m of msgs.values()) {
                  if (m.embeds?.some((e) => JSON.stringify(e).includes(user.id))) {
                    matchesUser = true;
                    break;
                  }
                }
              }
            } catch (_) {}
          }

          if (matchesUser) {
            targetThread = th;
            console.log(`[ticketSystem] Forum thread scan matched thread ${th.id} ("${th.name}") for user ${user.id} in lane [${lane}]`);
            break;
          }
        }
      } catch (scanErr) {
        console.warn(`[ticketSystem] Forum thread scan error in channel ${forumChannel.id}:`, scanErr.message);
      }
    }

    if (!existingTicket && targetThread) {
      existingTicket = (await getTicketByThreadId(targetThread.id)) || {
        id: crypto.randomUUID(),
        discord_user_id: user.id,
        lane,
        chapter_id: sanitizedChapterId,
        forum_channel_id: forumChannel.id,
        thread_id: targetThread.id,
        status: 'open',
        created_at: new Date().toISOString(),
        last_message_at: new Date().toISOString(),
      };
      inMemoryTickets.set(existingTicket.id, existingTicket);
      threadIdToTicketMap.set(targetThread.id, existingTicket);
      saveLocalStore();
      try {
        await supabase.from('discord_tickets').upsert({
          id: existingTicket.id,
          discord_user_id: user.id,
          lane,
          chapter_id: sanitizedChapterId,
          forum_channel_id: forumChannel.id,
          thread_id: targetThread.id,
          status: 'open',
          created_at: existingTicket.created_at,
          last_message_at: new Date().toISOString(),
        });
      } catch (_) {}
    }

    // CASE A: Existing thread exists -> REUSE the same post, unarchive, and append new chat
    if (existingTicket && targetThread) {
      console.log(`[ticketSystem] Reusing existing post ${targetThread.id} for user ${user.id} in lane [${lane}]`);

      if (targetThread.archived) {
        await targetThread.setArchived(false).catch(() => {});
      }
      if (targetThread.joinable) {
        await targetThread.join().catch(() => {});
      }

      const reopenEmbed = new EmbedBuilder()
        .setColor(0x22C55E)
        .setTitle(`🔄 Ticket Reopened — ${laneDef.displayName}`)
        .setDescription(issueDescription || '*(Attachment only)*')
        .addFields(
          {
            name: '👤 User',
            value: `<@${user.id}> (\`${user.id}\`)`,
            inline: true,
          },
          {
            name: '🏷️ Category',
            value: `**${laneDef.displayName}**`,
            inline: true,
          }
        )
        .setFooter({ text: `Ticket ID: ${existingTicket.id} • Status: Reopened` })
        .setTimestamp();

      if (fullName) {
        reopenEmbed.addFields({
          name: '🎮 Linked ElevatesOS',
          value: `**${fullName}** (${elevatesId || 'Linked'})${chapterObj ? ` • ${chapterObj.name}` : ''}`,
          inline: false,
        });
      }

      if (attachmentLinks.length > 0) {
        reopenEmbed.addFields({
          name: '📎 Attachments / Links',
          value: attachmentLinks.join('\n').slice(0, 1024),
          inline: false,
        });
        const firstImg = attachedFiles.find((url) => /\.(png|jpe?g|webp|gif)($|\?)/i.test(url));
        if (firstImg) {
          reopenEmbed.setImage(firstImg);
        }
      }

      const staffCloseRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`ticket_staff_close_${existingTicket.id}`)
          .setLabel('Close Ticket')
          .setEmoji('🔒')
          .setStyle(ButtonStyle.Danger)
      );

      await targetThread.send({
        embeds: [reopenEmbed],
        components: [staffCloseRow],
        files: attachedFiles.length > 0 ? attachedFiles : undefined,
      });

      // Update existing ticket record back to 'open'
      await updateTicketRecord(existingTicket.id, {
        status: 'open',
        closed_at: null,
        last_message_at: new Date().toISOString(),
      });

      const userConfirmText =
        `✅ **Your message has been updated in your ${laneDef.displayName} ticket thread!**\n\n` +
        '💬 You can chat like normal Discord right here. Send your follow-up messages, screenshots, and file attachments anytime and our team will reply back to you here.';

      if (interaction) {
        await interaction.editReply({ content: userConfirmText }).catch(() => {});
      } else if (typeof user.send === 'function') {
        await user.send(userConfirmText).catch(() => {});
      } else {
        const u = await client.users.fetch(user.id).catch(() => null);
        if (u && typeof u.send === 'function') {
          await u.send(userConfirmText).catch(() => {});
        }
      }

      return existingTicket;
    }

    // CASE B: First-time ticket in this lane or previous post was deleted -> create new post
    const threadTitle = `💬 ${authorName} (${laneDef.displayName})`.slice(0, 100);
    const ticketId = crypto.randomUUID();

    const starterEmbed = new EmbedBuilder()
      .setColor(lane === 'founder' ? 0xF59E0B : lane === 'admin' ? 0xEF4444 : 0x3B82F6)
      .setTitle(`${laneDef.emoji} ${laneDef.displayName} Ticket`)
      .setDescription(issueDescription || '*(Attachment only)*')
      .addFields(
        {
          name: '👤 User',
          value: `<@${user.id}> (\`${user.id}\`)`,
          inline: true,
        },
        {
          name: '🏷️ Category',
          value: `**${laneDef.displayName}**`,
          inline: true,
        }
      )
      .setFooter({ text: `Ticket ID: ${ticketId} • Status: Open` })
      .setTimestamp();

    if (fullName) {
      starterEmbed.addFields({
        name: '🎮 Linked ElevatesOS',
        value: `**${fullName}** (${elevatesId || 'Linked'})${chapterObj ? ` • ${chapterObj.name}` : ''}`,
        inline: false,
      });
    }

    if (attachmentLinks.length > 0) {
      starterEmbed.addFields({
        name: '📎 Attachments / Links',
        value: attachmentLinks.join('\n').slice(0, 1024),
        inline: false,
      });
      const firstImg = attachedFiles.find((url) => /\.(png|jpe?g|webp|gif)($|\?)/i.test(url));
      if (firstImg) {
        starterEmbed.setImage(firstImg);
      }
    }

    // Staff close button in the starter post
    const staffCloseRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ticket_staff_close_${ticketId}`)
        .setLabel('Close Ticket')
        .setEmoji('🔒')
        .setStyle(ButtonStyle.Danger)
    );

    // Create forum thread
    let thread = null;
    if (forumChannel.type === ChannelType.GuildForum) {
      thread = await forumChannel.threads.create({
        name: threadTitle,
        message: {
          embeds: [starterEmbed],
          components: [staffCloseRow],
          files: attachedFiles.length > 0 ? attachedFiles : undefined,
        },
        reason: `Support ticket for ${user.tag || user.username}`,
      });
    } else {
      thread = await forumChannel.threads.create({
        name: threadTitle,
        reason: `Support ticket for ${user.tag || user.username}`,
      });
      await thread.send({
        embeds: [starterEmbed],
        components: [staffCloseRow],
        files: attachedFiles.length > 0 ? attachedFiles : undefined,
      });
    }

    if (thread.joinable) {
      await thread.join().catch(() => {});
    }

    let record = null;
    if (existingTicket) {
      record = await updateTicketRecord(existingTicket.id, {
        forum_channel_id: forumChannel.id,
        thread_id: thread.id,
        status: 'open',
        closed_at: null,
        last_message_at: new Date().toISOString(),
      });
    } else {
      record = await createTicketRecord({
        discordUserId: user.id,
        lane,
        chapterId: chapterObj?.id || sanitizedChapterId,
        forumChannelId: forumChannel.id,
        threadId: thread.id,
      });
    }

    const userConfirmText =
      `✅ **Your ticket has been submitted to the ${laneDef.displayName} team!**\n\n` +
      '💬 You can chat like normal Discord right here. Send your messages, screenshots, and file attachments anytime and our team will reply to you here.\n' +
      'All your chats for this category will be preserved in your dedicated thread.';

    if (interaction) {
      await interaction.editReply({ content: userConfirmText }).catch(() => {});
    } else if (typeof user.send === 'function') {
      await user.send(userConfirmText).catch(() => {});
    } else {
      const u = await client.users.fetch(user.id).catch(() => null);
      if (u && typeof u.send === 'function') {
        await u.send(userConfirmText).catch(() => {});
      }
    }

    console.log(`[ticketSystem] Ticket created: ID ${ticketId}, lane [${lane}], thread ${thread.id} for user ${user.id}`);
    return record;
  } catch (err) {
    console.error('[ticketSystem] Error in createOrReopenTicket:', err);
    const errMsg = '❌ Failed to process ticket. Please try again or reach out to staff.';
    if (interaction) await interaction.editReply({ content: errMsg }).catch(() => {});
    else if (typeof user?.send === 'function') await user.send(errMsg).catch(() => {});
    else {
      const u = await client.users.fetch(user?.id).catch(() => null);
      if (u && typeof u.send === 'function') await u.send(errMsg).catch(() => {});
    }
    return null;
  }
}

/**
 * Mutex-locked wrapper for createOrReopenTicket to prevent race conditions
 * from creating multiple threads if a user double-clicks or messages in rapid succession.
 */
async function createOrReopenTicket(client, user, lane, chapterId, issueDescription, attachmentsList = [], interaction = null) {
  const lockKey = `${user?.id || 'unknown'}:${lane}`;
  if (activeCreationLocks.has(lockKey)) {
    console.log(`[ticketSystem] Waiting for in-flight ticket operation on ${lockKey}...`);
    try {
      await activeCreationLocks.get(lockKey);
    } catch (_) {}
  }

  let resolveLock;
  const lockPromise = new Promise((resolve) => {
    resolveLock = resolve;
  });
  activeCreationLocks.set(lockKey, lockPromise);

  try {
    return await _executeCreateOrReopenTicket(client, user, lane, chapterId, issueDescription, attachmentsList, interaction);
  } finally {
    activeCreationLocks.delete(lockKey);
    if (typeof resolveLock === 'function') resolveLock();
  }
}

/**
 * Handles submission of the ticket creation modal (fallback for modal interaction).
 *
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 */
async function handleTicketModalSubmit(interaction) {
  const customId = interaction.customId; // e.g. ticket_modal_founder_global or ticket_modal_exec_<chapterId>
  const parts = customId.split('_');
  const lane = parts[2];
  const chapterId = parts[3] === 'global' ? null : parts[3];

  const laneDef = TICKET_LANES[lane];
  if (!laneDef) {
    return interaction.reply({ content: '⚠️ Unknown ticket lane.', flags: MessageFlags.Ephemeral });
  }

  const issueDescription = interaction.fields.getTextInputValue('issue_description');
  let attachmentUrl = null;
  try {
    attachmentUrl = interaction.fields.getTextInputValue('attachment_url')?.trim() || null;
  } catch (_) {}

  // Collect pending initial attachments (from initial DM or slash command)
  const initialAttachments = pendingInitialAttachments.get(interaction.user.id) || [];
  pendingInitialAttachments.delete(interaction.user.id);
  pendingIssueDescriptions.delete(interaction.user.id);

  if (attachmentUrl) {
    initialAttachments.push({ name: 'Attachment Link', url: attachmentUrl });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  return createOrReopenTicket(
    interaction.client,
    interaction.user,
    lane,
    chapterId,
    issueDescription,
    initialAttachments,
    interaction
  );
}

/**
 * Handles the user clicking a ticket route button when they had multiple open tickets.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} ticketId
 */
async function handleRouteButtonClick(interaction, ticketId) {
  const ticket = inMemoryTickets.get(ticketId) || (await getTicketByThreadId(ticketId));
  if (!ticket || ticket.status !== 'open') {
    return interaction.reply({
      content: '⚠️ That ticket is no longer open.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const pending = pendingDmMessages.get(interaction.user.id);
  pendingDmMessages.delete(interaction.user.id);

  if (!pending) {
    return interaction.reply({
      content: `Active ticket selected: **${getLaneDisplayName(ticket.lane)}**. Please send your message now.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferUpdate();

  try {
    const thread =
      interaction.client.channels.cache.get(ticket.thread_id) ||
      (await interaction.client.channels.fetch(ticket.thread_id).catch(() => null));

    if (!thread) {
      return interaction.followUp({
        content: '⚠️ Could not find ticket thread. It may have been deleted.',
        flags: MessageFlags.Ephemeral,
      });
    }

    if (thread.archived) {
      await thread.setArchived(false).catch(() => {});
    }

    const embed = new EmbedBuilder()
      .setColor(0x3B82F6)
      .setAuthor({
        name: `${interaction.user.displayName || interaction.user.username} (${interaction.user.tag})`,
        iconURL: typeof interaction.user.displayAvatarURL === 'function' ? interaction.user.displayAvatarURL() : undefined,
      })
      .setTitle('📩 User Reply')
      .setDescription(pending.content || '*(Attachment only)*')
      .setFooter({ text: `Ticket ID: ${ticket.id} • Lane: ${getLaneDisplayName(ticket.lane)}` })
      .setTimestamp(new Date(pending.timestamp));

    const payload = { embeds: [embed] };
    if (pending.attachments?.length > 0) {
      embed.addFields({ name: '📎 Attachments', value: pending.attachments.join('\n') });
      const firstImg = pending.attachments.find((url) => /\.(png|jpe?g|webp|gif)($|\?)/i.test(url));
      if (firstImg) {
        embed.setImage(firstImg);
      }
      payload.files = pending.attachments;
    }

    await thread.send(payload);
    await updateTicketRecord(ticket.id, { last_message_at: new Date().toISOString() });

    await interaction.editReply({
      content: `✅ Message routed to your **${getLaneDisplayName(ticket.lane)}** ticket.`,
      components: [],
      embeds: [],
    });
  } catch (err) {
    console.error(`[ticketSystem] Error routing pending message to ticket ${ticket.id}:`, err);
    await interaction.followUp({
      content: '⚠️ Failed to forward message to the ticket thread.',
      flags: MessageFlags.Ephemeral,
    });
  }
}

/**
 * Handles messages sent inside a ticket's forum thread by staff.
 * Relays the reply to user's DM and sends the "Problem solved / Not yet" prompt.
 *
 * @param {import('discord.js').Message} message
 * @returns {Promise<boolean>} True if processed as staff ticket reply
 */
async function handleStaffReply(message) {
  if (!message || !message.guild || message.author.bot) return false;
  if (!message.channel.isThread()) return false;

  const ticket = await getTicketByThreadId(message.channel.id);
  if (!ticket || ticket.status !== 'open') return false;

  // Deduplicate exact message IDs across events/instances
  if (processedStaffMessageIds.has(message.id)) {
    return true;
  }
  processedStaffMessageIds.add(message.id);
  if (processedStaffMessageIds.size > 1000) {
    const oldest = processedStaffMessageIds.values().next().value;
    processedStaffMessageIds.delete(oldest);
  }

  // Content debounce per ticket (prevents duplicate relays of identical text within 2.5 seconds)
  const contentKey = `${message.content || ''}_${Array.from(message.attachments.values()).map((a) => a.url).join(',')}`;
  const now = Date.now();
  const lastRelay = lastStaffRelayByTicket.get(ticket.id);
  if (lastRelay && lastRelay.contentKey === contentKey && now - lastRelay.timestamp < 2500) {
    console.log(`[ticketSystem] Debounced duplicate staff relay for ticket ${ticket.id}`);
    return true;
  }
  lastStaffRelayByTicket.set(ticket.id, { contentKey, timestamp: now });

  console.log(`[ticketSystem] Staff message detected in ticket thread ${message.channel.id} by ${message.author.tag}: "${message.content}"`);

  try {
    // 1. Verify staff authorization for this ticket's lane
    const isAuthorized = await isUserAuthorizedForLane(
      message.member,
      ticket.lane,
      ticket.chapter_id,
      message.client
    );

    if (!isAuthorized) {
      console.log(`[ticketSystem] ❌ Sender ${message.author.tag} is not authorized for lane [${ticket.lane}].`);
      await message.react('❌').catch(() => {});
      await message.reply({
        content: `⚠️ Only authorized ${getLaneDisplayName(ticket.lane)} staff can reply in this ticket forum.`,
      }).catch(() => {});
      return true;
    }

    // 2. Check for staff close commands in thread: !close, !close-ticket, !resolve
    const trimmed = (message.content || '').trim().toLowerCase();
    if (trimmed === '!close' || trimmed === '!close-ticket' || trimmed === '!resolve') {
      await handleStaffClose(message.channel, message.author);
      return true;
    }

    // 3. Fetch recipient user
    let targetUser = null;
    let fetchUserError = null;
    try {
      targetUser = await message.client.users.fetch(ticket.discord_user_id);
    } catch (fetchErr) {
      fetchUserError = fetchErr;
    }

    if (!targetUser) {
      await message.react('⚠️').catch(() => {});
      const errCode = fetchUserError?.code || 'UNKNOWN';
      await message.reply(
        `⚠️ Couldn't deliver — Discord error [${errCode}]: Could not fetch user <@${ticket.discord_user_id}>.`
      ).catch(() => {});
      return true;
    }

    // 4. Relay staff message to user's DM
    const laneName = getLaneDisplayName(ticket.lane);
    const relayContent = message.content
      ? `**Elevates ${laneName} Team:**\n${message.content}`
      : `**Elevates ${laneName} Team:**\n*(Attachment only)*`;

    const payload = { content: relayContent };
    if (message.attachments.size > 0) {
      payload.files = Array.from(message.attachments.values()).map((a) => a.url);
    }

    try {
      await targetUser.send(payload);
      await message.react('✅').catch(() => {});
      await updateTicketRecord(ticket.id, { last_message_at: new Date().toISOString() });
    } catch (sendErr) {
      await message.react('⚠️').catch(() => {});
      const errCode = sendErr?.code || 'UNKNOWN';
      if (errCode === 50007) {
        await message.reply(
          "⚠️ Couldn't deliver — this user has DMs disabled or has blocked the bot."
        ).catch(() => {});
      } else {
        await message.reply(
          `⚠️ Couldn't deliver — Discord error [${errCode}]: ${sendErr.message}`
        ).catch(() => {});
      }
      return true;
    }

    // 5. Follow up with "Problem solved / Not yet" button prompt in user DM (Section 6)
    // Clean up previous prompt buttons if one was already sent for this ticket
    const prevPromptMsg = lastSolvePromptMsgByTicket.get(ticket.id);
    if (prevPromptMsg) {
      try {
        await prevPromptMsg.edit({ components: [] }).catch(() => {});
      } catch (_) {}
    }

    const solveRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ticket_solve_${ticket.id}`)
        .setLabel('Problem solved')
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`ticket_not_yet_${ticket.id}`)
        .setLabel('Not yet')
        .setEmoji('💬')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`ticket_attach_${ticket.id}`)
        .setLabel('Add Attachment')
        .setEmoji('📎')
        .setStyle(ButtonStyle.Secondary)
    );

    const promptMsg = await targetUser.send({
      content: 'Is your problem solved?',
      components: [solveRow],
    }).catch(() => null);

    if (promptMsg) {
      lastSolvePromptMsgByTicket.set(ticket.id, promptMsg);
    }

    return true;
  } catch (err) {
    console.error('[ticketSystem] Error handling staff reply:', err);
    return true;
  }
}

/**
 * Handles the user clicking "Problem solved" in DM:
 * - Sends closing/thank-you message in DM
 * - Completely removes the action buttons so no resolve section remains
 * - Marks ticket closed in Supabase & local store
 * - Archives/closes the forum post
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} ticketId
 */
async function handleSolveButtonClick(interaction, ticketId) {
  const ticket = inMemoryTickets.get(ticketId) || (await getTicketByThreadId(ticketId));
  if (!ticket) {
    if (!interaction.replied && !interaction.deferred) {
      return interaction.reply({ content: '⚠️ Ticket not found.', flags: MessageFlags.Ephemeral });
    } else {
      return interaction.followUp({ content: '⚠️ Ticket not found.', flags: MessageFlags.Ephemeral });
    }
  }

  const thanksMessage =
    '🎉 **Glad we could help!** Your ticket has been marked as solved.\n\n' +
    'If you need assistance with anything else in the future, feel free to send a DM or run `/ticket` anytime!';

  // Immediately remove buttons and replace message with the thanks note (no lingering buttons)
  try {
    if (typeof interaction.update === 'function') {
      await interaction.update({
        content: thanksMessage,
        components: [],
        embeds: [],
      });
    } else if (typeof interaction.editReply === 'function') {
      await interaction.editReply({
        content: thanksMessage,
        components: [],
        embeds: [],
      });
    }
  } catch (updateErr) {
    console.warn('[ticketSystem] Could not update interaction message directly:', updateErr.message);
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: thanksMessage, flags: MessageFlags.Ephemeral });
      }
    } catch (_) {}
  }

  // Clean up any tracked solve prompt message for this ticket
  const prevPromptMsg = lastSolvePromptMsgByTicket.get(ticket.id);
  if (prevPromptMsg) {
    try {
      await prevPromptMsg.edit({ components: [] }).catch(() => {});
    } catch (_) {}
    lastSolvePromptMsgByTicket.delete(ticket.id);
  }

  if (ticket.status === 'closed') {
    return;
  }

  // 1. Mark closed in Supabase & store
  await closeTicketRecord(ticket.id, 'solved_by_user');

  // 2. Archive and close forum thread in Discord
  try {
    const thread =
      interaction.client.channels.cache.get(ticket.thread_id) ||
      (await interaction.client.channels.fetch(ticket.thread_id).catch(() => null));

    if (thread) {
      await thread.send('🔒 **User marked ticket as resolved.** Thread has been closed and archived.').catch(() => {});
      await thread.setArchived(true, 'Ticket resolved by user').catch(() => {});
    }
  } catch (threadErr) {
    console.warn(`[ticketSystem] Could not archive thread ${ticket.thread_id}:`, threadErr.message);
  }
}

/**
 * Handles the user clicking "Not yet" in DM:
 * Wipes the prompt buttons and confirms that the ticket remains active for normal Discord chat.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} ticketId
 */
async function handleNotYetButtonClick(interaction, ticketId) {
  const ticket = inMemoryTickets.get(ticketId) || (await getTicketByThreadId(ticketId));
  if (!ticket || ticket.status !== 'open') {
    const msg = '⚠️ This ticket is no longer open. Please send a message or run `/ticket` to open a new one.';
    if (!interaction.replied && !interaction.deferred) {
      return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
    } else {
      return interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral });
    }
  }

  const embed = new EmbedBuilder()
    .setColor(0x3B82F6)
    .setTitle('💬 Ticket Active')
    .setDescription(
      `Your **${getLaneDisplayName(ticket.lane)}** ticket is still open!\n\n` +
      '💬 **Chat like normal Discord**: Type your message or send any screenshots/files directly in this chat, and our team will get back to you shortly.'
    )
    .setFooter({ text: 'Elevates Support • Send your message below' });

  const sendNotYetReply = async () => {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  };

  if (typeof interaction.update === 'function') {
    await interaction.update({
      content: null,
      embeds: [embed],
      components: [],
    }).catch(async () => {
      await sendNotYetReply();
    });
  } else if (typeof interaction.reply === 'function') {
    await sendNotYetReply();
  }
}


/**
 * Handles user clicking "Add Attachment" button in DM:
 * Opens a modal allowing them to paste links to screenshots or documents.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {string} ticketId
 */
async function handleAttachButtonClick(interaction, ticketId) {
  const ticket = inMemoryTickets.get(ticketId) || (await getTicketByThreadId(ticketId));
  if (!ticket || ticket.status !== 'open') {
    return interaction.reply({
      content: '⚠️ This ticket is no longer open. Please send a message or run `/ticket` to open a new one.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const modal = new ModalBuilder()
    .setCustomId(`ticket_attach_modal_${ticket.id}`)
    .setTitle('Add Attachment / Screenshot');

  const urlInput = new TextInputBuilder()
    .setCustomId('attachment_url')
    .setLabel('Attachment / Screenshot Link')
    .setPlaceholder('Paste image URL (e.g. imgur, drive, cdn) or document link...')
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(5)
    .setMaxLength(1000)
    .setRequired(true);

  const noteInput = new TextInputBuilder()
    .setCustomId('attachment_note')
    .setLabel('Note / Description (Optional)')
    .setPlaceholder('Describe what this screenshot or document shows...')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(1000)
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(urlInput),
    new ActionRowBuilder().addComponents(noteInput)
  );

  await interaction.showModal(modal);
}

/**
 * Handles the attachment modal submission:
 * Forwards the link, note, and optional preview image to the ticket forum thread.
 *
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 */
async function handleAttachModalSubmit(interaction) {
  const customId = interaction.customId; // ticket_attach_modal_<ticketId>
  const ticketId = customId.replace('ticket_attach_modal_', '');

  const ticket = inMemoryTickets.get(ticketId) || (await getTicketByThreadId(ticketId));
  if (!ticket) {
    return interaction.reply({ content: '⚠️ Ticket not found.', flags: MessageFlags.Ephemeral });
  }

  const attachmentUrl = interaction.fields.getTextInputValue('attachment_url')?.trim();
  let note = null;
  try {
    note = interaction.fields.getTextInputValue('attachment_note')?.trim() || null;
  } catch (_) {}

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const thread =
      interaction.client.channels.cache.get(ticket.thread_id) ||
      (await interaction.client.channels.fetch(ticket.thread_id).catch(() => null));

    if (!thread) {
      return interaction.editReply({
        content: '⚠️ Ticket thread could not be located. It may have been closed or deleted.',
      });
    }

    if (thread.archived) {
      await thread.setArchived(false).catch(() => {});
    }

    const authorIcon = typeof interaction.user.displayAvatarURL === 'function'
      ? interaction.user.displayAvatarURL()
      : undefined;

    const embed = new EmbedBuilder()
      .setColor(0x3B82F6)
      .setAuthor({
        name: `${interaction.user.displayName || interaction.user.username} (${interaction.user.tag})`,
        iconURL: authorIcon,
      })
      .setTitle('📎 Attachment Added by User')
      .setDescription(note ? `**Note:** ${note}\n\n**Attachment:**\n${attachmentUrl}` : `**Attachment:**\n${attachmentUrl}`)
      .setFooter({ text: `Ticket ID: ${ticket.id} • Lane: ${getLaneDisplayName(ticket.lane)}` })
      .setTimestamp();

    const matches = attachmentUrl.match(/https?:\/\/[^\s]+/g) || [];
    const firstImg = matches.find((url) => /\.(png|jpe?g|webp|gif)($|\?)/i.test(url));
    if (firstImg) {
      embed.setImage(firstImg);
    }

    const payload = { embeds: [embed] };
    if (firstImg) {
      payload.files = [firstImg];
    }

    await thread.send(payload);
    await updateTicketRecord(ticket.id, { last_message_at: new Date().toISOString() });

    await interaction.editReply({
      content:
        '✅ **Your attachment has been sent to our team!**\n\n' +
        '💡 *Tip: You can also upload files or screenshots directly by dragging and dropping them into this DM anytime.*',
    });
  } catch (err) {
    console.error(`[ticketSystem] Error handling attachment modal submit for ticket ${ticket.id}:`, err);
    await interaction.editReply({
      content: '❌ Failed to forward attachment to staff. Please try again.',
    });
  }
}

/**
 * Handles closing a ticket from the staff side:
 * - Triggered via /close-ticket command, button in forum post, or !close in thread
 * - Restricted to authorized staff for that lane
 * - Marks ticket closed in Supabase & local store
 * - Archives forum post
 * - Sends user a DM noting ticket was closed by staff (no "solved?" prompt)
 *
 * @param {import('discord.js').ThreadChannel} threadChannel
 * @param {import('discord.js').User|import('discord.js').GuildMember} closedBy
 * @param {import('discord.js').CommandInteraction|import('discord.js').ButtonInteraction} [interaction=null]
 * @returns {Promise<boolean>}
 */
async function handleStaffClose(threadChannel, closedBy, interaction = null) {
  if (!threadChannel || !threadChannel.isThread()) {
    if (interaction) {
      await interaction.reply({
        content: '⚠️ This command can only be used inside an active ticket thread.',
        flags: MessageFlags.Ephemeral,
      });
    }
    return false;
  }

  const ticket = await getTicketByThreadId(threadChannel.id);
  if (!ticket) {
    if (interaction) {
      await interaction.reply({
        content: '⚠️ This thread is not recognized as an active ticket.',
        flags: MessageFlags.Ephemeral,
      });
    }
    return false;
  }

  // Verify staff permission
  const member = threadChannel.guild?.members.cache.get(closedBy.id) ||
    (await threadChannel.guild?.members.fetch(closedBy.id).catch(() => null));

  const isAuthorized = await isUserAuthorizedForLane(
    member,
    ticket.lane,
    ticket.chapter_id,
    threadChannel.client
  );

  if (!isAuthorized) {
    const errorMsg = `⚠️ Only authorized ${getLaneDisplayName(ticket.lane)} staff can close this ticket.`;
    if (interaction) {
      await interaction.reply({ content: errorMsg, flags: MessageFlags.Ephemeral });
    } else {
      await threadChannel.send(errorMsg);
    }
    return false;
  }

  if (ticket.status === 'closed') {
    const msg = '⚠️ This ticket is already marked as closed.';
    if (interaction) {
      await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
    }
    return false;
  }

  if (interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  try {
    // 1. Mark ticket closed in storage
    await closeTicketRecord(ticket.id, 'closed_by_staff');

    // 2. Post closure notice in thread
    const closedById = closedBy?.id || 'Staff';
    await threadChannel.send(
      `🔒 **Ticket closed by <@${closedById}>.**\nThis thread has been archived.`
    ).catch(() => {});

    // 3. Archive thread in Discord
    await threadChannel.setArchived(true, 'Ticket closed by staff').catch(() => {});

    // 4. Send notification DM to user (no "solved?" buttons in this path)
    try {
      const targetUser = await threadChannel.client.users.fetch(ticket.discord_user_id);
      if (targetUser) {
        await targetUser.send(
          `**Elevates ${getLaneDisplayName(ticket.lane)} Team:**\n` +
          'Your support ticket has been closed by staff.\n' +
          'If you need assistance in the future, you can open a new ticket anytime by sending a DM or running `/ticket`.'
        ).catch(() => {});
      }
    } catch (_) {}

    if (interaction) {
      await interaction.editReply({
        content: '✅ Ticket marked as closed and thread archived. User has been notified.',
      });
    }

    return true;
  } catch (err) {
    console.error(`[ticketSystem] Error closing ticket ${ticket.id}:`, err);
    if (interaction) {
      await interaction.editReply({
        content: '❌ An error occurred while closing the ticket.',
      });
    }
    return false;
  }
}

module.exports = {
  TICKET_LANES,
  getLaneDisplayName,
  getLaneEmoji,
  getOpenTicketsForUser,
  getOpenTicketForUserAndLane,
  getLatestTicketForUserAndLane,
  getTicketByThreadId,
  createTicketRecord,
  updateTicketRecord,
  closeTicketRecord,
  isUserAuthorizedForLane,
  resolveGuildForLane,
  ensureTicketForum,
  ensureAllMainTicketForums,
  createLanePickerRow,
  sendLanePicker,
  handleIncomingDm,
  appendUserMessageToTicket,
  handleLaneButtonClick,
  handleTicketModalSubmit,
  handleRouteButtonClick,
  handleStaffReply,
  handleSolveButtonClick,
  handleNotYetButtonClick,
  handleAttachButtonClick,
  handleAttachModalSubmit,
  createOrReopenTicket,
  setPendingAttachment,
  handleStaffClose,
  sanitizeChapterId,
};
