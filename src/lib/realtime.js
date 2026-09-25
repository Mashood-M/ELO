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
} = require('./clusterSync');
const { ensureLinkChannel } = require('./accountLinking');
const { checkMainGuildRoleSanity } = require('./roleSanityCheck');

let lastReconcileTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
let pollCycleCounter = 0;
const userRoleToUserMap = new Map(); // id -> user_id for tracking DELETE events

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

  // Initial sync of all clusters
  syncAllClusters(client).catch((err) =>
    console.error('[RealtimeSync] Initial cluster sync error:', err.message)
  );

  // Initial sync of all connected users to reconcile any role changes that occurred while offline
  reconcileAllConnectedUsers(client).catch((err) =>
    console.error('[RealtimeSync] Initial user sync error:', err.message)
  );

  try {
    const channel = supabase
      .channel('elevates_bot_realtime')
      // 1. Listen to profiles table (identity, chapter changes, name changes, connection state)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'profiles' },
        async (payload) => {
          try {
            const newRow = payload.new;
            const oldRow = payload.old;
            const userId = newRow?.id || oldRow?.id;
            const discordUserId = newRow?.discord_user_id || oldRow?.discord_user_id;
            let chapterId = newRow?.chapter_id || oldRow?.chapter_id;

            if (discordUserId || userId) {
              console.log(`[RealtimeSync] Profile change detected for user ${userId || discordUserId} (${payload.eventType})`);
              await api.syncUserAcrossGuilds(client, discordUserId, userId);

              if (newRow?.discord_connected && (!oldRow || !oldRow.discord_connected)) {
                handleUserLinked(client, newRow).catch((err) =>
                  console.error('[RealtimeSync] Error resolving pending roles on profile connect:', err)
                );
              }

              // Check if designation or role changed
              const oldDes = oldRow?.designation;
              const newDes = newRow?.designation;
              const oldRole = oldRow?.role;
              const newRole = newRow?.role;

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

            if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
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
            }

            if (userId) {
              console.log(`[RealtimeSync] user_roles change detected for user ${userId} (${payload.eventType}): role=${roleKey || 'unspecified'}`);
              await api.syncUserAcrossGuilds(client, null, userId);

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

                await api.logChapterEvent(
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
                );

                // Dynamically update the chapter's live roster in 👥 Current Roles
                await api.updateChapterCurrentRolesTopic(client, chapterId);
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

            if (payload.eventType === 'INSERT') {
              await handleClusterCreated(client, payload.new);
            } else if (payload.eventType === 'UPDATE' && payload.new?.status === 'archived' && payload.old?.status !== 'archived') {
              await handleClusterArchived(client, payload.new);
            } else if (payload.eventType === 'UPDATE') {
              await syncCluster(client, clusterId);
            }

            const chapterId = payload.new?.chapter_id || payload.old?.chapter_id;
            if (chapterId) {
              const clusterName = payload.new?.name || payload.old?.name || 'Cluster';
              const logType = payload.eventType === 'INSERT' ? 'cluster_created' : payload.eventType === 'DELETE' ? 'cluster_deleted' : 'cluster_updated';
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

            if (payload.eventType === 'INSERT') {
              await handleMemberAdded(client, payload.new);
            } else if (payload.eventType === 'DELETE') {
              await handleMemberRemoved(client, payload.old);
            } else {
              await syncCluster(client, clusterId);
            }

            const { data: clData } = await supabase.from('clusters').select('name, chapter_id').eq('id', clusterId).maybeSingle();
            if (clData?.chapter_id) {
              const userId = payload.new?.user_id || payload.old?.user_id;
              let memberStr = 'Member';
              if (userId) {
                const { data: p } = await supabase.from('profiles').select('full_name, discord_user_id').eq('id', userId).maybeSingle();
                if (p) {
                  memberStr = p.discord_user_id ? `<@${p.discord_user_id}> (${p.full_name})` : (p.full_name || 'Member');
                }
              }

              const logType = payload.eventType === 'INSERT' ? 'cluster_member_added' : payload.eventType === 'DELETE' ? 'cluster_member_removed' : 'cluster_member_updated';
              await api.logChapterEvent(
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
              );
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
              await handleUserLinked(client, { os_user_id: row.os_user_id, discord_user_id: row.discord_user_id });
              await api.syncUserAcrossGuilds(client, row.discord_user_id, row.os_user_id);
            }
          } catch (err) {
            console.error('[RealtimeSync] Error processing discord_verification_codes change:', err);
          }
        }
      )
      // 7. Listen to discord_links table (link events and pending role resolution)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'discord_links' },
        async (payload) => {
          try {
            const row = payload.new;
            if (row && row.discord_user_id) {
              if (payload.eventType === 'INSERT' || row.status === 'linked') {
                await handleUserLinked(client, row);
              }
              await api.syncUserAcrossGuilds(client, row.discord_user_id, row.os_user_id);
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
              await api.syncUserAcrossGuilds(client, null, oldLead);
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
      .subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          console.log('[RealtimeSync] Successfully subscribed to all Supabase Realtime change feeds.');
        } else if (status === 'CHANNEL_ERROR') {
          console.warn('[RealtimeSync] Realtime subscription notice: CHANNEL_ERROR (transport/network glitch). Auto-reconnecting, with periodic polling active as fallback:', err?.message || 'Transport failure');
        } else if (err) {
          console.warn('[RealtimeSync] Realtime subscription notice:', status, err?.message || '');
        }
      });

    // Start periodic polling reconciliation loop (every 60 seconds)
    startPollingLoop(client);

    return channel;
  } catch (err) {
    console.error('[RealtimeSync] Failed to initialize Realtime subscription:', err);
    startPollingLoop(client);
  }
}

