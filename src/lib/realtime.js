const supabase = require('./supabase');
const api = require('./api');
const { syncCluster, syncAllClusters } = require('./clusterSync');
const { ensureLinkChannel } = require('./accountLinking');

let lastReconcileTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();

/**
 * Initializes Supabase Realtime listeners and a resilient polling reconciliation loop
 * for role sync, chapter changes, and cluster management.
 *
 * @param {import('discord.js').Client} client
 */
function initRealtimeSync(client) {
  if (!supabase) return;

  console.log('[RealtimeSync] Initializing Supabase Realtime listeners and reconciliation engine...');

  // Ensure #link-server exists in all currently connected guilds on ready
  for (const [, guild] of client.guilds.cache) {
    ensureLinkChannel(guild).catch(() => {});
  }

  // Initial sync of all clusters
  syncAllClusters(client).catch((err) =>
    console.error('[RealtimeSync] Initial cluster sync error:', err.message)
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

            if (discordUserId || userId) {
              console.log(`[RealtimeSync] Profile change detected for user ${userId || discordUserId} (${payload.eventType})`);
              await api.syncUserAcrossGuilds(client, discordUserId, userId);
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
            const row = payload.new || payload.old;
            if (!row || !row.user_id) return;

            console.log(`[RealtimeSync] user_roles change detected for user ${row.user_id}: ${row.role_key || row.role} (${payload.eventType})`);
            await api.syncUserAcrossGuilds(client, null, row.user_id);
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
            // When role names change, sync all active linked members
            reconcileRecentChanges(client).catch(() => {});
          } catch (err) {
            console.error('[RealtimeSync] Error processing roles change:', err);
          }
        }
      )
      // 4. Listen to clusters table (cluster added, renamed, leader changed)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'clusters' },
        async (payload) => {
          try {
            const clusterId = payload.new?.id || payload.old?.id;
            if (!clusterId) return;

            console.log(`[RealtimeSync] Clusters change detected for cluster ${clusterId} (${payload.eventType})`);
            await syncCluster(client, clusterId);
          } catch (err) {
            console.error('[RealtimeSync] Error processing clusters change:', err);
          }
        }
      )
      // 5. Listen to cluster_members table (member added/kicked)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'cluster_members' },
        async (payload) => {
          try {
            const clusterId = payload.new?.cluster_id || payload.old?.cluster_id;
            if (!clusterId) return;

            console.log(`[RealtimeSync] cluster_members change detected for cluster ${clusterId} (${payload.eventType})`);
            await syncCluster(client, clusterId);
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
              await api.syncUserAcrossGuilds(client, row.discord_user_id, row.os_user_id);
            }
          } catch (err) {
            console.error('[RealtimeSync] Error processing discord_verification_codes change:', err);
          }
        }
      )
      // 7. Listen to discord_links table (backward-compatible link events)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'discord_links' },
        async (payload) => {
          try {
            const row = payload.new;
            if (row && row.discord_user_id) {
              await api.syncUserAcrossGuilds(client, row.discord_user_id, row.os_user_id);
            }
          } catch (err) {
            console.error('[RealtimeSync] Error processing discord_links change:', err);
          }
        }
      )
      .subscribe((status, err) => {
        if (status === 'SUBSCRIBED') {
          console.log('[RealtimeSync] Successfully subscribed to all Supabase Realtime change feeds.');
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
  const POLL_INTERVAL_MS = 60 * 1000; // 1 minute

  setInterval(async () => {
    try {
      await reconcileRecentChanges(client);
    } catch (err) {
      console.error('[PollingLoop] Error during reconciliation:', err.message);
    }
  }, POLL_INTERVAL_MS);
}

/**
 * Reconciles recently updated profiles or verified codes since last check.
 */
async function reconcileRecentChanges(client) {
  const checkTime = new Date().toISOString();

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

  lastReconcileTime = checkTime;
}

module.exports = { initRealtimeSync };
