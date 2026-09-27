const supabase = require('./supabase');
const api = require('./api');
const config = require('../config');
const {
  syncCluster,
  syncAllClusters,
  handleClusterCreated,
  handleClusterArchived,
  handleMemberAdded,
  handleMemberRemoved,
  handleUserLinked,
  processClusterInsert,
  reconcileUnprovisionedClusters,
  reconcileAllClusters,
  reconcileClusterMembers,
  invalidateClusterCache,
  setUserToDiscordCache,
  invalidateUserToDiscordCache,
} = require('./clusterSync');
const { ensureLinkChannel } = require('./accountLinking');
const { checkMainGuildRoleSanity } = require('./roleSanityCheck');

let lastReconcileTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
const userRoleToUserMap = new Map(); // id -> user_id for tracking DELETE events
const osUserToDiscordMap = new Map(); // osUserId -> discordUserId
const discordLinkToUserMap = new Map(); // linkId -> { discordUserId, osUserId, status }
const clusterKnownMembersCache = new Map(); // clusterId -> string[] member_ids
// Short-lived cluster metadata cache to avoid repeated Supabase lookups in event handlers
const clusterMetaCache = new Map(); // clusterId -> { name, chapter_id, cachedAt }
const CLUSTER_META_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let activeRealtimeChannel = null;
let isRealtimeSubscribed = false;
let isReconnecting = false;
let reconnectTimer = null;
let reconnectAttempts = 0;

let lastKnownGoodConnection = null;
let lastDisconnectedAt = null;
let lastReconnectedAt = null;
let lastDisconnectReason = null;

let reconciliationIntervalTimer = null;
let isReconciliationRunning = false;

/**
 * Initializes Supabase Realtime listeners and a resilient polling reconciliation loop
 * for role sync, chapter changes, and cluster management.
 *
 * @param {import('discord.js').Client} client
 */
function initRealtimeSync(client) {
  if (!supabase) return;

  console.log('[RealtimeSync] Initializing Supabase Realtime listeners and reconciliation engine...');

  // Ensure #link-server exists in all currently connected guilds on ready (parallelized per Section 5.5)
  Promise.all(
    Array.from(client.guilds.cache.values()).map((guild) =>
      ensureLinkChannel(guild).catch(() => {})
    )
  ).catch(() => {});

  // Pre-populate userRoleToUserMap so DELETE events in user_roles know the user_id, role, and chapter
  supabase
    .from('user_roles')
    .select('id, user_id, role_key, role, chapter_id')
    .then(({ data }) => {
      if (data) {
        for (const r of data) {
          if (r.id) {
            userRoleToUserMap.set(r.id, {
              userId: r.user_id,
              roleKey: r.role_key || r.role,
              chapterId: r.chapter_id,
            });
          }
        }
        console.log(`[RealtimeSync] Cached ${userRoleToUserMap.size} user_role mapping(s) for DELETE tracking.`);
      }
    })
    .catch(() => {});

  // Pre-populate osUserToDiscordMap from profiles for tracking disconnects
  supabase
    .from('profiles')
    .select('id, discord_user_id')
    .not('discord_user_id', 'is', null)
    .then(({ data }) => {
      if (data) {
        for (const p of data) {
          if (p.id && p.discord_user_id) {
            osUserToDiscordMap.set(p.id, p.discord_user_id);
          }
        }
      }
    })
    .catch(() => {});

  // Pre-populate discordLinkToUserMap from discord_links for tracking unlinks
  supabase
    .from('discord_links')
    .select('id, os_user_id, discord_user_id, status')
    .then(({ data }) => {
      if (data) {
        for (const l of data) {
          if (l.id) {
            discordLinkToUserMap.set(l.id, {
              discordUserId: l.discord_user_id,
              osUserId: l.os_user_id,
              status: l.status,
            });
            if (l.os_user_id && l.discord_user_id && l.status === 'linked') {
              osUserToDiscordMap.set(l.os_user_id, l.discord_user_id);
            }
          }
        }
      }
    })
    .catch(() => {});

  // Initial full reconciliation: provisions unprovisioned clusters, resolves pending roles, syncs users & cleans unlinked, deduplicates categories
  runFullReconciliation(client).catch((err) =>
    console.error('[RealtimeSync] Initial full reconciliation error:', err.message)
  );

  setupRealtimeChannel(client);
  startPollingLoop(client);
  startReconciliationInterval(client);
}

/**
 * Creates and registers the Supabase Realtime channel subscription.
 */