/**
 * Polling loop that checks for updates in Supabase as a fallback to Realtime.
 */
function startPollingLoop(client) {
  // Fallback reconciliation interval: runs hourly to avoid redundant polling (Section 5.4)
  const POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  setInterval(async () => {
    try {
      console.log('[PollingLoop] Running hourly fallback reconciliation cycle...');
      await reconcileRecentChanges(client);
      await checkMainGuildRoleSanity(client);
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
    // 1. Fetch profiles updated since last check
    const { data: updatedProfiles } = await supabase
      .from('profiles')
      .select('id, discord_user_id, discord_connected, updated_at')
      .gt('updated_at', lastReconcileTime)
      .not('discord_user_id', 'is', null)
      .limit(50);

    if (updatedProfiles && updatedProfiles.length > 0) {
      for (const p of updatedProfiles) {
        if (p.discord_user_id) {
          await api.syncUserAcrossGuilds(client, p.discord_user_id, p.id);
        }
      }
    }

    // 2. Fetch recent verified codes
    const { data: verifiedCodes } = await supabase
      .from('discord_verification_codes')
      .select('os_user_id, discord_user_id, verified_at')
      .eq('status', 'verified')
      .gt('verified_at', lastReconcileTime)
      .limit(25);

    if (verifiedCodes && verifiedCodes.length > 0) {
      for (const c of verifiedCodes) {
        if (c.discord_user_id) {
          await api.syncUserAcrossGuilds(client, c.discord_user_id, c.os_user_id);
        }
      }
    }

    // 3. Fetch recently added or changed user_roles
    const { data: recentRoles } = await supabase
      .from('user_roles')
      .select('user_id, role_key, role, chapter_id, created_at')
      .gt('created_at', lastReconcileTime)
      .limit(25);

    if (recentRoles && recentRoles.length > 0) {
      for (const r of recentRoles) {
        if (r.user_id) {
          await api.syncUserAcrossGuilds(client, null, r.user_id);
        }
      }
    }

    // 4. Fetch recently updated chapters (campus_lead assignments)
    const { data: recentChapters } = await supabase
      .from('chapters')
      .select('campus_lead_id, updated_at')
      .gt('updated_at', lastReconcileTime)
      .limit(10);

    if (recentChapters && recentChapters.length > 0) {
      for (const ch of recentChapters) {
        if (ch.campus_lead_id) {
          await api.syncUserAcrossGuilds(client, null, ch.campus_lead_id);
        }
      }
    }
    // 5. Update live rosters for chapters that had role or lead changes
    const chaptersToUpdate = new Set();
    if (recentRoles && recentRoles.length > 0) {
      for (const r of recentRoles) {
        if (r.chapter_id) chaptersToUpdate.add(r.chapter_id);
      }
    }
    if (recentChapters && recentChapters.length > 0) {
      for (const ch of recentChapters) {
        if (ch.id) chaptersToUpdate.add(ch.id);
      }
    }
    for (const chId of chaptersToUpdate) {
      await api.updateChapterCurrentRolesTopic(client, chId).catch(() => {});
    }
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
 * Synchronizes all currently linked Discord users across all guilds on startup.
 */
async function reconcileAllConnectedUsers(client) {
  try {
    const { data: connectedProfiles } = await supabase
      .from('profiles')
      .select('id, discord_user_id')
      .not('discord_user_id', 'is', null);

    const connectedDiscordIds = new Set();
    if (connectedProfiles && connectedProfiles.length > 0) {
      console.log(`[RealtimeSync] Syncing ${connectedProfiles.length} connected user(s)...`);
      for (const p of connectedProfiles) {
        if (p.discord_user_id) {
          connectedDiscordIds.add(p.discord_user_id);
          await api.syncUserAcrossGuilds(client, p.discord_user_id, p.id);
        }
      }
    }

    // Refresh live rosters in 👥 Current Roles for all chapters
    await refreshAllChapterRosters(client);

    // Check guilds in parallel to ensure no unlinked/unconnected members hold leftover OS roles (Section 5.5)
    await Promise.all(
      Array.from(client.guilds.cache.values()).map(async (guild) => {
        const members = await guild.members.fetch().catch(() => null);
        if (!members) return;
        for (const [memId, member] of members) {
          if (member.user.bot) continue;
          if (!connectedDiscordIds.has(memId)) {
            // Check if member holds any OS roles
            const hasOsRole = member.roles.cache.some((r) => {
              if (r.managed || r.name === '@everyone' || r.name.toLowerCase() === 'unverified') return false;
              return (
                config.mainRoles.allowedRoles.includes(r.name) ||
                r.name === 'ELEVATES • Founder' ||
                r.name === 'ELEVATES • Admin'
              );
            });
            if (hasOsRole) {
              console.log(`[RealtimeSync] Cleaning up leftover OS roles for unlinked member ${member.user.tag}...`);
              await api.syncUserAcrossGuilds(client, memId, null).catch(() => {});
            }
          }
        }
      })
    );
  } catch (err) {
    console.error('[RealtimeSync] Error in reconcileAllConnectedUsers:', err.message);
  }
}

module.exports = { initRealtimeSync, reconcileAllConnectedUsers, reconcileRecentChanges, refreshAllChapterRosters };

