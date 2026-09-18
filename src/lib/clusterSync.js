const { ChannelType, PermissionFlagsBits } = require('discord.js');
const supabase = require('./supabase');
const api = require('./api');
const syncQueue = require('./syncQueue');

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

    // 5. Create or find Private Category
    // Category name e.g. "Product Design" or "📁 Product Design"
    let category = guild.channels.cache.find(
      (c) =>
        c.type === ChannelType.GuildCategory &&
        c.name.toLowerCase().replace(/[^a-z0-9]/g, '') === clusterName.toLowerCase().replace(/[^a-z0-9]/g, '')
    );

    // Permissions: default-deny @everyone, allow member role, allow host role with specific management perms
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
        name: clusterName,
        type: ChannelType.GuildCategory,
        permissionOverwrites,
        reason: `Private category for cluster: ${clusterName}`,
      });
    } else {
      // Sync permissions on category to ensure member & host roles have access
      await category.permissionOverwrites.set(permissionOverwrites).catch(() => {});
    }

    // 6. Ensure all 5 required channels exist inside the private category
    // 1) Discussion/doubt-clearing
    // 2) Resources
    // 3) Challenges/tasks
    // 4) Projects
    // 5) Live sessions (voice)

    const expectedChannels = [
      {
        name: 'discussion-and-doubts',
        type: ChannelType.GuildText,
        topic: `${clusterName} • Open discussion, questions, and doubt-clearing.`,
      },
      {
        name: 'resources',
        type: ChannelType.GuildText,
        topic: `${clusterName} • Curated learning materials, docs, and resources.`,
      },
      {
        name: 'challenges-and-tasks',
        type: ChannelType.GuildText,
        topic: `${clusterName} • Weekly challenges, milestones, and task checklists.`,
      },
      {
        name: 'projects',
        type: ChannelType.GuildText,
        topic: `${clusterName} • Showcase projects, demos, and collaborate.`,
      },
      {
        name: '🔊 Live Sessions',
        type: ChannelType.GuildVoice,
      },
    ];

    for (const spec of expectedChannels) {
      const existing = guild.channels.cache.find(
        (c) => c.parentId === category.id && c.name.toLowerCase() === spec.name.toLowerCase()
      );

      if (!existing) {
        await guild.channels.create({
          name: spec.name,
          type: spec.type,
          parent: category.id,
          topic: spec.topic || undefined,
          reason: `Cluster channel for ${clusterName}`,
        });
      }
    }

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
          }
        } catch (_) {}
      }

      // 2. Revoke member role from members who were removed from cluster
      for (const [, member] of guild.members.cache) {
        if (member.roles.cache.has(memberRole.id) && !linkedDiscordUserIds.has(member.id)) {
          await member.roles.remove(memberRole).catch(() => {});
        }
      }

      // 3. Reconcile Host Role
      if (hostRole) {
        if (hostDiscordUserId) {
          const hostMember = guild.members.cache.get(hostDiscordUserId) ||
            (await guild.members.fetch(hostDiscordUserId).catch(() => null));
          if (hostMember && !hostMember.roles.cache.has(hostRole.id)) {
            await hostMember.roles.add(hostRole).catch(() => {});
          }
        }

        // Revoke host role from anyone who is not the current leader
        for (const [, member] of guild.members.cache) {
          if (member.roles.cache.has(hostRole.id) && member.id !== hostDiscordUserId) {
            await member.roles.remove(hostRole).catch(() => {});
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
async function syncChapterClusters(client, chapterId) {
  if (!client || !chapterId) return;
  try {
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
