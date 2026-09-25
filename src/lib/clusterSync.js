const { ChannelType, PermissionFlagsBits } = require('discord.js');
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

/**
 * Resolves the Discord User ID for a given Supabase User UUID (profiles.id).
 * Checks both discord_links and profiles tables.
 */
async function resolveDiscordIdForUser(userId) {
  if (!userId) return null;

  try {
    // 1. Primary check in discord_links
    const { data: link } = await supabase
      .from('discord_links')
      .select('discord_user_id')
      .eq('os_user_id', userId)
      .eq('status', 'linked')
      .order('linked_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (link?.discord_user_id) {
      return link.discord_user_id;
    }

    // 2. Secondary check in profiles
    const { data: profile } = await supabase
      .from('profiles')
      .select('discord_user_id, discord_connected')
      .eq('id', userId)
      .maybeSingle();

    if (profile?.discord_connected && profile.discord_user_id) {
      return profile.discord_user_id;
    }
  } catch (err) {
    console.warn(`[clusterSync] Error resolving Discord ID for user ${userId}:`, err.message);
  }

  return null;
}

/**
 * Resolves the Chapter Guild for a given chapterId using guild_config.
 */
async function getChapterGuild(client, chapterId) {
  if (!client || !chapterId) return null;

  const { data: guildConfig, error } = await supabase
    .from('guild_config')
    .select('guild_id')
    .eq('chapter_id', chapterId)
    .eq('guild_type', 'chapter')
    .maybeSingle();

  if (error || !guildConfig?.guild_id) {
    return null;
  }

  return client.guilds.cache.get(guildConfig.guild_id) ||
    (await client.guilds.fetch(guildConfig.guild_id).catch(() => null));
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
 *    - chapter's Campus Lead role (and TODO Executive Team roles): allow ViewChannel + manage permissions
 * 3. Create child channels under that category (inherit category overwrites via parent_id):
 *    - #announcements (Announcement type)
 *    - #discussion, #resources, #challenges, #projects (Forum type)
 *    - <Cluster Name> Voice (Voice channel)
 *    Use the existing emoji-and-uppercase-naming convention already established for cluster categories.
 * 4. UPDATE clusters.discord_category_id.
 * 5. INSERT into discord_sync_log (event_type: 'cluster_created', success: true/false).
 *
 * @param {import('discord.js').Client} client
 * @param {object} clusterData
 */
async function handleClusterCreated(client, clusterData) {
  if (!client || !clusterData) return null;

  let cluster = clusterData;
  if (!cluster.name || !cluster.chapter_id) {
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
    const guild = await getChapterGuild(client, cluster.chapter_id);
    if (!guild) {
      throw new Error(`No provisioned chapter guild found for chapter ${cluster.chapter_id}`);
    }

    const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
    if (!me || !me.permissions.has([PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles])) {
      throw new Error(`Bot lacks ManageChannels or ManageRoles permissions in guild ${guild.id}`);
    }

    const clusterName = cluster.name || 'Unnamed Cluster';
    const memberRoleName = `${clusterName} Member`;

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
    // so a crash mid-process doesn't create duplicate roles on retry
    await supabase
      .from('clusters')
      .update({ discord_role_id: memberRole.id })
      .eq('id', cluster.id);
    cluster.discord_role_id = memberRole.id;

    // 2. Create the private category with permission overwrites set AT CREATION (not applied after)
    // Find or create Campus Lead role
    // TODO: Going forward, add Executive Team roles once that OS concept exists rather than just Campus Lead
    const campusLeadRoleName = config.roles.campusLead || 'Campus Lead';
    let campusLeadRole = guild.roles.cache.find(
      (r) => r.name.toLowerCase().trim() === campusLeadRoleName.toLowerCase().trim()
    );
    if (!campusLeadRole) {
      campusLeadRole = await syncQueue.enqueueAsync('guild', `${guild.id}:role:campus_lead`, async () => {
        return await guild.roles.create({
          name: campusLeadRoleName,
          color: 0xF59E0B,
          reason: 'ElevatesOS Campus Lead Role',
        });
      }).catch(() => null);
    }

    const clusterEmoji = getClusterEmoji(cluster);
    const categoryName = `${clusterEmoji}・${clusterName.toUpperCase()}`;

    const permissionOverwrites = [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: memberRole.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.Connect,
        ],
      },
      {
        id: me.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.ManageRoles,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.Connect,
        ],
      },
    ];

    if (campusLeadRole) {
      permissionOverwrites.push({
        id: campusLeadRole.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.ManageRoles,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.Connect,
        ],
      });
    }

    let category = null;
    if (cluster.discord_category_id) {
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
      category = await syncQueue.enqueueAsync('cluster', `${cluster.id}:category`, async () => {
        return await guild.channels.create({
          name: categoryName,
          type: ChannelType.GuildCategory,
          permissionOverwrites,
          reason: `Private category for cluster: ${clusterName}`,
        });
      });
    }

    // 3. Create child channels under that category (inherit category overwrites via parent_id):
    // - #announcements (Announcement type)
    // - #discussion, #resources, #challenges, #projects (Forum type)
    // - <Cluster Name> Voice (Voice channel)
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
        name: `${clusterName} Voice`,
        type: ChannelType.GuildVoice,
      },
    ];

    const channelMap = {};

    for (const spec of childChannelSpecs) {
      let existingChild = guild.channels.cache.find(
        (c) => c.parentId === category.id && c.name.toLowerCase() === spec.name.toLowerCase()
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
      }
    }

    // 4. UPDATE clusters.discord_category_id
    await supabase
      .from('clusters')
      .update({ discord_category_id: category.id })
      .eq('id', cluster.id);
    cluster.discord_category_id = category.id;

    // Maintain backward-compatible cluster_discord_mappings table
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
          voice_channel_id: channelMap[`${clusterName} Voice`] || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'cluster_id,guild_id' }
      )
      .catch(() => {});

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
  if (!client || !memberRow || !memberRow.cluster_id || !memberRow.user_id) return;

  const clusterId = memberRow.cluster_id;
  const userId = memberRow.user_id;
  const roleInCluster = memberRow.role_in_cluster || 'member';
  const roleType = roleInCluster === 'host' ? 'cluster_host' : 'cluster_member';

  try {
    // 1. Fetch cluster and check if archived
    const { data: cluster, error: clErr } = await supabase
      .from('clusters')
      .select('*')
      .eq('id', clusterId)
      .maybeSingle();

    if (clErr || !cluster) {
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
    const guild = await getChapterGuild(client, cluster.chapter_id);
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
        errorMessage: 'Chapter guild not reachable yet; queued in pending_discord_roles',
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
    if (!memberRoleId) {
      // Ensure cluster roles and channels exist
      const setup = await handleClusterCreated(client, cluster);
      memberRoleId = setup?.memberRole?.id;
    }

    // Check member.roles.cache.has(roleId) first (idempotency)
    if (memberRoleId && !member.roles.cache.has(memberRoleId)) {
      await syncQueue.enqueueAsync('role', `${member.id}:${memberRoleId}`, async () => {
        await member.roles.add(memberRoleId);
      });
    }

    let hostRole = null;
    if (roleInCluster === 'host') {
      hostRole = await ensureHostRole(guild, cluster.name);
      if (hostRole && !member.roles.cache.has(hostRole.id)) {
        await syncQueue.enqueueAsync('role', `${member.id}:${hostRole.id}`, async () => {
          await member.roles.add(hostRole.id);
        });
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
  if (!client || !memberRow || !memberRow.cluster_id || !memberRow.user_id) return;

  const clusterId = memberRow.cluster_id;
  const userId = memberRow.user_id;

  try {
    // 3. CRITICAL: always DELETE matching pending_discord_roles row
    // Prevents bug where someone removed from a cluster before ever linking Discord still gets the role retroactively
    await supabase
      .from('pending_discord_roles')
      .delete()
      .eq('user_id', userId)
      .eq('target_id', clusterId);

    // 1. Look up discord_id via identity table
    const discordUserId = await resolveDiscordIdForUser(userId);

    const { data: cluster } = await supabase
      .from('clusters')
      .select('*')
      .eq('id', clusterId)
      .maybeSingle();

    let roleRevoked = false;

    if (discordUserId && cluster?.chapter_id) {
      const guild = await getChapterGuild(client, cluster.chapter_id);
      if (guild) {
        const member = guild.members.cache.get(discordUserId) ||
          (await guild.members.fetch(discordUserId).catch(() => null));

        if (member) {
          // 2. Remove cluster member role if held
          if (cluster.discord_role_id && member.roles.cache.has(cluster.discord_role_id)) {
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

    if (pErr || !pendingRoles || pendingRoles.length === 0) {
      return;
    }

    console.log(`[clusterSync] Resolving ${pendingRoles.length} pending Discord role(s) for user ${userId} (${discordUserId})`);

    // 2. Process each pending role independently
    for (const pending of pendingRoles) {
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

          const guild = await getChapterGuild(client, cluster.chapter_id);
          if (!guild) {
            throw new Error(`Guild for chapter ${cluster.chapter_id} not reachable`);
          }

          const member = guild.members.cache.get(discordUserId) ||
            (await guild.members.fetch(discordUserId).catch(() => null));

          if (!member) {
            // User linked but not yet in this chapter's guild; retain pending row until they join
            continue;
          }

          let memberRoleId = cluster.discord_role_id;
          if (!memberRoleId) {
            const setup = await handleClusterCreated(client, cluster);
            memberRoleId = setup?.memberRole?.id;
          }

          if (memberRoleId && !member.roles.cache.has(memberRoleId)) {
            await syncQueue.enqueueAsync('role', `${member.id}:${memberRoleId}`, async () => {
              await member.roles.add(memberRoleId);
            });
          }

          let assignedRoleId = memberRoleId;

          if (pending.role_type === 'cluster_host') {
            const hostRole = await ensureHostRole(guild, cluster.name);
            if (hostRole && !member.roles.cache.has(hostRole.id)) {
              await syncQueue.enqueueAsync('role', `${member.id}:${hostRole.id}`, async () => {
                await member.roles.add(hostRole.id);
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

    const guild = await getChapterGuild(client, cluster.chapter_id);
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

    const guild = await getChapterGuild(client, cluster.chapter_id);
    if (!guild) {
      console.warn(`[reconcileClusterMembers] No chapter guild for cluster ${cluster.name} (${clusterId})`);
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

    // 1. Fetch expected member user IDs from cluster_members table
    const { data: dbMembers } = await supabase
      .from('cluster_members')
      .select('user_id, role_in_cluster')
      .eq('cluster_id', cluster.id);

    const expectedUserIds = new Set();
    const hostUserIds = new Set();

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

    // Also include cluster.leader_id if configured
    if (cluster.leader_id) {
      expectedUserIds.add(cluster.leader_id);
      hostUserIds.add(cluster.leader_id);
    }

    // Resolve expected Discord IDs
    const expectedDiscordIds = new Set();
    const hostDiscordIds = new Set();
    const userIdToDiscordMap = new Map();

    for (const uId of expectedUserIds) {
      const dId = await resolveDiscordIdForUser(uId);
      if (dId) {
        expectedDiscordIds.add(dId);
        userIdToDiscordMap.set(dId, uId);
        if (hostUserIds.has(uId)) {
          hostDiscordIds.add(dId);
        }
      }
    }

    // 2. Fetch actual Discord role holders
    // In discord.js, role.members has cache of members with that role
    await guild.members.fetch(); // Ensure cache is populated
    const actualRoleHolders = new Set();

    for (const [memberId, member] of guild.members.cache) {
      if (member.roles.cache.has(memberRole.id)) {
        actualRoleHolders.add(memberId);
      }
    }

    // 3. Drift Correction: Grant missing roles
    for (const discordId of expectedDiscordIds) {
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
    }

    // 4. Drift Correction: Revoke excess roles
    for (const discordId of actualRoleHolders) {
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
    }

    // 5. Host role drift correction
    const hostRole = await ensureHostRole(guild, cluster.name);
    if (hostRole) {
      for (const hostDiscordId of hostDiscordIds) {
        const member = guild.members.cache.get(hostDiscordId);
        if (member && !member.roles.cache.has(hostRole.id)) {
          await syncQueue.enqueueAsync('role', `${member.id}:${hostRole.id}`, async () => {
            await member.roles.add(hostRole);
          });
        }
      }

      for (const [memberId, member] of guild.members.cache) {
        if (member.roles.cache.has(hostRole.id) && !hostDiscordIds.has(memberId)) {
          await syncQueue.enqueueAsync('role_remove', `${member.id}:${hostRole.id}`, async () => {
            await member.roles.remove(hostRole);
          });
        }
      }
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
      .select('id, name, status')
      .neq('status', 'archived');

    if (error || !clusters) {
      console.error('[reconcileAllClusters] Could not fetch clusters:', error?.message);
      return results;
    }

    for (const c of clusters) {
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

    if (!cluster.discord_role_id || !cluster.discord_category_id) {
      await handleClusterCreated(client, cluster);
    }

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

module.exports = {
  getClusterEmoji,
  sanitizeChannelName,
  logSync,
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
};