function setupRealtimeChannel(client) {
  if (!supabase) return null;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (activeRealtimeChannel) {
    try {
      supabase.removeChannel(activeRealtimeChannel).catch(() => {});
    } catch (_) {}
    activeRealtimeChannel = null;
  }

  isRealtimeSubscribed = false;
  isReconnecting = false;

  try {
    const channelName = `elevates_bot_realtime_${Date.now()}`;
    const channel = supabase
      .channel(channelName)
      // 1. Listen to profiles table (identity, chapter changes, name changes, connection state)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'profiles' },
        async (payload) => {
          try {
            const newRow = payload.new;
            const oldRow = payload.old;
            const userId = newRow?.id || oldRow?.id;
            let discordUserId = newRow?.discord_user_id || oldRow?.discord_user_id;
            let chapterId = newRow?.chapter_id || oldRow?.chapter_id;

            // Use cached Discord ID if disconnected or missing from payload
            const cachedDiscordId = userId ? osUserToDiscordMap.get(userId) : null;
            if (!discordUserId && cachedDiscordId) {
              discordUserId = cachedDiscordId;
            }

            const isDisconnected = Boolean(
              newRow &&
              (newRow.discord_connected === false || (newRow.discord_user_id === null && cachedDiscordId))
            );

            if (isDisconnected && userId) {
              osUserToDiscordMap.delete(userId);
              invalidateUserToDiscordCache(userId);
            }
            if (newRow?.discord_connected && newRow?.discord_user_id && userId) {
              osUserToDiscordMap.set(userId, newRow.discord_user_id);
              setUserToDiscordCache(userId, newRow.discord_user_id);
            }

            // Check if designation or role changed
            const oldDes = oldRow?.designation;
            const newDes = newRow?.designation;
            const oldRole = oldRow?.role;
            const newRole = newRow?.role;

            let removedProfileRole = null;
            if (oldRole && oldRole !== newRole) removedProfileRole = oldRole;
            else if (oldDes && oldDes !== newDes) removedProfileRole = oldDes;

            if (discordUserId || userId) {
              console.log(`[RealtimeSync] Profile change detected for user ${userId || discordUserId} (${payload.eventType})`);
              await api.syncUserAcrossGuilds(client, discordUserId, userId, removedProfileRole);

              if (newRow?.discord_connected && (!oldRow || !oldRow.discord_connected)) {
                handleUserLinked(client, newRow).catch((err) =>
                  console.error('[RealtimeSync] Error resolving pending roles on profile connect:', err)
                );
              }

              if (!chapterId && userId) {
                const { data: p } = await supabase.from('profiles').select('chapter_id').eq('id', userId).maybeSingle();
                if (p?.chapter_id) chapterId = p.chapter_id;
              }
              if (!chapterId && discordUserId) {
                for (const [, g] of client.guilds.cache) {
                  if (g.members.cache.has(discordUserId)) {
                    const gConf = await api.getGuildConfig(g.id).catch(() => null);
                    if (gConf?.guildType === 'chapter' && gConf.chapterId) {
                      chapterId = gConf.chapterId;
                      break;
                    }
                  }
                }
              }

              if (chapterId && (oldDes !== newDes || oldRole !== newRole)) {
                await api.logChapterEvent(
                  client,
                  chapterId,
                  null,
                  'designation_updated',
                  {
                    user: newRow?.discord_user_id ? `<@${newRow.discord_user_id}> (${newRow.full_name || 'Member'})` : (newRow?.full_name || 'Member'),
                    previous_designation: oldDes || oldRole || 'None',
                    new_designation: newDes || newRole || 'None',
                    discord_user_id: newRow?.discord_user_id || null,
                  },
                  'role_changes'
                );
                await api.updateChapterCurrentRolesTopic(client, chapterId);
              }

              // Check if Discord connection status changed
              const oldConnected = oldRow?.discord_connected;
              const newConnected = newRow?.discord_connected;
              if (chapterId && oldConnected !== newConnected) {
                await api.logChapterEvent(
                  client,
                  chapterId,
                  null,
                  newConnected ? 'account_linked' : 'account_unlinked',
                  {
                    user: newRow?.discord_user_id ? `<@${newRow.discord_user_id}> (${newRow.full_name || 'Member'})` : (newRow?.full_name || 'Member'),
                    discord_user_id: newRow?.discord_user_id || null,
                    elevates_id: newRow?.elevates_id || 'N/A',
                  },
                  'membership'
                );
              }
            }
          } catch (err) {
            console.error('[RealtimeSync] Error processing profiles change:', err);
          }
        }
      )
      // 2. Listen to user_roles table (role added, role changed, role removed)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'user_roles' },
        async (payload) => {
          try {
            let userId = payload.new?.user_id || payload.old?.user_id;
            let roleKey = payload.new?.role_key || payload.old?.role_key || payload.new?.role || payload.old?.role;
            let chapterId = payload.new?.chapter_id || payload.old?.chapter_id;
            let removedRoleKey = null;

            if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
              if (payload.eventType === 'UPDATE') {
                const oldKey = payload.old?.role_key || payload.old?.role || (payload.old?.id && userRoleToUserMap.get(payload.old.id)?.roleKey);
                const newKey = payload.new?.role_key || payload.new?.role;
                if (oldKey && oldKey !== newKey) {
                  removedRoleKey = oldKey;
                }
              }
              if (payload.new?.id) {
                userRoleToUserMap.set(payload.new.id, {
                  userId: payload.new.user_id,
                  roleKey: payload.new.role_key || payload.new.role,
                  chapterId: payload.new.chapter_id,
                });
              }
            } else if (payload.eventType === 'DELETE') {
              if (payload.old?.id) {
                const cachedRole = userRoleToUserMap.get(payload.old.id);
                if (cachedRole) {
                  userId = userId || cachedRole.userId;
                  roleKey = roleKey || cachedRole.roleKey;
                  chapterId = chapterId || cachedRole.chapterId;
                  userRoleToUserMap.delete(payload.old.id);
                }
              }
              removedRoleKey = roleKey;
            }

            if (userId) {
              console.log(`[RealtimeSync] user_roles change detected for user ${userId} (${payload.eventType}): role=${roleKey || 'unspecified'}`);
              await api.syncUserAcrossGuilds(client, null, userId, removedRoleKey);

              // Query profile to resolve user details and chapter
              const { data: userProfile } = await supabase
                .from('profiles')
                .select('id, full_name, discord_user_id, chapter_id')
                .eq('id', userId)
                .maybeSingle();

              if (!chapterId && userProfile?.chapter_id) {
                chapterId = userProfile.chapter_id;
              }

              if (!chapterId && userProfile?.discord_user_id) {
                for (const [, g] of client.guilds.cache) {
                  if (g.members.cache.has(userProfile.discord_user_id)) {
                    const gConf = await api.getGuildConfig(g.id).catch(() => null);
                    if (gConf?.guildType === 'chapter' && gConf.chapterId) {
                      chapterId = gConf.chapterId;
                      break;
                    }
                  }
                }
              }

              if (chapterId) {
                const targetUserStr = userProfile?.discord_user_id
                  ? `<@${userProfile.discord_user_id}> (${userProfile.full_name || 'Member'})`
                  : (userProfile?.full_name || 'Member');

                const logType = payload.eventType === 'INSERT'
                  ? 'role_assigned'
                  : payload.eventType === 'DELETE'
                  ? 'role_revoked'
                  : 'role_updated';

                api.logChapterEvent(
                  client,
                  chapterId,
                  null,
                  logType,
                  {
                    user: targetUserStr,
                    role: (roleKey || 'Unspecified Role').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
                    status: payload.eventType,
                    discord_user_id: userProfile?.discord_user_id || null,
                  },
                  'role_changes'
                ).catch(() => {});

                // Dynamically update the chapter's live roster in 👥 Current Roles
                api.updateChapterCurrentRolesTopic(client, chapterId).catch(() => {});
              }
            } else {
              console.log(`[RealtimeSync] user_roles ${payload.eventType} event received without cached userId. Triggering full user reconciliation.`);
              await reconcileAllConnectedUsers(client);
            }
          } catch (err) {
            console.error('[RealtimeSync] Error processing user_roles change:', err);
          }
        }
      )
      // 3. Listen to roles table (role definitions, name changes)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'roles' },
        async (payload) => {
          try {
            console.log('[RealtimeSync] Roles definition change detected. Refreshing active guilds...');
            api.invalidateOsRolesCache();
            reconcileRecentChanges(client).catch(() => {});
          } catch (err) {
            console.error('[RealtimeSync] Error processing roles change:', err);
          }
        }
      )
      // 4. Listen to clusters table (cluster added, archived, renamed, leader changed)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'clusters' },
        async (payload) => {
          try {
            const clusterId = payload.new?.id || payload.old?.id;
            if (!clusterId) return;

            console.log(`[RealtimeSync] Clusters change detected for cluster ${clusterId} (${payload.eventType})`);

            // Keep cluster metadata cache fresh from the payload (free data we already have)
            if (payload.new?.name || payload.new?.chapter_id) {
              clusterMetaCache.set(clusterId, {
                name: payload.new.name,
                chapter_id: payload.new.chapter_id,
                cachedAt: Date.now(),
              });
            } else if (payload.eventType === 'DELETE' || payload.eventType === 'archived') {
              clusterMetaCache.delete(clusterId);
            }

            if (payload.eventType === 'INSERT') {
              await processClusterInsert(client, payload.new);
            } else if (payload.eventType === 'UPDATE' && payload.new?.status === 'archived' && payload.old?.status !== 'archived') {
              invalidateClusterCache(clusterId);
              clusterMetaCache.delete(clusterId);
              await handleClusterArchived(client, payload.new);
            } else if (payload.eventType === 'UPDATE') {
              invalidateClusterCache(clusterId);
              // 1. Membership sync via member_ids array diffing in parallel
              const cachedKnownMembers = clusterKnownMembersCache.get(clusterId);
              const oldMembers = Array.isArray(payload.old?.member_ids)
                ? payload.old.member_ids
                : (Array.isArray(cachedKnownMembers) ? cachedKnownMembers : []);
              const newMembers = Array.isArray(payload.new?.member_ids) ? payload.new.member_ids : [];
              if (newMembers.length > 0) {
                clusterKnownMembersCache.set(clusterId, newMembers);
              }

              // user_id in NEW.member_ids but not OLD.member_ids -> member add
              const addedUserIds = newMembers.filter((u) => !oldMembers.includes(u));
              await Promise.all(
                addedUserIds.map(async (uId) => {
                  console.log(`[RealtimeSync] Member added to cluster ${clusterId} via array diff: ${uId}`);
                  return handleMemberAdded(client, {
                    cluster_id: clusterId,
                    user_id: uId,
                    role_in_cluster: 'member',
                  });
                })
              );

              // user_id in OLD.member_ids but not NEW.member_ids -> member removal
              const removedUserIds = oldMembers.filter((u) => !newMembers.includes(u));
              await Promise.all(
                removedUserIds.map(async (uId) => {
                  console.log(`[RealtimeSync] Member removed from cluster ${clusterId} via array diff: ${uId}`);
                  return handleMemberRemoved(client, {
                    cluster_id: clusterId,
                    user_id: uId,
                    role_in_cluster: 'member',
                  });
                })
              );

              // 2. Host-role logic via leader_id compare on UPDATE
              const oldLeaderId = payload.old?.leader_id;
              const newLeaderId = payload.new?.leader_id;
              if (newLeaderId && newLeaderId !== oldLeaderId) {
                console.log(`[RealtimeSync] Cluster ${clusterId} leader assigned: ${newLeaderId}`);
                await handleMemberAdded(client, {
                  cluster_id: clusterId,
                  user_id: newLeaderId,
                  role_in_cluster: 'host',
                });
              }
              if (oldLeaderId && oldLeaderId !== newLeaderId) {
                console.log(`[RealtimeSync] Cluster ${clusterId} leader removed: ${oldLeaderId}`);
                await handleMemberRemoved(client, {
                  cluster_id: clusterId,
                  user_id: oldLeaderId,
                  role_in_cluster: 'host',
                });
              }

              // 3. Full cluster reconciliation to guarantee exact role sync and category permission privacy
              await reconcileClusterMembers(client, clusterId).catch((rErr) =>
                console.warn(`[RealtimeSync] Error in reconcileClusterMembers for cluster ${clusterId}:`, rErr.message)
              );

              // If name or access_mode changed, re-sync cluster structure
              if (
                payload.new?.name !== payload.old?.name ||
                payload.new?.access_mode !== payload.old?.access_mode ||
                payload.new?.status !== payload.old?.status
              ) {
                await syncCluster(client, clusterId);
              }
            } else if (payload.eventType === 'DELETE') {
              invalidateClusterCache(clusterId);
            }

            if (payload.eventType !== 'INSERT') {
              const chapterId = payload.new?.chapter_id || payload.old?.chapter_id;
              if (chapterId) {
                const clusterName = payload.new?.name || payload.old?.name || 'Cluster';
                const logType = payload.eventType === 'DELETE' ? 'cluster_deleted' : 'cluster_updated';
                await api.logChapterEvent(
                  client,
                  chapterId,
                  null,
                  logType,
                  {
                    cluster: clusterName,
                    status: payload.new?.status || 'active',
                    change_type: payload.eventType,
                  },
                  'cluster_activity'
                );
              }
            }
          } catch (err) {
            console.error('[RealtimeSync] Error processing clusters change:', err);
          }
        }
      )
      // 5. Listen to cluster_members table (member added/removed)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'cluster_members' },
        async (payload) => {
          try {
            const clusterId = payload.new?.cluster_id || payload.old?.cluster_id;
            if (!clusterId) return;

            console.log(`[RealtimeSync] cluster_members change detected for cluster ${clusterId} (${payload.eventType})`);

            const userId = payload.new?.user_id || payload.old?.user_id;

            // Run member action + cluster meta fetch in parallel (meta uses cache when available)
            const [, clData] = await Promise.all([
              payload.eventType === 'INSERT' || payload.eventType === 'UPDATE'
                ? handleMemberAdded(client, payload.new)
                : payload.eventType === 'DELETE'
                ? handleMemberRemoved(client, payload.old)
                : syncCluster(client, clusterId),
              (async () => {
                const cached = clusterMetaCache.get(clusterId);
                if (cached && Date.now() - cached.cachedAt < CLUSTER_META_CACHE_TTL_MS) {
                  return cached;
                }
                const { data } = await supabase.from('clusters').select('name, chapter_id').eq('id', clusterId).maybeSingle();
                if (data) clusterMetaCache.set(clusterId, { ...data, cachedAt: Date.now() });
                return data;
              })(),
            ]);

            if (clData?.chapter_id) {
              let memberStr = 'Member';
              if (userId) {
                const { data: p } = await supabase.from('profiles').select('full_name, discord_user_id').eq('id', userId).maybeSingle();
                if (p) {
                  memberStr = p.discord_user_id ? `<@${p.discord_user_id}> (${p.full_name})` : (p.full_name || 'Member');
                }
              }

              const logType = payload.eventType === 'INSERT' ? 'cluster_member_added' : payload.eventType === 'DELETE' ? 'cluster_member_removed' : 'cluster_member_updated';
              api.logChapterEvent(
                client,
                clData.chapter_id,
                null,
                logType,
                {
                  cluster: clData.name,
                  member: memberStr,
                  role: payload.new?.role_in_cluster || payload.new?.role || payload.old?.role_in_cluster || payload.old?.role || 'member',
                  change_type: payload.eventType,
                },
                'cluster_activity'
              ).catch(() => {});
            }
          } catch (err) {
            console.error('[RealtimeSync] Error processing cluster_members change:', err);
          }
        }
      )
      // 6. Listen to discord_verification_codes table (immediate OTP verification trigger)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'discord_verification_codes' },
        async (payload) => {
          try {
            const row = payload.new;
            if (row && row.status === 'verified') {
              console.log(`[RealtimeSync] OTP verified on web for user ${row.os_user_id} (${row.discord_user_id})`);
              // Ensure any other OS profile holding this discord_user_id is disconnected (enforce 1:1)
              if (row.discord_user_id && row.os_user_id) {
                try {
                  await supabase
                    .from('profiles')
                    .update({
                      discord_connected: false,
                      discord_user_id: null,
                      discord_username: null,
                      updated_at: new Date().toISOString(),
                    })
                    .eq('discord_user_id', row.discord_user_id)
                    .neq('id', row.os_user_id);

                  await supabase
                    .from('discord_links')
                    .update({
                      status: 'unlinked',
                      unlinked_at: new Date().toISOString(),
                      updated_at: new Date().toISOString(),
                    })
                    .eq('discord_user_id', row.discord_user_id)
                    .neq('os_user_id', row.os_user_id);
                } catch (_) {}
              }
              await handleUserLinked(client, { os_user_id: row.os_user_id, discord_user_id: row.discord_user_id });
              await api.syncUserAcrossGuilds(client, row.discord_user_id, row.os_user_id);
            }
          } catch (err) {
            console.error('[RealtimeSync] Error processing discord_verification_codes change:', err);
          }
        }
      )
      // 7. Listen to discord_links table (link events, unlinks, and pending role resolution)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'discord_links' },
        async (payload) => {
          try {
            let discordUserId = payload.new?.discord_user_id;
            let osUserId = payload.new?.os_user_id;
            const status = payload.new?.status;

            if (payload.new?.id) {
              discordLinkToUserMap.set(payload.new.id, {
                discordUserId: payload.new.discord_user_id,
                osUserId: payload.new.os_user_id,
                status: payload.new.status,
              });
              if (payload.new.os_user_id && payload.new.discord_user_id && status === 'linked') {
                osUserToDiscordMap.set(payload.new.os_user_id, payload.new.discord_user_id);
                setUserToDiscordCache(payload.new.os_user_id, payload.new.discord_user_id);
              }
            }

            if (payload.eventType === 'DELETE' && payload.old?.id) {
              const cached = discordLinkToUserMap.get(payload.old.id);
              if (cached) {
                discordUserId = discordUserId || cached.discordUserId;
                osUserId = osUserId || cached.osUserId;
                discordLinkToUserMap.delete(payload.old.id);
              }
            }

            if (!discordUserId && osUserId) {
              discordUserId = osUserToDiscordMap.get(osUserId);
            }

            if (status === 'unlinked' || payload.eventType === 'DELETE') {
              if (osUserId) {
                osUserToDiscordMap.delete(osUserId);
                invalidateUserToDiscordCache(osUserId);
              }
            }

            if (discordUserId || osUserId) {
              if (payload.eventType === 'INSERT' || status === 'linked') {
                await handleUserLinked(client, { discord_user_id: discordUserId, os_user_id: osUserId });
              }
              await api.syncUserAcrossGuilds(client, discordUserId, osUserId);
            }
          } catch (err) {
            console.error('[RealtimeSync] Error processing discord_links change:', err);
          }
        }
      )
      // 8. Listen to chapters table (campus_lead_id assignment/change)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'chapters' },
        async (payload) => {
          try {
            const newLead = payload.new?.campus_lead_id;
            const oldLead = payload.old?.campus_lead_id;
            const chapterId = payload.new?.id || payload.old?.id;
            const chapterName = payload.new?.name || payload.old?.name || 'Chapter';

            if (newLead) {
              console.log(`[RealtimeSync] Chapter lead assigned (${newLead}). Syncing user roles...`);
              await api.syncUserAcrossGuilds(client, null, newLead);
            }
            if (oldLead && oldLead !== newLead) {
              console.log(`[RealtimeSync] Chapter lead revoked (${oldLead}). Syncing user roles...`);
              await api.syncUserAcrossGuilds(client, null, oldLead, 'campus_lead');
            }

            if (chapterId && oldLead !== newLead) {
              let leadName = 'Unassigned';
              let discordId = null;
              if (newLead) {
                const { data: p } = await supabase.from('profiles').select('full_name, discord_user_id').eq('id', newLead).maybeSingle();
                if (p) {
                  leadName = p.full_name || leadName;
                  discordId = p.discord_user_id;
                }
              }

              await api.logChapterEvent(
                client,
                chapterId,
                null,
                'campus_lead_assigned',
                {
                  chapter: chapterName,
                  new_campus_lead: discordId ? `<@${discordId}> (${leadName})` : leadName,
                  discord_user_id: discordId,
                },
                'role_changes'
              );

              await api.updateChapterCurrentRolesTopic(client, chapterId);
            }
          } catch (err) {
            console.error('[RealtimeSync] Error processing chapters change:', err);
          }
        }
      )
      // 9. Listen to events table (Event creation, schedule update, publishing, completion, cancellation)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'events' },
        async (payload) => {
          try {
            const row = payload.new || payload.old;
            if (!row) return;

            const chapterId = row.chapter_id;
            const eventTitle = row.title || 'Untitled Event';
            const eventType = payload.eventType;

            console.log(`[RealtimeSync] Event change detected: "${eventTitle}" (${eventType}) for chapter ${chapterId || 'global'}`);

            let logEventType = 'event_created';
            if (eventType === 'UPDATE') {
              logEventType = payload.new?.status === 'cancelled' ? 'event_cancelled' : 'event_updated';
            } else if (eventType === 'DELETE') {
              logEventType = 'event_deleted';
            }

            const detail = {
              title: eventTitle,
              category: row.category || row.event_type || 'General',
              status: row.status || 'draft',
              venue: row.venue || row.platform || 'TBD',
              starts_at: row.starts_at ? new Date(row.starts_at).toLocaleString() : 'TBD',
              ends_at: row.ends_at ? new Date(row.ends_at).toLocaleString() : 'TBD',
              mode: row.mode || 'offline',
              change_type: eventType,
            };

            if (chapterId) {
              await api.logChapterEvent(client, chapterId, null, logEventType, detail, 'events');
            }
          } catch (err) {
            console.error('[RealtimeSync] Error processing events change:', err);
          }
        }
      )
      // 10. Listen to forms table (Form creation, publishing, response status)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'forms' },
        async (payload) => {
          try {
            const row = payload.new || payload.old;
            if (!row) return;

            let chapterId = row.chapter_id;
            if (!chapterId && row.event_id) {
              const { data: ev } = await supabase.from('events').select('chapter_id').eq('id', row.event_id).maybeSingle();
              if (ev?.chapter_id) chapterId = ev.chapter_id;
            }

            const logEventType = payload.eventType === 'INSERT' ? 'form_created' : payload.eventType === 'DELETE' ? 'form_deleted' : 'form_updated';
            console.log(`[RealtimeSync] Form change detected: "${row.title}" (${logEventType}) for chapter ${chapterId || 'global'}`);

            if (chapterId) {
              await api.logChapterEvent(
                client,
                chapterId,
                null,
                logEventType,
                {
                  title: row.title || 'Untitled Form',
                  purpose: row.purpose || 'General',
                  status: row.status || 'active',
                  accepting_responses: row.accepting_responses ? 'Yes' : 'No',
                  is_published: row.is_published ? 'Yes' : 'No',
                  change_type: payload.eventType,
                },
                'events'
              );
            }
          } catch (err) {
            console.error('[RealtimeSync] Error processing forms change:', err);
          }
        }
      )
      // 11. Listen to attendance table (Attendee check-in)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'attendance' },
        async (payload) => {
          try {
            const row = payload.new;
            if (!row || !row.event_id) return;

            const { data: eventData } = await supabase
              .from('events')
              .select('id, title, chapter_id')
              .eq('id', row.event_id)
              .maybeSingle();

            if (!eventData?.chapter_id) return;

            let attendeeName = 'Unknown Member';
            let discordId = null;
            if (row.user_id) {
              const { data: attendeeProfile } = await supabase
                .from('profiles')
                .select('full_name, discord_user_id')
                .eq('id', row.user_id)
                .maybeSingle();
              if (attendeeProfile) {
                attendeeName = attendeeProfile.full_name || attendeeName;
                discordId = attendeeProfile.discord_user_id;
              }
            }

            console.log(`[RealtimeSync] Attendance recorded: "${attendeeName}" for event "${eventData.title}" in chapter ${eventData.chapter_id}`);

            await api.logChapterEvent(
              client,
              eventData.chapter_id,
              null,
              'attendance_checked_in',
              {
                event: eventData.title,
                attendee: discordId ? `<@${discordId}> (${attendeeName})` : attendeeName,
                status: row.status || 'checked_in',
                method: row.method || 'standard',
                session: row.session_name || 'General Session',
                checked_in_at: row.checked_in_at ? new Date(row.checked_in_at).toLocaleString() : new Date().toLocaleString(),
              },
              'events'
            );
          } catch (err) {
            console.error('[RealtimeSync] Error processing attendance change:', err);
          }
        }
      )
      // 12. Listen to cluster_tasks table (Task created, completed, updated)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'cluster_tasks' },
        async (payload) => {
          try {
            const row = payload.new || payload.old;
            if (!row || !row.cluster_id) return;

            const { data: clusterData } = await supabase
              .from('clusters')
              .select('id, name, chapter_id')
              .eq('id', row.cluster_id)
              .maybeSingle();

            if (!clusterData?.chapter_id) return;

            const logEventType = payload.eventType === 'INSERT' ? 'cluster_task_created' : payload.eventType === 'DELETE' ? 'cluster_task_deleted' : 'cluster_task_updated';
            console.log(`[RealtimeSync] Cluster task change: "${row.title}" (${logEventType}) in cluster "${clusterData.name}"`);

            await api.logChapterEvent(
              client,
              clusterData.chapter_id,
              null,
              logEventType,
              {
                task: row.title || 'Untitled Task',
                cluster: clusterData.name,
                status: row.status || 'pending',
                description: row.description || 'N/A',
                change_type: payload.eventType,
              },
              'cluster_activity'
            );
          } catch (err) {
            console.error('[RealtimeSync] Error processing cluster_tasks change:', err);
          }
        }
      )
      // 13. Listen to terms table (active term transitions and term creation)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'terms' },
        async (payload) => {
          try {
            console.log(`[RealtimeSync] terms table change detected (${payload.eventType}). Invalidating term_members cache...`);
            api.invalidateTermMembersCache(payload.new?.chapter_id || payload.old?.chapter_id);
          } catch (err) {
            console.error('[RealtimeSync] Error processing terms change:', err);
          }
        }
      )
      // 14. Listen to term_members table (per-person delegated permissions added, edited, or revoked)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'term_members' },
        async (payload) => {
          try {
            console.log(`[RealtimeSync] term_members table change detected (${payload.eventType}). Invalidating delegated permissions cache...`);
            api.invalidateTermMembersCache(null, payload.new?.user_id || payload.old?.user_id);
          } catch (err) {
            console.error('[RealtimeSync] Error processing term_members change:', err);
          }
        }
      )
      .subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          const wasReconnecting = reconnectAttempts > 0 || Boolean(lastDisconnectedAt);
          isRealtimeSubscribed = true;
          reconnectAttempts = 0;
          const reconnectedTime = new Date().toISOString();

          if (wasReconnecting) {
            lastReconnectedAt = reconnectedTime;
            const outageDurationMs = lastDisconnectedAt
              ? (new Date(lastReconnectedAt).getTime() - new Date(lastDisconnectedAt).getTime())
              : null;
            const outageStr = outageDurationMs !== null
              ? `${outageDurationMs}ms (${(outageDurationMs / 1000).toFixed(1)}s)`
              : 'unknown duration';

            console.log(
              `[RealtimeSync] ✅ Realtime connection RESTORED. ` +
              `[Disconnect Window] Last known good connection: ${lastKnownGoodConnection || 'N/A'}, ` +
              `Disconnected at: ${lastDisconnectedAt || 'unknown'}, ` +
              `Reconnected at: ${lastReconnectedAt} (Outage window: ${outageStr}).`
            );

            // Self-heal: immediately trigger full reconciliation to catch up on any events missed during disconnect window
            runFullReconciliation(client).catch((recErr) =>
              console.error('[RealtimeSync] Error running reconciliation after reconnect:', recErr.message)
            );
          } else {
            console.log(`[RealtimeSync] ✅ Successfully subscribed to all Supabase Realtime change feeds. Initial connection established at: ${reconnectedTime}`);
          }

          lastKnownGoodConnection = reconnectedTime;
          lastDisconnectedAt = null;
          lastDisconnectReason = null;
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED' || status === 'DISCONNECTED') {
          isRealtimeSubscribed = false;
          lastDisconnectedAt = new Date().toISOString();
          lastDisconnectReason = `${status}${err?.message ? ` - ${err.message}` : ''}`;

          console.warn(
            `[RealtimeSync] ⚠️ Realtime connection DISCONNECTED / ERROR. Status: ${status} (${err?.message || 'transport failure'}). ` +
            `[Disconnect Window] Last known good connection: ${lastKnownGoodConnection || 'N/A'}, Disconnected at: ${lastDisconnectedAt}. ` +
            `Auto-reconnecting via supervisor...`
          );
          scheduleReconnect(client);
        } else if (err) {
          console.warn(
            `[RealtimeSync] Realtime subscription notice: ${status}, error: ${err.message || ''}. ` +
            `Last known good connection: ${lastKnownGoodConnection || 'N/A'}`
          );
        }
      });

    activeRealtimeChannel = channel;
    return channel;
  } catch (err) {
    console.error('[RealtimeSync] Failed to initialize Realtime subscription:', err);
    scheduleReconnect(client);
    return null;
  }
}

