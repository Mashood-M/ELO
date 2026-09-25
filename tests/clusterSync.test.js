const assert = require('assert');
const { ChannelType, PermissionFlagsBits, Collection } = require('discord.js');

// In-memory mock database state
const mockDb = {
  clusters: [],
  cluster_members: [],
  pending_discord_roles: [],
  discord_sync_log: [],
  discord_links: [],
  profiles: [],
  guild_config: [],
};

function resetMockDb() {
  mockDb.clusters = [];
  mockDb.cluster_members = [];
  mockDb.pending_discord_roles = [];
  mockDb.discord_sync_log = [];
  mockDb.discord_links = [];
  mockDb.profiles = [];
  mockDb.guild_config = [];
}

// Mock Supabase
const supabase = require('../src/lib/supabase');

supabase.from = function (table) {
  const currentTable = mockDb[table] || [];
  let filters = [];
  let selectFields = '*';
  let isSingle = false;

  const chain = {
    select: (fields) => {
      selectFields = fields || '*';
      return chain;
    },
    insert: (data) => {
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const row = { id: item.id || `mock_uuid_${Math.random().toString(36).slice(2, 9)}`, ...item };
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
          currentTable.push({ id: item.id || `mock_uuid_${Math.random().toString(36).slice(2, 9)}`, ...item });
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
    in: (col, arr) => {
      filters.push((row) => arr.includes(row[col]));
      return chain;
    },
    order: () => chain,
    limit: () => chain,
    maybeSingle: async () => {
      let filtered = currentTable.filter((row) => filters.every((fn) => fn(row)));
      return { data: filtered[0] || null, error: null };
    },
    single: async () => {
      let filtered = currentTable.filter((row) => filters.every((fn) => fn(row)));
      return { data: filtered[0] || null, error: filtered.length ? null : new Error('Row not found') };
    },
    then: (resolve, reject) => {
      let filtered = currentTable.filter((row) => filters.every((fn) => fn(row)));
      return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
    },
  };
  return chain;
};

// Discord Mock Guild Generator
function createMockClient() {
  const guildRoles = new Collection();
  const guildChannels = new Collection();
  const guildMembers = new Collection();

  const everyoneRole = {
    id: 'guild_everyone_role',
    name: '@everyone',
    permissions: { has: () => false },
  };
  guildRoles.set(everyoneRole.id, everyoneRole);

  const me = {
    id: 'bot_user_id',
    user: { id: 'bot_user_id', tag: 'ElevatesBot#0001' },
    permissions: {
      has: () => true,
    },
  };

  const mockGuild = {
    id: 'chapter_guild_1',
    name: 'Elevates Test Chapter Guild',
    members: {
      me,
      cache: guildMembers,
      fetchMe: async () => me,
      fetch: async (id) => {
        if (!id) return guildMembers;
        return guildMembers.get(id) || null;
      },
    },
    roles: {
      everyone: everyoneRole,
      cache: guildRoles,
      fetch: async (id) => (id ? guildRoles.get(id) || null : guildRoles),
      create: async (opts) => {
        const id = `role_${opts.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}`;
        const newRole = {
          id,
          name: opts.name,
          color: opts.color,
          mentionable: Boolean(opts.mentionable),
          hoist: Boolean(opts.hoist),
          members: new Collection(),
        };
        guildRoles.set(id, newRole);
        return newRole;
      },
    },
    channels: {
      cache: guildChannels,
      fetch: async (id) => guildChannels.get(id) || null,
      create: async (opts) => {
        const id = `chan_${opts.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}`;
        const newChan = {
          id,
          name: opts.name,
          type: opts.type,
          parentId: opts.parent || null,
          permissionOverwrites: {
            cache: new Collection(),
            set: async (overwrites) => {
              newChan.appliedOverwrites = overwrites;
            },
          },
          appliedOverwrites: opts.permissionOverwrites || [],
          setName: async (newName) => {
            newChan.name = newName;
          },
        };
        guildChannels.set(id, newChan);
        return newChan;
      },
    },
  };

  const client = {
    user: { id: 'bot_user_id' },
    guilds: {
      cache: new Collection([['chapter_guild_1', mockGuild]]),
      fetch: async (id) => (id === 'chapter_guild_1' ? mockGuild : null),
    },
  };

  return { client, guild: mockGuild, roles: guildRoles, channels: guildChannels, members: guildMembers };
}

function addMockMember(guild, id, tag, initialRoles = []) {
  const roleCache = new Collection();
  for (const rId of initialRoles) {
    const r = guild.roles.cache.get(rId);
    if (r) {
      roleCache.set(r.id, r);
      r.members.set(id, { id });
    }
  }

  const member = {
    id,
    user: { id, tag },
    roles: {
      cache: roleCache,
      add: async (roleOrId) => {
        const rId = typeof roleOrId === 'string' ? roleOrId : roleOrId.id;
        const role = guild.roles.cache.get(rId) || { id: rId, name: 'mock_role' };
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
  };

  guild.members.cache.set(id, member);
  return member;
}

const clusterSync = require('../src/lib/clusterSync');

let totalTests = 0;
let passedTests = 0;

async function test(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    process.exit(1);
  }
}

async function runTests() {
  console.log('--- RUNNING CLUSTER SYNC SYSTEM TEST SUITE ---\n');

  // Test 1: Cluster creation order, immediate role write-back, and channel structure
  await test('Cluster Creation: immediate role write-back before category creation', async () => {
    resetMockDb();
    const { client, guild } = createMockClient();

    const chapterId = 'chp_1111-2222-3333';
    mockDb.guild_config.push({
      guild_id: 'chapter_guild_1',
      guild_type: 'chapter',
      chapter_id: chapterId,
    });

    const clusterId = 'cluster_cybersecurity_123';
    const clusterRecord = {
      id: clusterId,
      name: 'Cybersecurity',
      chapter_id: chapterId,
      status: 'active',
      discord_role_id: null,
      discord_category_id: null,
    };
    mockDb.clusters.push(clusterRecord);

    const setup = await clusterSync.handleClusterCreated(client, clusterRecord);
    assert(setup, 'Setup should return created elements');

    // 1. Role must be created with '<Cluster Name> Member', mentionable: false, hoist: false
    assert.strictEqual(setup.memberRole.name, 'Cybersecurity Member');
    assert.strictEqual(setup.memberRole.mentionable, false);
    assert.strictEqual(setup.memberRole.hoist, false);

    // 2. clusters.discord_role_id was written back
    const updatedCluster = mockDb.clusters.find((c) => c.id === clusterId);
    assert.strictEqual(updatedCluster.discord_role_id, setup.memberRole.id);

    // 3. Category created with permission overwrites at creation
    assert(setup.category, 'Category should be created');
    assert(setup.category.appliedOverwrites.length >= 3, 'Category must have at least @everyone, role, and bot overwrites');

    // Check @everyone denied ViewChannel
    const everyoneOw = setup.category.appliedOverwrites.find((o) => o.id === guild.roles.everyone.id);
    assert(everyoneOw, '@everyone overwrite must be present');
    assert(everyoneOw.deny.includes(PermissionFlagsBits.ViewChannel));

    // Check member role allowed ViewChannel, SendMessages, Connect
    const memberOw = setup.category.appliedOverwrites.find((o) => o.id === setup.memberRole.id);
    assert(memberOw, 'Cluster member role overwrite must be present');
    assert(memberOw.allow.includes(PermissionFlagsBits.ViewChannel));
    assert(memberOw.allow.includes(PermissionFlagsBits.SendMessages));
    assert(memberOw.allow.includes(PermissionFlagsBits.Connect));

    // 4. Child channels created
    assert(setup.channelMap['announcements'], '#announcements must exist');
    assert(setup.channelMap['discussion'], '#discussion must exist');
    assert(setup.channelMap['resources'], '#resources must exist');
    assert(setup.channelMap['challenges'], '#challenges must exist');
    assert(setup.channelMap['projects'], '#projects must exist');
    assert(setup.channelMap['Cybersecurity Voice'], 'Voice channel must exist');

    // 5. clusters.discord_category_id was updated
    assert.strictEqual(updatedCluster.discord_category_id, setup.category.id);

    // 6. discord_sync_log recorded
    const log = mockDb.discord_sync_log.find((l) => l.cluster_id === clusterId && l.event_type === 'cluster_created');
    assert(log, 'discord_sync_log must contain cluster_created entry');
    assert.strictEqual(log.action, 'created');
    assert.strictEqual(log.success, true);
  });

  // Test 2: Member Add when user is linked and present in guild
  await test('Member Add: Linked user present in guild receives cluster role immediately', async () => {
    resetMockDb();
    const { client, guild } = createMockClient();

    const chapterId = 'chp_1111-2222-3333';
    mockDb.guild_config.push({
      guild_id: 'chapter_guild_1',
      guild_type: 'chapter',
      chapter_id: chapterId,
    });

    const clusterId = 'cluster_webdev_1';
    const clusterRole = await guild.roles.create({ name: 'WebDev Member', mentionable: false, hoist: false });
    mockDb.clusters.push({
      id: clusterId,
      name: 'WebDev',
      chapter_id: chapterId,
      status: 'active',
      discord_role_id: clusterRole.id,
      discord_category_id: 'cat_webdev',
    });

    const userId = 'user_linked_1';
    const discordId = 'discord_user_1';
    mockDb.discord_links.push({
      os_user_id: userId,
      discord_user_id: discordId,
      status: 'linked',
    });

    const member = addMockMember(guild, discordId, 'Alice#0001');
    assert.strictEqual(member.roles.cache.has(clusterRole.id), false);

    await clusterSync.handleMemberAdded(client, {
      cluster_id: clusterId,
      user_id: userId,
      role_in_cluster: 'member',
    });

    assert(member.roles.cache.has(clusterRole.id), 'Member should have received the cluster role');

    const log = mockDb.discord_sync_log.find((l) => l.user_id === userId && l.action === 'granted');
    assert(log, 'discord_sync_log must record granted action');
    assert.strictEqual(log.success, true);
  });

  // Test 3: Member Add when user is NOT linked -> queued in pending_discord_roles
  await test('Member Add: Unlinked user is queued in pending_discord_roles', async () => {
    resetMockDb();
    const { client } = createMockClient();

    const chapterId = 'chp_1111-2222-3333';
    mockDb.guild_config.push({
      guild_id: 'chapter_guild_1',
      guild_type: 'chapter',
      chapter_id: chapterId,
    });

    const clusterId = 'cluster_ai_1';
    mockDb.clusters.push({
      id: clusterId,
      name: 'AI',
      chapter_id: chapterId,
      status: 'active',
      discord_role_id: 'role_ai_member',
      discord_category_id: 'cat_ai',
    });

    const unlinkedUserId = 'user_unlinked_999';

    await clusterSync.handleMemberAdded(client, {
      cluster_id: clusterId,
      user_id: unlinkedUserId,
      role_in_cluster: 'member',
    });

    const pending = mockDb.pending_discord_roles.find((p) => p.user_id === unlinkedUserId && p.target_id === clusterId);
    assert(pending, 'Unlinked user must be queued in pending_discord_roles');
    assert.strictEqual(pending.role_type, 'cluster_member');

    const log = mockDb.discord_sync_log.find((l) => l.user_id === unlinkedUserId && l.cluster_id === clusterId);
    assert(log, 'discord_sync_log must record pending state');
  });

  // Test 4: Member Add rejected for archived cluster
  await test('Member Add: Rejects auto-assignment for archived cluster', async () => {
    resetMockDb();
    const { client } = createMockClient();

    const clusterId = 'cluster_archived_1';
    mockDb.clusters.push({
      id: clusterId,
      name: 'Old Cluster',
      chapter_id: 'chp_1',
      status: 'archived',
      discord_role_id: 'role_old',
    });

    const userId = 'user_test_2';
    await clusterSync.handleMemberAdded(client, {
      cluster_id: clusterId,
      user_id: userId,
      role_in_cluster: 'member',
    });

    const log = mockDb.discord_sync_log.find((l) => l.user_id === userId && l.cluster_id === clusterId);
    assert(log, 'Must log outcome');
    assert.strictEqual(log.success, false);
    assert(log.error_message.includes('archived'), 'Must indicate rejection due to cluster archival');
  });

  // Test 5: Member Remove revokes role and CRITICALLY deletes pending roles
  await test('Member Remove: Revokes role and deletes matching pending_discord_roles row', async () => {
    resetMockDb();
    const { client, guild } = createMockClient();

    const chapterId = 'chp_1111-2222-3333';
    mockDb.guild_config.push({
      guild_id: 'chapter_guild_1',
      guild_type: 'chapter',
      chapter_id: chapterId,
    });

    const clusterId = 'cluster_mobile_1';
    const clusterRole = await guild.roles.create({ name: 'Mobile Member', mentionable: false, hoist: false });
    mockDb.clusters.push({
      id: clusterId,
      name: 'Mobile',
      chapter_id: chapterId,
      status: 'active',
      discord_role_id: clusterRole.id,
    });

    const userId = 'user_to_remove';
    const discordId = 'discord_to_remove';
    mockDb.discord_links.push({
      os_user_id: userId,
      discord_user_id: discordId,
      status: 'linked',
    });

    // Add role to member
    const member = addMockMember(guild, discordId, 'Bob#0001', [clusterRole.id]);
    assert(member.roles.cache.has(clusterRole.id));

    // Also simulate a pending role row exists
    mockDb.pending_discord_roles.push({
      id: 'pending_to_clean',
      user_id: userId,
      role_type: 'cluster_member',
      target_id: clusterId,
    });

    await clusterSync.handleMemberRemoved(client, {
      cluster_id: clusterId,
      user_id: userId,
    });

    // 1. Role removed from member in guild
    assert.strictEqual(member.roles.cache.has(clusterRole.id), false, 'Role must be revoked from member');

    // 2. CRITICAL: matching pending_discord_roles row deleted
    const pendingStillExists = mockDb.pending_discord_roles.some((p) => p.user_id === userId && p.target_id === clusterId);
    assert.strictEqual(pendingStillExists, false, 'Pending role row must be deleted upon member removal');

    // 3. Log recorded
    const log = mockDb.discord_sync_log.find((l) => l.user_id === userId && l.action === 'revoked');
    assert(log, 'Revocation must be logged');
    assert.strictEqual(log.success, true);
  });

  // Test 6: Link resolution handles pending roles with error isolation
  await test('Link Resolution: Resolves pending roles and isolates row errors', async () => {
    resetMockDb();
    const { client, guild } = createMockClient();

    const chapterId = 'chp_1111-2222-3333';
    mockDb.guild_config.push({
      guild_id: 'chapter_guild_1',
      guild_type: 'chapter',
      chapter_id: chapterId,
    });

    const role1 = await guild.roles.create({ name: 'Valid Member' });
    const cluster1 = { id: 'cl_valid', name: 'Valid', chapter_id: chapterId, status: 'active', discord_role_id: role1.id };
    const clusterArchived = { id: 'cl_archived', name: 'Archived', chapter_id: chapterId, status: 'archived', discord_role_id: 'role_archived' };
    mockDb.clusters.push(cluster1, clusterArchived);

    const userId = 'user_multi_pending';
    const discordId = 'discord_multi_pending';
    addMockMember(guild, discordId, 'Charlie#0001');

    // User has 2 pending roles: one for an active cluster, one for an archived cluster
    mockDb.pending_discord_roles.push({
      id: 'p1',
      user_id: userId,
      role_type: 'cluster_member',
      target_id: 'cl_valid',
    });
    mockDb.pending_discord_roles.push({
      id: 'p2',
      user_id: userId,
      role_type: 'cluster_member',
      target_id: 'cl_archived',
    });

    mockDb.discord_links.push({
      os_user_id: userId,
      discord_user_id: discordId,
      status: 'linked',
    });

    await clusterSync.handleUserLinked(client, {
      os_user_id: userId,
      discord_user_id: discordId,
    });

    const member = guild.members.cache.get(discordId);
    // Valid role must be granted
    assert(member.roles.cache.has(role1.id), 'Valid pending role must be granted on link');

    // Both pending rows must have been handled (valid granted & deleted, archived skipped & deleted)
    assert.strictEqual(mockDb.pending_discord_roles.length, 0, 'Processed pending roles must be removed');

    const validLog = mockDb.discord_sync_log.find((l) => l.cluster_id === 'cl_valid');
    assert(validLog && validLog.success === true, 'Valid role grant logged');

    const archivedLog = mockDb.discord_sync_log.find((l) => l.cluster_id === 'cl_archived');
    assert(archivedLog && archivedLog.success === false, 'Archived cluster pending role logged as failure');
  });

  // Test 7: Archival renames category to [ARCHIVED] and retains channels
  await test('Archival: Category renamed to [ARCHIVED] and channels preserved intact', async () => {
    resetMockDb();
    const { client, guild } = createMockClient();

    const chapterId = 'chp_1111-2222-3333';
    mockDb.guild_config.push({
      guild_id: 'chapter_guild_1',
      guild_type: 'chapter',
      chapter_id: chapterId,
    });

    const category = await guild.channels.create({
      name: '🛡️・CYBERSECURITY',
      type: ChannelType.GuildCategory,
    });

    const clusterId = 'cluster_to_archive';
    mockDb.clusters.push({
      id: clusterId,
      name: 'Cybersecurity',
      chapter_id: chapterId,
      status: 'archived',
      discord_category_id: category.id,
      discord_role_id: 'role_cyber',
    });

    await clusterSync.handleClusterArchived(client, { id: clusterId });

    assert(category.name.startsWith('[ARCHIVED]'), 'Category name must start with [ARCHIVED]');
    assert.strictEqual(guild.channels.cache.has(category.id), true, 'Category must NOT be deleted');

    const log = mockDb.discord_sync_log.find((l) => l.cluster_id === clusterId && l.event_type === 'cluster_archived');
    assert(log, 'Archival must be logged to discord_sync_log');
    assert.strictEqual(log.action, 'archived');
    assert.strictEqual(log.success, true);
  });

  // Test 8: Reconciliation corrects drift (grants missing, revokes excess)
  await test('Reconciliation: Corrects role drift by granting missing and revoking excess roles', async () => {
    resetMockDb();
    const { client, guild } = createMockClient();

    const chapterId = 'chp_1111-2222-3333';
    mockDb.guild_config.push({
      guild_id: 'chapter_guild_1',
      guild_type: 'chapter',
      chapter_id: chapterId,
    });

    const memberRole = await guild.roles.create({ name: 'Robotics Member' });
    const clusterId = 'cluster_robotics_1';
    mockDb.clusters.push({
      id: clusterId,
      name: 'Robotics',
      chapter_id: chapterId,
      status: 'active',
      discord_role_id: memberRole.id,
    });

    // User A: in Supabase cluster_members, linked, but DOES NOT have Discord role (missing)
    const userA = 'user_a';
    const discordA = 'discord_a';
    mockDb.profiles.push({ id: userA, discord_user_id: discordA, discord_connected: true });
    mockDb.cluster_members.push({ cluster_id: clusterId, user_id: userA, role_in_cluster: 'member' });
    const memberA = addMockMember(guild, discordA, 'UserA#0001'); // no role

    // User B: in Discord role, but NOT in Supabase cluster_members (excess)
    const discordB = 'discord_b';
    const memberB = addMockMember(guild, discordB, 'UserB#0001', [memberRole.id]); // has role

    // Run reconciliation
    const result = await clusterSync.reconcileClusterMembers(client, clusterId);

    assert(result, 'Reconciliation result should be returned');
    assert(result.granted.includes(discordA), 'User A should have missing role granted');
    assert(result.revoked.includes(discordB), 'User B should have excess role revoked');

    assert(memberA.roles.cache.has(memberRole.id), 'User A now has member role');
    assert(!memberB.roles.cache.has(memberRole.id), 'User B no longer has member role');

    // Check drift logs
    const grantedLog = mockDb.discord_sync_log.find(
      (l) => l.cluster_id === clusterId && l.event_type === 'reconciliation_drift_corrected' && l.action === 'granted'
    );
    assert(grantedLog, 'Granted drift correction logged');

    const revokedLog = mockDb.discord_sync_log.find(
      (l) => l.cluster_id === clusterId && l.event_type === 'reconciliation_drift_corrected' && l.action === 'revoked'
    );
    assert(revokedLog, 'Revoked drift correction logged');
  });

  console.log(`\n========================================`);
  console.log(`ALL CLUSTER SYNC TESTS PASSED! (${passedTests}/${totalTests} tests)`);
  console.log(`========================================\n`);
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
