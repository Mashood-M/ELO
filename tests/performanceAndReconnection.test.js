const assert = require('assert');
const { Collection, ChannelType, PermissionFlagsBits } = require('discord.js');
const syncQueue = require('../src/lib/syncQueue');
const api = require('../src/lib/api');
const config = require('../src/config');
const realtime = require('../src/lib/realtime');

async function itAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    process.exit(1);
  }
}

async function runTests() {
  console.log('\n--- RUNNING PERFORMANCE & RECONNECTION RESILIENCE TEST SUITE ---\n');

  // Test 1: SyncQueue priority handling
  await itAsync('SyncQueue: executes high-priority jobs ahead of low-priority jobs', async () => {
    syncQueue.minDelayMs = 5;
    const executionOrder = [];

    // Pause queue by pretending to be rate limited for 50ms
    syncQueue.rateLimitedUntil = Date.now() + 60;

    // Enqueue a low priority task
    syncQueue.enqueue('test', 'low_1', async () => {
      executionOrder.push('low_1');
    }, 1, null, null, 'low');

    // Enqueue another low priority task
    syncQueue.enqueue('test', 'low_2', async () => {
      executionOrder.push('low_2');
    }, 1, null, null, 'low');

    // Enqueue a high priority task
    syncQueue.enqueue('test', 'high_1', async () => {
      executionOrder.push('high_1');
    }, 1, null, null, 'high');

    // Wait for queue to drain
    while (syncQueue.processing || syncQueue.queue.length > 0 || syncQueue.inFlightSet.size > 0) {
      await new Promise((r) => setTimeout(r, 10));
    }

    assert.strictEqual(executionOrder[0], 'high_1', 'High priority task must execute first');
    assert.deepStrictEqual(executionOrder, ['high_1', 'low_1', 'low_2']);
  });

  // Test 2: SyncQueue concurrency pool
  await itAsync('SyncQueue: allows up to maxConcurrency parallel workers', async () => {
    syncQueue.minDelayMs = 0;
    assert.strictEqual(syncQueue.maxConcurrency, 5); // Updated to 5 for improved throughput
    assert.strictEqual(syncQueue.processing, false);

    let activeRunning = 0;
    let maxSeenParallel = 0;

    const task = async () => {
      activeRunning++;
      maxSeenParallel = Math.max(maxSeenParallel, activeRunning);
      await new Promise((r) => setTimeout(r, 30));
      activeRunning--;
    };

    const p1 = syncQueue.enqueueAsync('test', 'c1', task);
    const p2 = syncQueue.enqueueAsync('test', 'c2', task);
    const p3 = syncQueue.enqueueAsync('test', 'c3', task);

    await Promise.all([p1, p2, p3]);

    assert.ok(maxSeenParallel >= 2, `Expected parallel execution >= 2, saw ${maxSeenParallel}`);
  });

  // Test 3: getAllOsRoles caching
  await itAsync('api: getAllOsRoles caches results in memory to avoid repeated DB round trips', async () => {
    const supabase = require('../src/lib/supabase');
    api.invalidateOsRolesCache();

    const mockRoles = [{ id: '1', key: 'campus_lead', name: 'Campus Lead' }];
    const origFrom = supabase.from;
    supabase.from = (table) => {
      if (table === 'roles') {
        return {
          select: () => Promise.resolve({ data: mockRoles, error: null }),
        };
      }
      return origFrom ? origFrom.call(supabase, table) : {};
    };

    try {
      const roles1 = await api.getAllOsRoles();
      const roles2 = await api.getAllOsRoles();
      assert.strictEqual(roles1, roles2, 'Second call should return cached array reference directly');
      assert.deepStrictEqual(roles1, mockRoles);

      api.invalidateOsRolesCache();
      const roles3 = await api.getAllOsRoles();
      assert.deepStrictEqual(roles3, mockRoles);
    } finally {
      supabase.from = origFrom;
    }
  });

  // Test 4: Roster debouncing in updateChapterCurrentRolesTopic
  await itAsync('api: updateChapterCurrentRolesTopic debounces background calls per chapter', async () => {
    let callCount = 0;
    const mockClient = {};
    const origGetChapter = api.getChapterByIdentifier;
    api.getChapterByIdentifier = async () => {
      callCount++;
      return null;
    };

    try {
      // Trigger 3 calls in rapid succession for same chapter
      api.updateChapterCurrentRolesTopic(mockClient, 'test-ch-debounce');
      api.updateChapterCurrentRolesTopic(mockClient, 'test-ch-debounce');
      const lastPromise = api.updateChapterCurrentRolesTopic(mockClient, 'test-ch-debounce');

      // Immediately callCount should still be 0 (debounced)
      assert.strictEqual(callCount, 0, 'Should not execute immediately when debounced');

      await lastPromise;
      // After debounce delay expires, should have executed only once
      assert.strictEqual(callCount, 1, 'Should have coalesced multiple rapid calls into a single execution');
    } finally {
      api.getChapterByIdentifier = origGetChapter;
    }
  });

  // --- MOCK ENVIRONMENT HELPERS FOR RECONNECTION & RECONCILIATION TESTS ---
  const mockDb = {
    profiles: [],
    discord_links: [],
    guild_config: [],
    user_roles: [],
    roles: [],
    chapters: [],
    clusters: [],
    cluster_members: [],
    pending_discord_roles: [],
    discord_sync_log: [],
    discord_events_log: [],
  };

  function resetMockDb() {
    for (const key of Object.keys(mockDb)) {
      mockDb[key] = [];
    }
  }

  async function waitForSyncQueue() {
    while (syncQueue.processing || syncQueue.queue.length > 0 || syncQueue.inFlightSet.size > 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  function setupMockSupabase(supabase) {
    supabase.from = function (table) {
      const currentTable = mockDb[table] || [];
      let filters = [];
      let selectFields = '*';

      const chain = {
        select: (fields) => {
          selectFields = fields || '*';
          return chain;
        },
        insert: (data) => {
          const items = Array.isArray(data) ? data : [data];
          for (const item of items) {
            const row = { id: item.id || `mock_${Math.random().toString(36).slice(2, 9)}`, ...item };
            currentTable.push(row);
          }
          return Promise.resolve({ data: items, error: null });
        },
        update: (updates) => {
          return {
            eq: (col, val) => {
              let updatedCount = 0;
              for (const row of currentTable) {
                if (row[col] === val) {
                  Object.assign(row, updates);
                  updatedCount++;
                }
              }
              return Promise.resolve({ data: updatedCount, error: null });
            },
          };
        },
        delete: () => {
          let deleteFilters = {};
          const delChain = {
            eq: (col, val) => {
              deleteFilters[col] = val;
              return delChain;
            },
            then: (resolve, reject) => {
              const prevLen = currentTable.length;
              const filtered = currentTable.filter((row) => {
                for (const [col, val] of Object.entries(deleteFilters)) {
                  if (row[col] !== val) return true;
                }
                return false;
              });
              mockDb[table] = filtered;
              return Promise.resolve({ data: prevLen - filtered.length, error: null }).then(resolve, reject);
            },
          };
          return delChain;
        },
        upsert: (data, opts = {}) => {
          const items = Array.isArray(data) ? data : [data];
          const conflictCols = opts.onConflict ? opts.onConflict.split(',').map((s) => s.trim()) : ['id'];
          for (const item of items) {
            const matchIdx = currentTable.findIndex((row) =>
              conflictCols.every((col) => row[col] === item[col])
            );
            if (matchIdx !== -1) {
              Object.assign(currentTable[matchIdx], item);
            } else {
              currentTable.push({ id: item.id || `mock_${Math.random().toString(36).slice(2, 9)}`, ...item });
            }
          }
          return Promise.resolve({ data: items, error: null });
        },
        eq: (col, val) => {
          filters.push((row) => row[col] === val);
          return chain;
        },
        neq: (col, val) => {
          filters.push((row) => row[col] !== val);
          return chain;
        },
        is: (col, val) => {
          filters.push((row) => (val === null ? row[col] === null || row[col] === undefined : row[col] === val));
          return chain;
        },
        ilike: (col, val) => {
          const cleanVal = String(val || '').replace(/%/g, '').toLowerCase();
          filters.push((row) => String(row[col] || '').toLowerCase().includes(cleanVal));
          return chain;
        },
        not: (col, op, val) => {
          if (op === 'is' && val === null) {
            filters.push((row) => row[col] !== null && row[col] !== undefined);
          }
          return chain;
        },
        in: (col, arr) => {
          filters.push((row) => arr.includes(row[col]));
          return chain;
        },
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => {
          const filtered = currentTable.filter((row) => filters.every((fn) => fn(row)));
          return { data: filtered[0] || null, error: null };
        },
        single: async () => {
          const filtered = currentTable.filter((row) => filters.every((fn) => fn(row)));
          return { data: filtered[0] || null, error: filtered.length ? null : new Error('Row not found') };
        },
        then: (resolve, reject) => {
          const filtered = currentTable.filter((row) => filters.every((fn) => fn(row)));
          return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
        },
      };
      return chain;
    };
  }

  function createMockEnvironment() {
    const recordedFullFetches = [];

    const createGuild = (id, name, initialRoles = []) => {
      const rolesCache = new Collection();
      const channelsCache = new Collection();
      const membersCache = new Collection();

      const everyoneRole = {
        id: `role_everyone_${id}`,
        name: '@everyone',
        permissions: { has: () => false },
      };
      rolesCache.set(everyoneRole.id, everyoneRole);

      for (const rName of initialRoles) {
        const rId = `role_${rName.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${id}`;
        rolesCache.set(rId, {
          id: rId,
          name: rName,
          members: new Collection(),
          editable: true,
          managed: false,
        });
      }

      const me = {
        id: 'bot_user_id',
        user: { id: 'bot_user_id', tag: 'ElevatesBot#0001' },
        permissions: { has: () => true },
      };

      const guild = {
        id,
        name,
        ownerId: 'owner_user_id',
        members: {
          me,
          cache: membersCache,
          fetchMe: async () => me,
          fetch: async (arg) => {
            if (!arg) {
              recordedFullFetches.push(id);
              return membersCache;
            }
            return membersCache.get(arg) || null;
          },
        },
        roles: {
          everyone: everyoneRole,
          cache: rolesCache,
          fetch: async (arg) => (arg ? rolesCache.get(arg) || null : rolesCache),
          create: async (opts) => {
            const rId = `role_${opts.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
            const newRole = {
              id: rId,
              name: opts.name,
              color: opts.color,
              editable: true,
              managed: false,
              members: new Collection(),
            };
            rolesCache.set(rId, newRole);
            return newRole;
          },
        },
        channels: {
          cache: channelsCache,
          fetch: async (arg) => (arg ? channelsCache.get(arg) || null : channelsCache),
          create: async (opts) => {
            const cId = `chan_${opts.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
            const newChan = {
              id: cId,
              name: opts.name,
              type: opts.type,
              parentId: opts.parent || null,
              parent: opts.parent ? channelsCache.get(opts.parent) : null,
              permissionOverwrites: {
                cache: new Collection(),
                set: async (overwrites) => {
                  newChan.appliedOverwrites = overwrites;
                },
              },
              appliedOverwrites: opts.permissionOverwrites || [],
              messages: {
                fetch: async () => new Collection(),
              },
              send: async (msg) => msg,
              setName: async (n) => {
                newChan.name = n;
              },
              lockPermissions: async () => {
                newChan.permissionsLocked = true;
              },
              delete: async () => {
                channelsCache.delete(cId);
                return newChan;
              },
            };
            channelsCache.set(cId, newChan);
            return newChan;
          },
        },
      };

      return guild;
    };

    const mainGuild = createGuild('main_guild_1', 'ELEVATES Main Server', [
      'Verified Member',
      'Unverified',
      'Campus Lead',
      'Executive Member',
      'Founder',
      'HQ Admin',
      'Admin',
    ]);

    const chapterGuild = createGuild('chapter_guild_1', 'ELEVATES Beta Chapter', [
      'Verified Member',
      'ELEVATES • Member',
      'Unverified',
      'Campus Lead',
      'Executive Member',
    ]);

    const client = {
      user: { id: 'bot_user_id', tag: 'ElevatesBot#0001' },
      guilds: {
        cache: new Collection([
          ['main_guild_1', mainGuild],
          ['chapter_guild_1', chapterGuild],
        ]),
        fetch: async (id) => client.guilds.cache.get(id) || null,
      },
    };

    return { client, mainGuild, chapterGuild, recordedFullFetches };
  }

  function addMockMember(guild, id, tag, initialRoleIds = []) {
    const roleCache = new Collection();
    for (const rId of initialRoleIds) {
      const r = guild.roles.cache.get(rId);
      if (r) {
        roleCache.set(r.id, r);
        if (r.members) r.members.set(id, { id });
      }
    }

    const member = {
      id,
      user: { id, tag, bot: false },
      displayName: tag.split('#')[0],
      manageable: true,
      roles: {
        cache: roleCache,
        add: async (roleOrId) => {
          const rId = typeof roleOrId === 'string' ? roleOrId : roleOrId.id;
          const role = guild.roles.cache.get(rId) || { id: rId, name: 'mock_role', editable: true };
          roleCache.set(rId, role);
          if (role.members) role.members.set(id, member);
        },
        remove: async (roleOrId) => {
          const rId = typeof roleOrId === 'string' ? roleOrId : roleOrId.id;
          roleCache.delete(rId);
          const role = guild.roles.cache.get(rId);
          if (role?.members) role.members.delete(id);
        },
      },
      setNickname: async (n) => {
        member.displayName = n;
      },
    };
    guild.members.cache.set(id, member);
    return member;
  }

  // Test 5: Realtime connection health tracking and disconnect/reconnect window logging
  await itAsync('realtime: connection health tracking and disconnect/reconnect window logging', async () => {
    resetMockDb();
    const supabase = require('../src/lib/supabase');
    const origFrom = supabase.from;
    setupMockSupabase(supabase);

    try {
      // 1. Initial health before disconnect
      const healthInitial = realtime.getConnectionHealth();
      assert.strictEqual(typeof healthInitial, 'object');

      // 2. Simulate disconnect
      const disconnectReason = 'CHANNEL_ERROR - transport failure (simulated)';
      realtime.simulateDisconnect(null, disconnectReason);

      const healthDisconnected = realtime.getConnectionHealth();
      assert.strictEqual(healthDisconnected.isSubscribed, false, 'Channel should be marked unsubscribed');
      assert.ok(healthDisconnected.lastDisconnectedAt, 'lastDisconnectedAt must be recorded');
      assert.strictEqual(healthDisconnected.lastDisconnectReason, disconnectReason);

      // 3. Simulate reconnect
      const mockEnv = createMockEnvironment();
      await realtime.simulateReconnect(mockEnv.client);

      const healthReconnected = realtime.getConnectionHealth();
      assert.strictEqual(healthReconnected.isSubscribed, true, 'Channel should be marked subscribed');
      assert.ok(healthReconnected.lastReconnectedAt, 'lastReconnectedAt must be recorded');
      assert.strictEqual(healthReconnected.lastKnownGoodConnection, healthReconnected.lastReconnectedAt);
      assert.strictEqual(healthReconnected.lastDisconnectedAt, null, 'lastDisconnectedAt should be cleared after reconnect');
    } finally {
      supabase.from = origFrom;
    }
  });

  // Test 6: Mid-session disconnect gap simulation & auto-healing on reconciliation interval
  await itAsync('Reconciliation: Auto-heals role drift, unprovisioned clusters, and pending roles occurring during disconnect gap without bot restart', async () => {
    resetMockDb();
    const env = createMockEnvironment();
    const supabase = require('../src/lib/supabase');
    const origFrom = supabase.from;
    setupMockSupabase(supabase);

    try {
      // 1. Guild configurations
      mockDb.guild_config.push(
        { guild_id: 'main_guild_1', guild_type: 'main' },
        { guild_id: 'chapter_guild_1', guild_type: 'chapter', chapter_id: 'chapter_alpha' }
      );
      mockDb.chapters.push({ id: 'chapter_alpha', name: 'Alpha Chapter' });

      // 2. Roles in Main Guild
      const verifiedRole = env.mainGuild.roles.cache.find((r) => r.name === 'Verified Member');
      const unverifiedRole = env.mainGuild.roles.cache.find((r) => r.name === 'Unverified');
      const campusLeadRole = env.mainGuild.roles.cache.find((r) => r.name === 'Campus Lead');

      // 3. Seed users before disconnect:
      // User 1: Connected profile, was campus lead
      const userLeadId = 'user_lead_gap';
      const discordLeadId = 'discord_lead_gap';
      mockDb.profiles.push({
        id: userLeadId,
        full_name: 'Lead User',
        discord_user_id: discordLeadId,
        discord_connected: true,
      });
      mockDb.discord_links.push({
        os_user_id: userLeadId,
        discord_user_id: discordLeadId,
        status: 'linked',
      });
      // In Discord, user currently holds both Campus Lead and Verified Member
      const memberLead = addMockMember(env.mainGuild, discordLeadId, 'LeadUser#0001', [
        verifiedRole.id,
        campusLeadRole.id,
      ]);

      // User 2: Connected profile holding Verified Member, will be unlinked during gap
      const userUnlinkedId = 'user_unlinked_gap';
      const discordUnlinkedId = 'discord_unlinked_gap';
      mockDb.profiles.push({
        id: userUnlinkedId,
        full_name: 'Unlinked Target',
        discord_user_id: discordUnlinkedId,
        discord_connected: true,
      });
      mockDb.discord_links.push({
        os_user_id: userUnlinkedId,
        discord_user_id: discordUnlinkedId,
        status: 'linked',
      });
      const memberUnlinked = addMockMember(env.mainGuild, discordUnlinkedId, 'UnlinkTarget#0001', [
        verifiedRole.id,
      ]);

      // User 3: Linked user in chapter guild, will have pending role for a cluster created offline
      const userPendingId = 'user_pending_gap';
      const discordPendingId = 'discord_pending_gap';
      mockDb.profiles.push({
        id: userPendingId,
        full_name: 'Pending Role Member',
        discord_user_id: discordPendingId,
        discord_connected: true,
      });
      mockDb.discord_links.push({
        os_user_id: userPendingId,
        discord_user_id: discordPendingId,
        status: 'linked',
      });
      const memberPending = addMockMember(env.chapterGuild, discordPendingId, 'PendingUser#0001', []);

      // 4. SIMULATE WEBSOCKET DISCONNECT (gap begins)
      realtime.simulateDisconnect(env.client, 'WebSocket transport failure (CHANNEL_ERROR)');
      assert.strictEqual(realtime.getConnectionHealth().isSubscribed, false);

      // 5. CHANGES OCCUR DURING DISCONNECT GAP (No Realtime listeners execute!):
      // A. User 1: Revoked campus lead in OS (no rows in user_roles, chapters.campus_lead_id is null)
      // B. User 2: Unlinked in OS
      const p2 = mockDb.profiles.find((p) => p.id === userUnlinkedId);
      p2.discord_connected = false;
      const l2 = mockDb.discord_links.find((l) => l.os_user_id === userUnlinkedId);
      l2.status = 'unlinked';

      // C. Cluster created offline while bot was disconnected (discord_category_id IS NULL)
      const offlineCluster = {
        id: 'cluster_gap_offline',
        name: 'Artificial Intelligence',
        chapter_id: 'chapter_alpha',
        access_mode: 'invite',
        status: 'active',
        discord_role_id: null,
        discord_category_id: null,
      };
      mockDb.clusters.push(offlineCluster);

      // D. Pending role queued for User 3 in that cluster, and user added to cluster_members
      mockDb.cluster_members.push({
        cluster_id: offlineCluster.id,
        user_id: userPendingId,
        role_in_cluster: 'member',
      });
      mockDb.pending_discord_roles.push({
        id: 'pend_gap_1',
        user_id: userPendingId,
        target_id: offlineCluster.id,
        role_type: 'cluster_member',
        guild_id: 'chapter_guild_1',
      });

      // Verify unhealed drift BEFORE reconciliation:
      assert.strictEqual(memberLead.roles.cache.has(campusLeadRole.id), true, 'Member 1 still has Campus Lead before recon');
      assert.strictEqual(memberUnlinked.roles.cache.has(verifiedRole.id), true, 'Member 2 still has Verified Member before recon');
      assert.strictEqual(offlineCluster.discord_category_id, null, 'Cluster still unprovisioned before recon');
      assert.strictEqual(mockDb.pending_discord_roles.length, 1, 'Pending role still queued before recon');

      // 6. RECONCILIATION INTERVAL RUNS (Auto-heals all gap drift without bot restart)
      const reconResults = await realtime.runFullReconciliation(env.client);
      await waitForSyncQueue();

      // 7. VERIFY COMPREHENSIVE RECOVERY:
      // A. User 1 had Campus Lead revoked, but Verified Member preserved
      assert.strictEqual(memberLead.roles.cache.has(campusLeadRole.id), false, 'Campus Lead role must be revoked');
      assert.strictEqual(memberLead.roles.cache.has(verifiedRole.id), true, 'Verified Member role must be preserved');

      // B. User 2 had Verified Member removed and Unverified assigned
      assert.strictEqual(memberUnlinked.roles.cache.has(verifiedRole.id), false, 'Verified Member role must be removed from unlinked user');
      assert.strictEqual(memberUnlinked.roles.cache.has(unverifiedRole.id), true, 'Unverified role must be assigned to unlinked user');

      // C. Offline cluster was provisioned (category + role created)
      assert.ok(offlineCluster.discord_category_id, 'Cluster category must now be provisioned');
      assert.ok(offlineCluster.discord_role_id, 'Cluster role must now be provisioned');
      const clusterRole = env.chapterGuild.roles.cache.get(offlineCluster.discord_role_id);
      assert.ok(clusterRole, 'Cluster role exists in guild cache');

      // D. Pending role was resolved and removed from pending_discord_roles
      assert.strictEqual(mockDb.pending_discord_roles.length, 0, 'Pending discord role must be resolved and deleted');
      assert.strictEqual(memberPending.roles.cache.has(offlineCluster.discord_role_id), true, 'Member 3 must have cluster role applied');

      // Check return stats
      assert.strictEqual(reconResults.unprovisionedClustersProcessed, 1);
      assert.strictEqual(reconResults.pendingRolesResolved, 1);
    } finally {
      supabase.from = origFrom;
    }
  });

  // Test 7: Resilient recurring reconciliation interval
  await itAsync('Recurring Interval: Resilient timer handles individual run exceptions without terminating the schedule', async () => {
    const env = createMockEnvironment();
    let runCount = 0;
    let thrownOnce = false;

    const origRun = realtime.runFullReconciliation;
    let timer = null;
    try {
      realtime.runFullReconciliation = async () => {
        runCount++;
        if (!thrownOnce) {
          thrownOnce = true;
          throw new Error('Transient Supabase network timeout (simulated)');
        }
        return { ok: true };
      };

      // Start interval with short duration (25ms)
      timer = realtime.startReconciliationInterval(env.client, 25);
      assert.ok(timer, 'Interval timer must be active');

      // Wait for multiple ticks
      await new Promise((r) => setTimeout(r, 90));

      assert.ok(thrownOnce, 'Error was thrown on first run');
      assert.ok(runCount >= 2, `Schedule must continue running after exception (ran ${runCount} times)`);
    } finally {
      realtime.runFullReconciliation = origRun;
      realtime.stopReconciliationInterval();
    }
  });

  // Test 8: Scale efficiency: periodic reconciliation pass does NOT perform full guild.members.fetch()
  await itAsync('Scale Efficiency: Periodic reconciliation pass does NOT perform full guild.members.fetch()', async () => {
    resetMockDb();
    const env = createMockEnvironment();
    const supabase = require('../src/lib/supabase');
    const origFrom = supabase.from;
    setupMockSupabase(supabase);

    try {
      mockDb.guild_config.push(
        { guild_id: 'main_guild_1', guild_type: 'main' },
        { guild_id: 'chapter_guild_1', guild_type: 'chapter', chapter_id: 'chapter_alpha' }
      );

      // Clear recorded fetches
      env.recordedFullFetches.length = 0;

      // Run full reconciliation
      await realtime.runFullReconciliation(env.client);
      await waitForSyncQueue();

      // Assert that full guild.members.fetch() without ID was NEVER called
      assert.strictEqual(
        env.recordedFullFetches.length,
        0,
        `Periodic reconciliation must not perform full guild.members.fetch() (saw calls on: ${env.recordedFullFetches.join(', ')})`
      );
    } finally {
      supabase.from = origFrom;
    }
  });

  console.log('\n========================================');
  console.log('ALL PERFORMANCE & RECONNECTION TESTS PASSED! (8/8 tests)');
  console.log('========================================\n');
}

runTests().catch((err) => {
  console.error('Fatal error in test runner:', err);
  process.exit(1);
});
