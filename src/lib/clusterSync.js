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
 * Synchronizes private category, required channels, roles, and membership for a cluster.
 *
 * @param {import('discord.js').Client} client
 * @param {string} clusterId - Supabase Cluster UUID
 */
async function syncCluster(client, clusterId) {
  if (!client || !clusterId) return;

  try {
    // 1. Fetch cluster data from Supabase
    const { data: cluster, error: clErr } = await supabase
      .from('clusters')
      .select('*')
      .eq('id', clusterId)
      .maybeSingle();

    if (clErr || !cluster) {
      console.error(`[clusterSync] Could not fetch cluster ${clusterId}:`, clErr?.message);
      return;
    }

    if (!cluster.chapter_id) return;

    // 2. Find the Discord guild for this chapter
    const { data: guildConfig } = await supabase
      .from('guild_config')
      .select('guild_id')
      .eq('chapter_id', cluster.chapter_id)
      .eq('guild_type', 'chapter')
      .maybeSingle();

    if (!guildConfig?.guild_id) {
      // Chapter does not have a provisioned Discord server yet
      return;
    }

    const guild = client.guilds.cache.get(guildConfig.guild_id) ||
      (await client.guilds.fetch(guildConfig.guild_id).catch(() => null));

    if (!guild) return;

    const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
    if (!me || !me.permissions.has([PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles])) {
      console.warn(`[clusterSync] Bot lacks ManageChannels or ManageRoles in guild ${guild.id}`);
      return;
    }

    const clusterName = cluster.name || 'Unnamed Cluster';
    const memberRoleName = `${clusterName} Member`;
    const hostRoleName = `${clusterName} Host`;

    // 3. Create or find "<Cluster Name> Member" role
    let memberRole = guild.roles.cache.find(
      (r) => r.name.toLowerCase().trim() === memberRoleName.toLowerCase().trim()
    );
    if (!memberRole) {
      memberRole = await guild.roles.create({
        name: memberRoleName,
        color: 0x3B82F6, // Blue
        reason: `Role for members of cluster: ${clusterName}`,
      });
    }

    // 4. Create or find "<Cluster Name> Host" role (if cluster.leader_id exists or host role already present)
    let hostRole = guild.roles.cache.find(
      (r) => r.name.toLowerCase().trim() === hostRoleName.toLowerCase().trim()
    );
    if (!hostRole && cluster.leader_id) {
      hostRole = await guild.roles.create({
        name: hostRoleName,
        color: 0x8B5CF6, // Purple
        reason: `Role for host of cluster: ${clusterName}`,
      });
    }

    // 5. Create or find Campus Lead Role to grant category access
    const campusLeadRoleName = config.roles.campusLead || 'Campus Lead';
    let campusLeadRole = guild.roles.cache.find(
      (r) => r.name.toLowerCase().trim() === campusLeadRoleName.toLowerCase().trim()
    );
    if (!campusLeadRole) {
      campusLeadRole = await guild.roles.create({
        name: campusLeadRoleName,
        color: 0xF59E0B,
        reason: 'ElevatesOS Campus Lead Role',
      }).catch(() => null);
    }

    // 6. Create or find Private Category
    // Category name format: "<emoji>・<CLUSTER NAME IN UPPERCASE>" (e.g. "🛡️・CYBERSECURITY")
    const clusterEmoji = getClusterEmoji(cluster);
    const categoryName = `${clusterEmoji}・${clusterName.toUpperCase()}`;

    let category = guild.channels.cache.find(
      (c) =>
        c.type === ChannelType.GuildCategory &&
        (
          c.name.trim().toLowerCase() === categoryName.trim().toLowerCase() ||
          c.name.toLowerCase().replace(/[^a-z0-9]/g, '') === clusterName.toLowerCase().replace(/[^a-z0-9]/g, '')
        )
    );

    // Permissions: default-deny @everyone, allow bot, allow member role, allow host role, allow campus lead role
    const permissionOverwrites = [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
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
      {
        id: memberRole.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.Connect,
          PermissionFlagsBits.Speak,
        ],
      },
    ];

    // Campus Lead access: grant the chapter's Campus Lead role View Channel + Send Messages on cluster category
    if (campusLeadRole) {
      permissionOverwrites.push({
        id: campusLeadRole.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.Connect,
          PermissionFlagsBits.Speak,
        ],
      });
    }

    if (hostRole) {
      // Host permissions scoped to this category ONLY:
      // Manage messages, pin messages, manage voice channel. NOT server-wide kick/ban.
      permissionOverwrites.push({
        id: hostRole.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageMessages,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.Connect,
          PermissionFlagsBits.Speak,
          PermissionFlagsBits.MuteMembers,
          PermissionFlagsBits.DeafenMembers,
          PermissionFlagsBits.MoveMembers,
        ],
      });
    }

    if (!category) {
      category = await guild.channels.create({
        name: categoryName,
        type: ChannelType.GuildCategory,
        permissionOverwrites,
        reason: `Private category for cluster: ${clusterName}`,
      });
    } else {
      // Update name to new emoji format if needed
      if (category.name !== categoryName) {
        await category.setName(categoryName).catch(() => {});
      }
      // Sync permissions on category to ensure member, host, and campus lead roles have access
      await category.permissionOverwrites.set(permissionOverwrites).catch((err) => {
        console.warn(`[clusterSync] Could not set category overwrites for ${clusterName}:`, err.message);
      });
    }

    // 7. Ensure all 6 required channels exist inside the private category:
    // - #announcements → Announcement channel type
    // - #discussion → Forum channel type
    // - #resources → Forum channel type
    // - #challenges → Forum channel type
    // - #projects → Forum channel type
    // - #cluster-room → Voice channel
    const expectedChannels = [
      {
        name: 'announcements',
        type: ChannelType.GuildAnnouncement,
        topic: `${clusterName} • Official announcements and cluster updates.`,
        fallbackType: ChannelType.GuildText,
      },
      {
        name: 'discussion',
        type: ChannelType.GuildForum,
        topic: `${clusterName} • Open discussion, questions, and doubt-clearing.`,
        fallbackType: ChannelType.GuildText,
      },
      {
        name: 'resources',
        type: ChannelType.GuildForum,
        topic: `${clusterName} • Curated learning materials, docs, and resources.`,
        fallbackType: ChannelType.GuildText,
      },
      {
        name: 'challenges',
        type: ChannelType.GuildForum,
        topic: `${clusterName} • Weekly challenges, milestones, and task submissions.`,
        fallbackType: ChannelType.GuildText,
      },
      {
        name: 'projects',
        type: ChannelType.GuildForum,
        topic: `${clusterName} • Showcase projects, demos, and collaborate.`,
        fallbackType: ChannelType.GuildText,
      },
      {
        name: 'cluster-room',
        type: ChannelType.GuildVoice,
      },
    ];

    const channelMap = {};

    for (const spec of expectedChannels) {
      let existing = guild.channels.cache.find(
        (c) => c.parentId === category.id && c.name.toLowerCase() === spec.name.toLowerCase()
      );

      if (!existing) {
        try {
          existing = await guild.channels.create({
            name: spec.name,
            type: spec.type,
            parent: category.id,
            topic: spec.topic || undefined,
            reason: `Cluster channel for ${clusterName}`,
          });
        } catch (createErr) {
          // Fallback if guild does not have COMMUNITY feature enabled
          if (spec.fallbackType) {
            console.warn(`[clusterSync] Failed to create ${spec.name} as type ${spec.type}, attempting fallback to ${spec.fallbackType}:`, createErr.message);
            existing = await guild.channels.create({
              name: spec.name,
              type: spec.fallbackType,
              parent: category.id,
              topic: spec.topic || undefined,
              reason: `Cluster channel fallback for ${clusterName}`,
            }).catch((err) => {
              console.error(`[clusterSync] Failed fallback creation for ${spec.name}:`, err.message);
              return null;
            });
          } else {
            console.error(`[clusterSync] Failed to create channel ${spec.name}:`, createErr.message);
          }
        }
      }

      if (existing) {
        channelMap[spec.name] = existing.id;
      }
    }

    // Persist Discord mappings for this cluster
    await supabase
      .from('cluster_discord_mappings')
      .upsert(
        {
          cluster_id: cluster.id,
          guild_id: guild.id,
          category_id: category.id,
          member_role_id: memberRole.id,
          host_role_id: hostRole ? hostRole.id : null,
          discussion_channel_id: channelMap['discussion'] || null,
          resources_channel_id: channelMap['resources'] || null,
          challenges_channel_id: channelMap['challenges'] || null,
          projects_channel_id: channelMap['projects'] || null,
          voice_channel_id: channelMap['cluster-room'] || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'cluster_id,guild_id' }
      )
      .catch((err) => {
        console.warn(`[clusterSync] Could not upsert cluster_discord_mappings for ${cluster.id}:`, err?.message);
      });

    // 7. Synchronize Cluster Membership
    // Read member user IDs from cluster_members table and cluster.member_ids array
    const memberUserIdSet = new Set(Array.isArray(cluster.member_ids) ? cluster.member_ids : []);

    const { data: dbMembers } = await supabase
      .from('cluster_members')
      .select('user_id')
      .eq('cluster_id', cluster.id);

    if (dbMembers) {
      for (const m of dbMembers) {
        if (m.user_id) memberUserIdSet.add(m.user_id);
      }
    }

    // Fetch profiles for these member user IDs
    const memberUserIds = Array.from(memberUserIdSet);
    let linkedDiscordUserIds = new Set();

    if (memberUserIds.length > 0) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, discord_user_id, discord_connected')
        .in('id', memberUserIds)
        .eq('discord_connected', true);

      if (profiles) {
        for (const p of profiles) {
          if (p.discord_user_id) linkedDiscordUserIds.add(p.discord_user_id);
        }
      }
    }

    // Identify Host discord user ID if cluster.leader_id is set
    let hostDiscordUserId = null;
    if (cluster.leader_id) {
      const { data: leaderProfile } = await supabase
        .from('profiles')
        .select('discord_user_id, discord_connected')
        .eq('id', cluster.leader_id)
        .maybeSingle();

      if (leaderProfile?.discord_connected && leaderProfile.discord_user_id) {
        hostDiscordUserId = leaderProfile.discord_user_id;
        // Host is also a member
        linkedDiscordUserIds.add(hostDiscordUserId);
      }
    }

    // Enqueue role sync in queue to avoid rate limits
    syncQueue.enqueue('cluster', cluster.id, async () => {
      // 1. Assign member role to all verified members in this cluster
      for (const discordId of linkedDiscordUserIds) {
        try {
          const member = guild.members.cache.get(discordId) ||
            (await guild.members.fetch(discordId).catch(() => null));
          if (member && !member.roles.cache.has(memberRole.id)) {
            await member.roles.add(memberRole);
            api.logChapterEvent(client, cluster.chapter_id, guild.id, 'cluster_member_added', {
              clusterName,
              clusterId: cluster.id,
              discord_user_id: discordId,
              memberTag: member.user?.tag,
            }).catch(() => {});
          }
        } catch (_) {}
      }

      // 2. Revoke member role from members who were removed from cluster
      for (const [, member] of guild.members.cache) {
        if (member.roles.cache.has(memberRole.id) && !linkedDiscordUserIds.has(member.id)) {
          await member.roles.remove(memberRole).catch(() => {});
          api.logChapterEvent(client, cluster.chapter_id, guild.id, 'cluster_member_removed', {
            clusterName,
            clusterId: cluster.id,
            discord_user_id: member.id,
            memberTag: member.user?.tag,
          }).catch(() => {});
        }
      }

      // 3. Reconcile Host Role
      if (hostRole) {
        if (hostDiscordUserId) {
          const hostMember = guild.members.cache.get(hostDiscordUserId) ||
            (await guild.members.fetch(hostDiscordUserId).catch(() => null));
          if (hostMember && !hostMember.roles.cache.has(hostRole.id)) {
            await hostMember.roles.add(hostRole).catch(() => {});
            api.logChapterEvent(client, cluster.chapter_id, guild.id, 'cluster_host_assigned', {
              clusterName,
              clusterId: cluster.id,
              discord_user_id: hostDiscordUserId,
              hostTag: hostMember.user?.tag,
            }).catch(() => {});
          }
        }

        // Revoke host role from anyone who is not the current leader
        for (const [, member] of guild.members.cache) {
          if (member.roles.cache.has(hostRole.id) && member.id !== hostDiscordUserId) {
            await member.roles.remove(hostRole).catch(() => {});
            api.logChapterEvent(client, cluster.chapter_id, guild.id, 'cluster_host_removed', {
              clusterName,
              clusterId: cluster.id,
              discord_user_id: member.id,
              hostTag: member.user?.tag,
            }).catch(() => {});
          }
        }
      }
    });
  } catch (err) {
    console.error(`[clusterSync] Error syncing cluster ${clusterId}:`, err);
  }
}

/**
 * Synchronizes all clusters for a given chapter.
 */
async function syncChapterClusters(client, chapterIdOrIdentifier) {
  if (!client || !chapterIdOrIdentifier) return;
  try {
    const api = require('./api');
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
    console.error(`[syncChapterClusters] Error:`, err);
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
  syncCluster,
  syncChapterClusters,
  syncAllClusters,
};