/**
 * Schedules a reconnection to Supabase Realtime with exponential backoff.
 */
function scheduleReconnect(client) {
  if (isReconnecting || reconnectTimer) return;
  isReconnecting = true;
  reconnectAttempts++;

  const backoffMs = Math.min(30000, Math.pow(2, Math.min(reconnectAttempts, 5)) * 1000);
  console.log(`[RealtimeSync] Auto-reconnect scheduled in ${backoffMs}ms (attempt ${reconnectAttempts})...`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    isReconnecting = false;
    try {
      setupRealtimeChannel(client);
    } catch (err) {
      console.error('[RealtimeSync] Error during reconnect attempt:', err.message);
      scheduleReconnect(client);
    }
  }, backoffMs);
  if (reconnectTimer.unref) reconnectTimer.unref();
}

/**
 * Polling loop that checks for updates in Supabase as a fallback to Realtime.
 */
function startPollingLoop(client) {
  // Fast fallback reconciliation interval: 30 seconds
  const POLL_INTERVAL_MS = 30 * 1000;
  let lastSanityCheck = Date.now();

  setInterval(async () => {
    try {
      // Channel health check: if channel dropped or closed, reconnect
      if (!isRealtimeSubscribed && !isReconnecting && !reconnectTimer) {
        console.warn('[PollingLoop] Realtime subscription inactive. Triggering auto-reconnect supervisor...');
        scheduleReconnect(client);
      }

      await reconcileRecentChanges(client);

      if (Date.now() - lastSanityCheck > 15 * 60 * 1000) {
        lastSanityCheck = Date.now();
        await checkMainGuildRoleSanity(client).catch(() => {});
      }
    } catch (err) {
      console.error('[PollingLoop] Error during reconciliation:', err.message);
    }
  }, POLL_INTERVAL_MS).unref();
}

/**
 * Reconciles recently updated profiles, user_roles, chapters, or verified codes since last check.
 */
async function reconcileRecentChanges(client) {
  const checkTime = new Date().toISOString();

  try {
    // Run all 5 DB queries in parallel — they are fully independent
    const [
      { data: updatedProfiles },
      { data: verifiedCodes },
      { data: recentRoles },
      { data: recentChapters },
      { data: recentUnlinks },
    ] = await Promise.all([
      supabase
        .from('profiles')
        .select('id, discord_user_id, discord_connected, updated_at')
        .gt('updated_at', lastReconcileTime)
        .not('discord_user_id', 'is', null)
        .limit(50),
      supabase
        .from('discord_verification_codes')
        .select('os_user_id, discord_user_id, verified_at')
        .eq('status', 'verified')
        .gt('verified_at', lastReconcileTime)
        .limit(25),
      supabase
        .from('user_roles')
        .select('user_id, role_key, role, chapter_id, created_at')
        .gt('created_at', lastReconcileTime)
        .limit(25),
      supabase
        .from('chapters')
        .select('id, campus_lead_id, updated_at')
        .gt('updated_at', lastReconcileTime)
        .limit(10),
      supabase
        .from('discord_links')
        .select('os_user_id, discord_user_id, unlinked_at')
        .eq('status', 'unlinked')
        .gt('unlinked_at', lastReconcileTime)
        .limit(25),
    ]);

    // Collect unique user IDs to sync — deduplicating across all change sources
    const usersToSync = new Map(); // discordUserId/osUserId -> { discordUserId, osUserId }

    if (updatedProfiles) {
      for (const p of updatedProfiles) {
        if (p.discord_user_id) usersToSync.set(p.discord_user_id, { discordUserId: p.discord_user_id, osUserId: p.id });
      }
    }
    if (verifiedCodes) {
      for (const c of verifiedCodes) {
        if (c.discord_user_id) usersToSync.set(c.discord_user_id, { discordUserId: c.discord_user_id, osUserId: c.os_user_id });
      }
    }
    if (recentRoles) {
      for (const r of recentRoles) {
        if (r.user_id && !usersToSync.has(r.user_id)) usersToSync.set(r.user_id, { discordUserId: null, osUserId: r.user_id });
      }
    }
    if (recentChapters) {
      for (const ch of recentChapters) {
        if (ch.campus_lead_id && !usersToSync.has(ch.campus_lead_id)) usersToSync.set(ch.campus_lead_id, { discordUserId: null, osUserId: ch.campus_lead_id });
      }
    }
    if (recentUnlinks) {
      for (const u of recentUnlinks) {
        if (u.discord_user_id) usersToSync.set(u.discord_user_id, { discordUserId: u.discord_user_id, osUserId: u.os_user_id });
      }
    }

    // Sync all changed users in parallel (capped at 10 concurrent to avoid Discord rate limits)
    const syncEntries = Array.from(usersToSync.values());
    const BATCH_SIZE = 10;
    for (let i = 0; i < syncEntries.length; i += BATCH_SIZE) {
      const batch = syncEntries.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(({ discordUserId, osUserId }) =>
          api.syncUserAcrossGuilds(client, discordUserId, osUserId, null, 'high').catch(() => {})
        )
      );
    }

    // Update live rosters for chapters that had role or lead changes (deduped)
    const chaptersToUpdate = new Set();
    if (recentRoles) {
      for (const r of recentRoles) { if (r.chapter_id) chaptersToUpdate.add(r.chapter_id); }
    }
    if (recentChapters) {
      for (const ch of recentChapters) { if (ch.id) chaptersToUpdate.add(ch.id); }
    }
    await Promise.all(
      Array.from(chaptersToUpdate).map((chId) => api.updateChapterCurrentRolesTopic(client, chId).catch(() => {}))
    );
  } catch (err) {
    console.error('[PollingLoop] Error in reconcileRecentChanges:', err.message);
  }

  lastReconcileTime = checkTime;
}

/**
 * Updates the 👥 Current Roles live roster for all registered chapters.
 */
async function refreshAllChapterRosters(client) {
  try {
    const { data: chapters } = await supabase.from('chapters').select('id, name');
    if (chapters && chapters.length > 0) {
      console.log(`[RealtimeSync] Refreshing live role rosters for ${chapters.length} chapter(s)...`);
      await Promise.all(
        chapters.map((ch) => api.updateChapterCurrentRolesTopic(client, ch.id).catch(() => {}))
      );
    }
  } catch (err) {
    console.error('[RealtimeSync] Error refreshing chapter rosters:', err.message);
  }
}

/**
 * Resolves all pending discord roles that are now resolvable (user is linked and in-guild).
 *
 * @param {import('discord.js').Client} client
 * @returns {Promise<number>} Number of resolved roles
 */
async function resolveAllPendingRoles(client) {
  if (!client || !supabase) return 0;

  try {
    const { data: pendingRows, error } = await supabase
      .from('pending_discord_roles')
      .select('*');

    if (error) {
      console.error('[PendingRolesReconciliation] Error querying pending_discord_roles:', error.message);
      return 0;
    }

    if (!pendingRows || pendingRows.length === 0) {
      return 0;
    }

    console.log(`[PendingRolesReconciliation] Found ${pendingRows.length} pending role(s) to evaluate.`);

    // Group pending rows by user_id
    const userPendingMap = new Map();
    for (const row of pendingRows) {
      if (!row.user_id) continue;
      if (!userPendingMap.has(row.user_id)) {
        userPendingMap.set(row.user_id, []);
      }
      userPendingMap.get(row.user_id).push(row);
    }

    let resolvedCount = 0;
    for (const [userId, rows] of userPendingMap) {
      try {
        let discordUserId = osUserToDiscordMap.get(userId);

        if (!discordUserId) {
          // Check discord_links
          const { data: link } = await supabase
            .from('discord_links')
            .select('discord_user_id')
            .eq('os_user_id', userId)
            .eq('status', 'linked')
            .order('linked_at', { ascending: false })
            .limit(1)
            .maybeSingle();

          if (link?.discord_user_id) {
            discordUserId = link.discord_user_id;
            osUserToDiscordMap.set(userId, discordUserId);
          }
        }

        if (!discordUserId) {
          // Check profiles
          const { data: prof } = await supabase
            .from('profiles')
            .select('discord_user_id, discord_connected')
            .eq('id', userId)
            .maybeSingle();

          if (prof?.discord_connected && prof.discord_user_id) {
            discordUserId = prof.discord_user_id;
            osUserToDiscordMap.set(userId, discordUserId);
          }
        }

        if (!discordUserId) {
          // User is not yet linked to Discord; retain pending role row
          continue;
        }

        // Delegate to handleUserLinked to process all pending rows for this user
        await handleUserLinked(client, { os_user_id: userId, discord_user_id: discordUserId });
        resolvedCount += rows.length;
      } catch (userErr) {
        console.error(`[PendingRolesReconciliation] Error resolving pending roles for user ${userId}:`, userErr.message);
      }
    }

    return resolvedCount;
  } catch (err) {
    console.error('[PendingRolesReconciliation] Unexpected error:', err.message);
    return 0;
  }
}

/**
 * Standalone full reconciliation function.
 * Called on bot startup, immediately following reconnection, and on a resilient periodic interval.
 * Heals drift in:
 * 1. Clusters where discord_category_id IS NULL (never provisioned)
 * 2. Pending discord roles that are now resolvable (user is linked and in-guild)
 * 3. Connected user roles (missing roles granted, removed roles revoked across main and chapter servers)
 * 4. Unlinked / disconnected user role cleanup (strips OS & verified roles, assigns Unverified)
 * 5. Cluster memberships (member_ids array diffing)
 * 6. Live chapter rosters in 👥 Current Roles
 *
 * Designed for scale: avoids full guild.members.fetch() across all guilds on routine interval runs.
 * Compares against Supabase state first and only touches the Discord API for entries needing correction.
 *
 * @param {import('discord.js').Client} client
 * @returns {Promise<object>} Summary of reconciliation results
 */
async function runFullReconciliation(client) {
  if (!client || !supabase) {
    return { ok: false, reason: 'Client or Supabase unavailable' };
  }

  const startTime = Date.now();
  console.log('[Reconciliation] === Starting full reconciliation pass ===');

  const results = {
    unprovisionedClustersProcessed: 0,
    pendingRolesResolved: 0,
    connectedUsersSynced: 0,
    unlinkedUsersCleaned: 0,
    clustersReconciled: 0,
    durationMs: 0,
  };

  try {
    // 1. Reconcile unprovisioned clusters (clusters where discord_category_id IS NULL)
    try {
      const unprovisioned = await reconcileUnprovisionedClusters(client);
      results.unprovisionedClustersProcessed = Array.isArray(unprovisioned) ? unprovisioned.length : 0;
    } catch (clustErr) {
      console.error('[Reconciliation] Error reconciling unprovisioned clusters:', clustErr.message);
    }

    // 2. Resolve pending discord_roles that are now resolvable
    try {
      results.pendingRolesResolved = await resolveAllPendingRoles(client);
    } catch (pendErr) {
      console.error('[Reconciliation] Error resolving pending roles:', pendErr.message);
    }

    // 3. Compare against Supabase state first for user identities and roles
    const { data: connectedProfiles } = await supabase
      .from('profiles')
      .select('id, discord_user_id, discord_connected_at, updated_at, full_name')
      .eq('discord_connected', true)
      .not('discord_user_id', 'is', null);

    const { data: activeLinks } = await supabase
      .from('discord_links')
      .select('os_user_id, discord_user_id')
      .eq('status', 'linked');

    // Enforce strictly 1:1 account connection:
    // If multiple OS profiles share the same Discord ID, keep only the latest and disconnect duplicates.
    const discordToProfiles = new Map(); // discord_user_id -> profile[]
    if (connectedProfiles) {
      for (const p of connectedProfiles) {
        if (!p.discord_user_id) continue;
        if (!discordToProfiles.has(p.discord_user_id)) {
          discordToProfiles.set(p.discord_user_id, []);
        }
        discordToProfiles.get(p.discord_user_id).push(p);
      }
    }

    const connectedUserMap = new Map(); // discordUserId -> osUserId
    for (const [dUserId, profileList] of discordToProfiles) {
      if (profileList.length === 1) {
        connectedUserMap.set(dUserId, profileList[0].id);
        osUserToDiscordMap.set(profileList[0].id, dUserId);
      } else {
        // Multiple OS profiles for one Discord account: sort latest first, keep primary, disconnect duplicates
        profileList.sort((a, b) => {
          const tA = new Date(a.discord_connected_at || a.updated_at || 0).getTime();
          const tB = new Date(b.discord_connected_at || b.updated_at || 0).getTime();
          return tB - tA;
        });

        const primaryProfile = profileList[0];
        connectedUserMap.set(dUserId, primaryProfile.id);
        osUserToDiscordMap.set(primaryProfile.id, dUserId);

        console.warn(`[Reconciliation] Multiple OS profiles (${profileList.length}) connected to Discord ID ${dUserId}. Keeping primary ${primaryProfile.id} and disconnecting duplicates...`);
        for (let i = 1; i < profileList.length; i++) {
          const dup = profileList[i];
          try {
            await supabase
              .from('profiles')
              .update({
                discord_connected: false,
                discord_user_id: null,
                discord_username: null,
                updated_at: new Date().toISOString(),
              })
              .eq('id', dup.id);

            await supabase
              .from('discord_links')
              .update({
                status: 'unlinked',
                unlinked_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq('os_user_id', dup.id)
              .eq('discord_user_id', dUserId);
          } catch (rDupErr) {
            console.warn(`[Reconciliation] Failed to disconnect duplicate profile ${dup.id}:`, rDupErr.message);
          }
        }
      }
    }

    if (activeLinks) {
      for (const l of activeLinks) {
        if (l.discord_user_id && l.os_user_id) {
          const existingOsId = connectedUserMap.get(l.discord_user_id);
          if (!existingOsId) {
            connectedUserMap.set(l.discord_user_id, l.os_user_id);
            osUserToDiscordMap.set(l.os_user_id, l.discord_user_id);
          } else if (existingOsId !== l.os_user_id) {
            // Discord ID is already linked to another OS profile! Deactivate conflicting link
            console.warn(`[Reconciliation] discord_links conflict for Discord ID ${l.discord_user_id}: ${l.os_user_id} vs ${existingOsId}. Marking stale link unlinked...`);
            supabase
              .from('discord_links')
              .update({ status: 'unlinked', unlinked_at: new Date().toISOString() })
              .eq('os_user_id', l.os_user_id)
              .eq('discord_user_id', l.discord_user_id)
              .catch(() => {});
          }
        }
      }
    }

    const connectedDiscordIds = new Set(connectedUserMap.keys());
    console.log(`[Reconciliation] Reconciling ${connectedUserMap.size} connected user(s)...`);

    // Sync all connected users across guilds in parallel batches of 5
    const connectedEntries = Array.from(connectedUserMap.entries());
    const SYNC_BATCH = 5;
    for (let i = 0; i < connectedEntries.length; i += SYNC_BATCH) {
      const batch = connectedEntries.slice(i, i + SYNC_BATCH);
      await Promise.all(
        batch.map(async ([discordUserId, osUserId]) => {
          try {
            await api.syncUserAcrossGuilds(client, discordUserId, osUserId, null, 'low');
            results.connectedUsersSynced++;
          } catch (uErr) {
            console.warn(`[Reconciliation] Failed to sync connected user ${discordUserId}:`, uErr.message);
          }
        })
      );
    }

    // 4. Reconcile unlinked and disconnected users
    // A. Fetch both in parallel — they are independent queries
    const [{ data: unlinkedLinks }, { data: disconnectedProfiles }] = await Promise.all([
      supabase.from('discord_links').select('os_user_id, discord_user_id').eq('status', 'unlinked'),
      supabase.from('profiles').select('id, discord_user_id').eq('discord_connected', false).not('discord_user_id', 'is', null),
    ]);

    const unlinkedDiscordIds = new Set();
    if (unlinkedLinks) {
      for (const l of unlinkedLinks) {
        if (l.discord_user_id && !connectedDiscordIds.has(l.discord_user_id)) {
          unlinkedDiscordIds.add(l.discord_user_id);
        }
      }
    }
    if (disconnectedProfiles) {
      for (const p of disconnectedProfiles) {
        if (p.discord_user_id && !connectedDiscordIds.has(p.discord_user_id)) {
          unlinkedDiscordIds.add(p.discord_user_id);
        }
      }
    }

    // Clean unlinked users in parallel batches of 5
    const unlinkedArr = Array.from(unlinkedDiscordIds);
    for (let i = 0; i < unlinkedArr.length; i += SYNC_BATCH) {
      const batch = unlinkedArr.slice(i, i + SYNC_BATCH);
      await Promise.all(
        batch.map(async (discordId) => {
          try {
            await api.syncUserAcrossGuilds(client, discordId, null, null, 'low');
            results.unlinkedUsersCleaned++;
          } catch (cleanErr) {
            console.warn(`[Reconciliation] Failed to clean unlinked user ${discordId}:`, cleanErr.message);
          }
        })
      );
    }

    // B. Efficient cache scan: Inspect in-memory guild.members.cache without full API fetch
    for (const [, guild] of client.guilds.cache) {
      for (const [memId, member] of guild.members.cache) {
        if (member.user?.bot) continue;
        if (!connectedDiscordIds.has(memId) && !unlinkedDiscordIds.has(memId)) {
          const hasOsRole = member.roles.cache.some((r) => {
            if (r.managed || r.name === '@everyone' || r.name.toLowerCase() === 'unverified') return false;
            return (
              config.mainRoles?.allowedRoles?.includes(r.name) ||
              r.name === 'ELEVATES • Founder' ||
              r.name === 'Founder' ||
              r.name === 'ELEVATES • Admin' ||
              r.name === 'HQ Admin' ||
              r.name === 'Admin' ||
              r.name === 'Executive Member' ||
              r.name === 'Campus Lead' ||
              r.name === 'Class Rep' ||
              r.name === 'Class Representative' ||
              r.name === 'Student' ||
              r.name === 'Verified Member' ||
              r.name === 'ELEVATES • Member' ||
              r.name.toLowerCase() === (config.roles?.verified || '').toLowerCase()
            );
          });
          if (hasOsRole) {
            console.log(`[Reconciliation] Found unlinked member with leftover OS roles in cache: ${member.user?.tag || memId}. Cleaning up...`);
            await api.syncUserAcrossGuilds(client, memId, null, null, 'low').catch(() => {});
            results.unlinkedUsersCleaned++;
          }
        }
      }
    }

    // 5. Reconcile active cluster memberships
    try {
      const clusterResults = await reconcileAllClusters(client);
      results.clustersReconciled = Array.isArray(clusterResults) ? clusterResults.length : 0;
    } catch (cErr) {
      console.error('[Reconciliation] Error reconciling clusters:', cErr.message);
    }

    // 6. Refresh live chapter rosters in 👥 Current Roles
    try {
      await refreshAllChapterRosters(client);
    } catch (rostErr) {
      console.error('[Reconciliation] Error refreshing chapter rosters:', rostErr.message);
    }

    results.durationMs = Date.now() - startTime;
    console.log(`[Reconciliation] === Full reconciliation completed in ${results.durationMs}ms ===`);
    return results;
  } catch (fatalErr) {
    console.error('[Reconciliation] Fatal error during full reconciliation:', fatalErr);
    results.durationMs = Date.now() - startTime;
    return results;
  }
}

/**
 * Backward compatibility alias for runFullReconciliation.
 */
async function reconcileAllConnectedUsers(client) {
  return runFullReconciliation(client);
}

/**
 * Starts the recurring periodic reconciliation interval.
 * Wrapped in try/catch and overlap guard so a single failure (e.g. transient DB timeout)
 * never kills the recurring schedule.
 *
 * @param {import('discord.js').Client} client
 * @param {number} [intervalMs] Interval in milliseconds (defaults to RECONCILIATION_INTERVAL_MS or 3 minutes)
 * @returns {NodeJS.Timeout}
 */
function startReconciliationInterval(client, intervalMs) {
  if (reconciliationIntervalTimer) {
    clearInterval(reconciliationIntervalTimer);
    reconciliationIntervalTimer = null;
  }

  const configuredInterval = intervalMs ||
    (process.env.RECONCILIATION_INTERVAL_MS ? parseInt(process.env.RECONCILIATION_INTERVAL_MS, 10) : 3 * 60 * 1000);

  console.log(`[ReconciliationSupervisor] Starting periodic reconciliation interval every ${configuredInterval / 1000}s (${configuredInterval / 60000}m)...`);

  reconciliationIntervalTimer = setInterval(async () => {
    if (isReconciliationRunning) {
      console.warn('[ReconciliationSupervisor] Previous reconciliation pass still in progress. Skipping overlapping interval.');
      return;
    }

    isReconciliationRunning = true;
    try {
      console.log('[ReconciliationSupervisor] Triggering scheduled periodic reconciliation pass...');
      await (module.exports.runFullReconciliation || runFullReconciliation)(client);
      console.log('[ReconciliationSupervisor] Scheduled reconciliation pass completed successfully.');
    } catch (err) {
      console.error('[ReconciliationSupervisor] Resilient error handler caught failure during periodic reconciliation run:', err.message || err);
      // Timer continues running! Next run will execute as scheduled.
    } finally {
      isReconciliationRunning = false;
    }
  }, configuredInterval);

  if (reconciliationIntervalTimer && typeof reconciliationIntervalTimer.unref === 'function') {
    reconciliationIntervalTimer.unref();
  }

  return reconciliationIntervalTimer;
}

/**
 * Stops the periodic reconciliation interval.
 */
function stopReconciliationInterval() {
  if (reconciliationIntervalTimer) {
    clearInterval(reconciliationIntervalTimer);
    reconciliationIntervalTimer = null;
    console.log('[ReconciliationSupervisor] Stopped periodic reconciliation interval.');
  }
}

/**
 * Simulates a Realtime disconnect for testing mid-session resilience and gap recovery.
 *
 * @param {import('discord.js').Client} client
 * @param {string} [reason]
 */
function simulateDisconnect(client, reason = 'Simulated transport failure (CHANNEL_ERROR)') {
  isRealtimeSubscribed = false;
  lastDisconnectedAt = new Date().toISOString();
  lastDisconnectReason = reason;

  console.warn(
    `[RealtimeSync] [SIMULATION] Realtime connection disconnect simulated. Reason: ${reason}. ` +
    `[Disconnect Window] Last known good connection: ${lastKnownGoodConnection || 'N/A'}, Disconnected at: ${lastDisconnectedAt}.`
  );

  if (activeRealtimeChannel) {
    try {
      supabase.removeChannel(activeRealtimeChannel).catch(() => {});
    } catch (_) {}
    activeRealtimeChannel = null;
  }

  if (client) {
    scheduleReconnect(client);
  }
}

/**
 * Simulates Realtime reconnection for testing gap recovery.
 *
 * @param {import('discord.js').Client} client
 * @returns {Promise<object>}
 */
async function simulateReconnect(client) {
  isRealtimeSubscribed = true;
  lastReconnectedAt = new Date().toISOString();
  const outageDurationMs = lastDisconnectedAt
    ? (new Date(lastReconnectedAt).getTime() - new Date(lastDisconnectedAt).getTime())
    : 0;

  console.log(
    `[RealtimeSync] [SIMULATION] Realtime connection RESTORED. ` +
    `[Disconnect Window] Last known good connection: ${lastKnownGoodConnection || 'N/A'}, ` +
    `Disconnected at: ${lastDisconnectedAt || 'unknown'}, ` +
    `Reconnected at: ${lastReconnectedAt} (Outage window: ${outageDurationMs}ms).`
  );

  const res = await runFullReconciliation(client);
  lastKnownGoodConnection = lastReconnectedAt;
  lastDisconnectedAt = null;
  lastDisconnectReason = null;
  return res;
}

/**
 * Returns current Realtime connection health metrics and timestamps.
 *
 * @returns {object}
 */
function getConnectionHealth() {
  return {
    isSubscribed: isRealtimeSubscribed,
    isReconnecting,
    reconnectAttempts,
    lastKnownGoodConnection,
    lastDisconnectedAt,
    lastReconnectedAt,
    lastDisconnectReason,
  };
}

module.exports = {
  initRealtimeSync,
  runFullReconciliation,
  reconcileAllConnectedUsers,
  resolveAllPendingRoles,
  startReconciliationInterval,
  stopReconciliationInterval,
  simulateDisconnect,
  simulateReconnect,
  getConnectionHealth,
  reconcileRecentChanges,
  refreshAllChapterRosters,
  reconcileUnprovisionedClusters,
  reconcileClustersOnBoot: reconcileUnprovisionedClusters,
};

