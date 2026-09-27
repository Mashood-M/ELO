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
  if (typeof clusterSync !== 'undefined' && typeof clusterSync.clearClusterCaches === 'function') {
    clusterSync.clearClusterCaches();
  }
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
    is: (col, val) => {
      filters.push((row) => (val === null ? row[col] === null || row[col] === undefined : row[col] === val));
      return chain;
    },
    ilike: (col, val) => {
      filters.push((row) => String(row[col] || '').toLowerCase() === String(val || '').toLowerCase());
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
        const id = `role_${opts.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
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
      fetch: async (id) => (id ? guildChannels.get(id) || null : guildChannels),
      create: async (opts) => {
        const id = `chan_${opts.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
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
          lockPermissions: async () => {
            newChan.permissionsLocked = true;
            if (newChan.parentId) {
              const parentCat = guildChannels.get(newChan.parentId);
              if (parentCat) {
                newChan.appliedOverwrites = parentCat.appliedOverwrites || [];
              }
            }
          },
          delete: async () => {
            guildChannels.delete(newChan.id);
            guildChannels.delete(id);
            return newChan;
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
    assert(setup.channelMap['cluster-room'], 'Voice channel cluster-room must exist');
    assert(setup.channelMap['cluster-room 1'], 'Voice channel cluster-room 1 must exist');

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

  // Test 9: Boot Reconciliation: provisions unprovisioned clusters (discord_category_id IS NULL)
  await test('Startup Reconciliation: Queries unprovisioned clusters and executes live INSERT creation logic', async () => {
    resetMockDb();
    const { client, guild } = createMockClient();

    const chapterId = 'chp_startup_recon_1';
    mockDb.guild_config.push({
      guild_id: 'chapter_guild_1',
      guild_type: 'chapter',
      chapter_id: chapterId,
    });

    const leadUser = 'user_lead_boot';
    const leadDiscord = 'discord_lead_boot';
    mockDb.profiles.push({ id: leadUser, discord_user_id: leadDiscord, discord_connected: true });
    mockDb.discord_links.push({ id: 'link_lead_boot', user_id: leadUser, discord_user_id: leadDiscord, status: 'linked' });
    const leadMember = addMockMember(guild, leadDiscord, 'LeadBoot#0001');

    const memberUser = 'user_mem_boot';
    const memberDiscord = 'discord_mem_boot';
    mockDb.profiles.push({ id: memberUser, discord_user_id: memberDiscord, discord_connected: true });
    mockDb.discord_links.push({ id: 'link_mem_boot', user_id: memberUser, discord_user_id: memberDiscord, status: 'linked' });
    const regularMember = addMockMember(guild, memberDiscord, 'MemBoot#0001');

    // Unprovisioned cluster created while offline (discord_category_id: null)
    const clusterId = 'cluster_offline_created';
    mockDb.clusters.push({
      id: clusterId,
      name: 'Game Development',
      chapter_id: chapterId,
      status: 'active',
      leader_id: leadUser,
      member_ids: [memberUser],
      discord_role_id: null,
      discord_category_id: null,
    });

    // Run startup reconciliation
    const processed = await clusterSync.reconcileUnprovisionedClusters(client);

    assert(Array.isArray(processed), 'Should return array of processed clusters');
    assert.strictEqual(processed.length, 1, 'Should have processed 1 unprovisioned cluster');
    assert.strictEqual(processed[0].cluster.id, clusterId);

    // Verify DB cluster updated
    const updated = mockDb.clusters.find((c) => c.id === clusterId);
    assert(updated.discord_category_id, 'discord_category_id must be updated in DB');
    assert(updated.discord_role_id, 'discord_role_id must be updated in DB');

    // Verify Discord entities created
    const category = guild.channels.cache.get(updated.discord_category_id);
    assert(category, 'Category must exist in Discord guild');
    assert(category.name.includes('GAME DEVELOPMENT'), 'Category name should match convention');

    const voice1 = guild.channels.cache.find((c) => c.parentId === category.id && c.name === 'cluster-room');
    const voice2 = guild.channels.cache.find((c) => c.parentId === category.id && c.name === 'cluster-room 1');
    assert(voice1, 'Voice channel cluster-room must exist under category');
    assert(voice2, 'Voice channel cluster-room 1 must exist under category');

    const memberRole = guild.roles.cache.get(updated.discord_role_id);
    assert(memberRole, 'Member role must exist');
    assert.strictEqual(memberRole.name, 'Game Development Member');

    // Verify member and host roles assigned
    assert(regularMember.roles.cache.has(memberRole.id), 'Regular member should have cluster role');
    assert(leadMember.roles.cache.has(memberRole.id), 'Lead should have cluster member role');

    // Verify discord_sync_log entry
    const syncLog = mockDb.discord_sync_log.find(
      (l) => l.cluster_id === clusterId && l.event_type === 'cluster_created' && l.action === 'created'
    );
    assert(syncLog, 'cluster_created log must be present in discord_sync_log');
    assert.strictEqual(syncLog.success, true);
  });

  // Test 10: Boot Reconciliation: picks up cluster that failed partway through creation previously
  await test('Startup Reconciliation: Recovers clusters that failed partway through creation previously', async () => {
    resetMockDb();
    const { client, guild } = createMockClient();

    const chapterId = 'chp_partial_fail_1';
    mockDb.guild_config.push({
      guild_id: 'chapter_guild_1',
      guild_type: 'chapter',
      chapter_id: chapterId,
    });

    // Role was created previously before a crash, but category creation never completed
    const existingRole = await guild.roles.create({ name: 'DevOps Member' });
    const clusterId = 'cluster_partial_fail_1';
    mockDb.clusters.push({
      id: clusterId,
      name: 'DevOps',
      chapter_id: chapterId,
      status: 'active',
      discord_role_id: existingRole.id,
      discord_category_id: null, // failed partway
    });

    const initialRolesCount = guild.roles.cache.size;

    const processed = await clusterSync.reconcileUnprovisionedClusters(client);

    assert.strictEqual(processed.length, 1);
    const updated = mockDb.clusters.find((c) => c.id === clusterId);
    assert(updated.discord_category_id, 'discord_category_id should now be provisioned');
    assert.strictEqual(updated.discord_role_id, existingRole.id, 'Should reuse existing role without duplicating');

    // Should not create duplicate role
    const devOpsRoles = guild.roles.cache.filter((r) => r.name === 'DevOps Member');
    assert.strictEqual(devOpsRoles.size, 1, 'Must not duplicate existing role');
  });

  // Test 11: Boot Reconciliation: skips already provisioned clusters
  await test('Startup Reconciliation: Skips already provisioned clusters', async () => {
    resetMockDb();
    const { client, guild } = createMockClient();

    const chapterId = 'chp_already_prov_1';
    mockDb.guild_config.push({
      guild_id: 'chapter_guild_1',
      guild_type: 'chapter',
      chapter_id: chapterId,
    });

    const clusterId = 'cluster_already_prov_1';
    mockDb.clusters.push({
      id: clusterId,
      name: 'Mobile Dev',
      chapter_id: chapterId,
      status: 'active',
      discord_role_id: 'role_existing_mob',
      discord_category_id: 'cat_existing_mob', // already provisioned
    });

    const processed = await clusterSync.reconcileUnprovisionedClusters(client);
    assert.strictEqual(processed.length, 0, 'Already provisioned clusters should not be processed');
  });

  // ==========================================================================
  // Test 10: Category Privacy & Channel Inheritance
  // ==========================================================================
  await test('Category Privacy: Fresh cluster creation sets explicit deny on Verified Member & @everyone, allows Member/Host/Campus Lead/Founder/HQ Admin, withholds blanket access from Executive Member/Class Rep/Student, and locks child channels', async () => {
    resetMockDb();
    const { client, guild } = createMockClient();

    const chapterId = 'chp_privacy_test_1';
    mockDb.guild_config.push({
      guild_id: 'chapter_guild_1',
      guild_type: 'chapter',
      chapter_id: chapterId,
    });

    // Seed chapter roles: Verified Member, ELEVATES • Member, Campus Lead, Founder, HQ Admin, Executive Member, Class Rep, Student
    const verifiedRole = await guild.roles.create({ name: 'Verified Member' });
    const elevMemberRole = await guild.roles.create({ name: 'ELEVATES • Member' });
    const campusLeadRole = await guild.roles.create({ name: 'Campus Lead' });
    const founderRole = await guild.roles.create({ name: 'Founder' });
    const adminRole = await guild.roles.create({ name: 'HQ Admin' });
    const execRole = await guild.roles.create({ name: 'Executive Member' });
    const classRepRole = await guild.roles.create({ name: 'Class Rep' });
    const studentRole = await guild.roles.create({ name: 'Student' });

    const clusterId = 'cluster_ml_privacy_1';
    const clusterRecord = {
      id: clusterId,
      name: 'Machine Learning',
      chapter_id: chapterId,
      status: 'active',
      discord_role_id: null,
      discord_category_id: null,
    };
    mockDb.clusters.push(clusterRecord);

    const setup = await clusterSync.handleClusterCreated(client, clusterRecord);
    assert(setup, 'handleClusterCreated should return setup object');
    assert(setup.category, 'Cluster category must be created');

    const catOverwrites = setup.category.appliedOverwrites;
    assert(Array.isArray(catOverwrites), 'appliedOverwrites must be an array');

    // 1. @everyone: EXPLICIT DENY ViewChannel
    const everyoneOw = catOverwrites.find((o) => o.id === guild.roles.everyone.id);
    assert(everyoneOw, '@everyone overwrite must be present');
    assert(everyoneOw.deny.includes(PermissionFlagsBits.ViewChannel), '@everyone must be explicitly denied ViewChannel');

    // 2. Verified Member (and ELEVATES • Member): EXPLICIT DENY ViewChannel
    const verifiedOw = catOverwrites.find((o) => o.id === verifiedRole.id);
    assert(verifiedOw, 'Verified Member overwrite must be present');
    assert(verifiedOw.deny.includes(PermissionFlagsBits.ViewChannel), 'Verified Member must be explicitly denied ViewChannel');

    const elevMemberOw = catOverwrites.find((o) => o.id === elevMemberRole.id);
    assert(elevMemberOw, 'ELEVATES • Member overwrite must be present');
    assert(elevMemberOw.deny.includes(PermissionFlagsBits.ViewChannel), 'ELEVATES • Member must be explicitly denied ViewChannel');

    // 3. Cluster's own "<Cluster Name> Member" role: ALLOW ViewChannel, SendMessages, Connect
    const memberOw = catOverwrites.find((o) => o.id === setup.memberRole.id);
    assert(memberOw, 'Cluster Member role overwrite must be present');
    assert(memberOw.allow.includes(PermissionFlagsBits.ViewChannel), 'Member role must be allowed ViewChannel');
    assert(memberOw.allow.includes(PermissionFlagsBits.SendMessages), 'Member role must be allowed SendMessages');
    assert(memberOw.allow.includes(PermissionFlagsBits.Connect), 'Member role must be allowed Connect');

    // 4. "<Cluster Name> Host" role: ALLOW same as Member plus ManageMessages, pin, voice management
    const hostRole = guild.roles.cache.find((r) => r.name === 'Machine Learning Host');
    assert(hostRole, 'Cluster Host role must exist in guild');
    const hostOw = catOverwrites.find((o) => o.id === hostRole.id);
    assert(hostOw, 'Host role overwrite must be present');
    assert(hostOw.allow.includes(PermissionFlagsBits.ViewChannel), 'Host role must be allowed ViewChannel');
    assert(hostOw.allow.includes(PermissionFlagsBits.SendMessages), 'Host role must be allowed SendMessages');
    assert(hostOw.allow.includes(PermissionFlagsBits.Connect), 'Host role must be allowed Connect');
    assert(hostOw.allow.includes(PermissionFlagsBits.ManageMessages), 'Host role must be allowed ManageMessages (pin/delete)');
    assert(hostOw.allow.includes(PermissionFlagsBits.MuteMembers), 'Host role must be allowed MuteMembers (voice management)');

    // 5. Campus Lead, Founder, HQ Admin, Executive Member, Class Rep, Student: MUST NOT have allow overwrites on cluster category
    const campusLeadOw = catOverwrites.find((o) => o.id === campusLeadRole.id);
    assert(!campusLeadOw || !campusLeadOw.allow?.includes(PermissionFlagsBits.ViewChannel), 'Campus Lead must NOT have allow overwrite');

    // 6. Executive Member role: decide and confirm — default to NOT granting blanket access
    const execOw = catOverwrites.find((o) => o.id === execRole.id);
    assert(!execOw || !execOw.allow?.includes(PermissionFlagsBits.ViewChannel), 'Executive Member must NOT have blanket ViewChannel access');

    // 7. Class Rep & Student: MUST NOT have allow overwrites
    const classRepOw = catOverwrites.find((o) => o.id === classRepRole.id);
    assert(!classRepOw || !classRepOw.allow?.includes(PermissionFlagsBits.ViewChannel), 'Class Rep must NOT have allow overwrite');

    const studentOw = catOverwrites.find((o) => o.id === studentRole.id);
    assert(!studentOw || !studentOw.allow?.includes(PermissionFlagsBits.ViewChannel), 'Student must NOT have allow overwrite');

    // 8. Founder / HQ Admin: MUST NOT have allow overwrites (only member tag users can access)
    const founderOw = catOverwrites.find((o) => o.id === founderRole.id);
    assert(!founderOw || !founderOw.allow?.includes(PermissionFlagsBits.ViewChannel), 'Founder must NOT have allow overwrite');

    const adminOw = catOverwrites.find((o) => o.id === adminRole.id);
    assert(!adminOw || !adminOw.allow?.includes(PermissionFlagsBits.ViewChannel), 'HQ Admin must NOT have allow overwrite');

    // 9. Bot's own role: ALLOW manage channels/roles
    const botOw = catOverwrites.find((o) => o.id === client.user.id || o.id === guild.members.me.id);
    assert(botOw, 'Bot overwrite must be present');
    assert(botOw.allow.includes(PermissionFlagsBits.ManageChannels), 'Bot must be allowed ManageChannels');
    assert(botOw.allow.includes(PermissionFlagsBits.ManageRoles), 'Bot must be allowed ManageRoles');

    // 10. Check child channels (#announcements, #discussion, voice channels) inherit category overwrites
    const annChannelId = setup.channelMap['announcements'];
    const annChannel = guild.channels.cache.get(annChannelId);
    assert(annChannel, '#announcements channel must exist');
    assert.strictEqual(annChannel.permissionsLocked, true, '#announcements channel must be locked to category');

    // Confirm that in #announcements, ONLY cluster member and host tags are allowed
    const allowedRoleIds = annChannel.appliedOverwrites
      .filter((ow) => ow.allow && ow.allow.includes(PermissionFlagsBits.ViewChannel))
      .map((ow) => ow.id);

    assert(allowedRoleIds.includes(setup.memberRole.id), '#announcements allows cluster member');
    assert(allowedRoleIds.includes(hostRole.id), '#announcements allows cluster host');
    assert(!allowedRoleIds.includes(campusLeadRole.id), '#announcements must NOT allow campus lead');
    assert(!allowedRoleIds.includes(founderRole.id), '#announcements must NOT allow founder');
    assert(!allowedRoleIds.includes(adminRole.id), '#announcements must NOT allow HQ admin');
    assert(!allowedRoleIds.includes(verifiedRole.id), '#announcements must NOT allow Verified Member');
    assert(!allowedRoleIds.includes(guild.roles.everyone.id), '#announcements must NOT allow @everyone');
    assert(!allowedRoleIds.includes(execRole.id), '#announcements must NOT allow Executive Member');
    assert(!allowedRoleIds.includes(classRepRole.id), '#announcements must NOT allow Class Rep');
    assert(!allowedRoleIds.includes(studentRole.id), '#announcements must NOT allow Student');
  });

  // ==========================================================================
  // Test 11: Retroactive Permission Reconciliation
  // ==========================================================================
  await test('Category Privacy: Retroactive reconciliation re-applies secure overwrites and locks child channels across existing clusters', async () => {
    resetMockDb();
    const { client, guild } = createMockClient();

    const chapterId = 'chp_retro_privacy_1';
    mockDb.guild_config.push({
      guild_id: 'chapter_guild_1',
      guild_type: 'chapter',
      chapter_id: chapterId,
    });

    const verifiedRole = await guild.roles.create({ name: 'Verified Member' });
    const campusLeadRole = await guild.roles.create({ name: 'Campus Lead' });
    const founderRole = await guild.roles.create({ name: 'Founder' });
    const adminRole = await guild.roles.create({ name: 'HQ Admin' });
    const execRole = await guild.roles.create({ name: 'Executive Member' });
    const memberRole = await guild.roles.create({ name: 'Data Engineering Member' });
    const hostRole = await guild.roles.create({ name: 'Data Engineering Host' });

    // Existing category created BEFORE the fix with INSECURE overwrites:
    // - only @everyone denied
    // - Verified Member NOT denied (omitted)
    // - Executive Member granted ALLOW
    // - Host, Founder, HQ Admin omitted
    const insecureOverwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: memberRole.id, allow: [PermissionFlagsBits.ViewChannel] },
      { id: execRole.id, allow: [PermissionFlagsBits.ViewChannel] }, // Insecure blanket access!
    ];

    const category = await guild.channels.create({
      name: '📦・DATA ENGINEERING',
      type: ChannelType.GuildCategory,
      permissionOverwrites: insecureOverwrites,
    });

    const annChannel = await guild.channels.create({
      name: 'announcements',
      type: ChannelType.GuildAnnouncement,
      parent: category.id,
      permissionOverwrites: [{ id: verifiedRole.id, allow: [PermissionFlagsBits.ViewChannel] }], // Stray channel-level allow
    });
    annChannel.permissionsLocked = false;

    const clusterId = 'cluster_data_eng_retro';
    mockDb.clusters.push({
      id: clusterId,
      name: 'Data Engineering',
      chapter_id: chapterId,
      status: 'active',
      discord_role_id: memberRole.id,
      discord_category_id: category.id,
    });

    // Run reconciliation pass
    const results = await clusterSync.reconcileAllClusters(client);
    assert(results, 'reconcileAllClusters must succeed');

    // Verify category overwrites were retroactively corrected
    const healedCategory = guild.channels.cache.get(category.id);
    assert(healedCategory, 'Category must exist');

    const healedOw = healedCategory.appliedOverwrites;

    // 1. Verified Member is now explicitly DENIED
    const vmOw = healedOw.find((o) => o.id === verifiedRole.id);
    assert(vmOw, 'Verified Member overwrite must now be present on existing category');
    assert(vmOw.deny.includes(PermissionFlagsBits.ViewChannel), 'Verified Member must now be explicitly denied ViewChannel');

    // 2. Executive Member no longer has blanket ALLOW
    const execOw = healedOw.find((o) => o.id === execRole.id);
    assert(!execOw || !execOw.allow?.includes(PermissionFlagsBits.ViewChannel), 'Executive Member blanket allow must be stripped');

    // 3. Host is ALLOWED
    const hostOw = healedOw.find((o) => o.id === hostRole.id);
    assert(hostOw, 'Host overwrite must now be present');
    assert(hostOw.allow.includes(PermissionFlagsBits.ViewChannel));
    assert(hostOw.allow.includes(PermissionFlagsBits.ManageMessages));

    // 4. Campus Lead, Founder, HQ Admin are stripped of blanket ViewChannel
    const clOw = healedOw.find((o) => o.id === campusLeadRole.id);
    assert(!clOw || !clOw.allow?.includes(PermissionFlagsBits.ViewChannel), 'Campus Lead allow must be stripped');

    const fOw = healedOw.find((o) => o.id === founderRole.id);
    assert(!fOw || !fOw.allow?.includes(PermissionFlagsBits.ViewChannel), 'Founder allow must be stripped');

    const admOw = healedOw.find((o) => o.id === adminRole.id);
    assert(!admOw || !admOw.allow?.includes(PermissionFlagsBits.ViewChannel), 'HQ Admin allow must be stripped');

    // 4. Child channel #announcements had permissions locked and stray allows stripped
    const healedAnn = guild.channels.cache.get(annChannel.id);
    assert.strictEqual(healedAnn.permissionsLocked, true, '#announcements must now be locked to category');

    const annAllowedIds = healedAnn.appliedOverwrites
      .filter((ow) => ow.allow && ow.allow.includes(PermissionFlagsBits.ViewChannel))
      .map((ow) => ow.id);

    assert(!annAllowedIds.includes(verifiedRole.id), 'Stray Verified Member allow must be stripped from #announcements');
    assert(!annAllowedIds.includes(execRole.id), 'Executive Member must NOT have access to #announcements');
    assert(annAllowedIds.includes(memberRole.id), '#announcements allows Member');
    assert(annAllowedIds.includes(hostRole.id), '#announcements allows Host');
  });

  await test('cleanupDuplicateClusterCategoriesAndChannels: deletes redundant duplicate categories and duplicate child channels', async () => {
    resetMockDb();
    const { client, guild } = createMockClient();
    mockDb.guild_config.push({
      guild_id: guild.id,
      guild_type: 'chapter',
      chapter_id: 'chapter_test',
    });

    const clusterId = 'cluster_dup_test_1';
    const cluster = {
      id: clusterId,
      name: 'Cyber Security',
      chapter_id: 'chapter_test',
      discord_category_id: 'cat_cyber_1',
    };
    mockDb.clusters.push(cluster);

    // Create 3 duplicate categories in Discord
    const cat1 = await guild.channels.create({
      name: '🧠・CYBER SECURITY',
      type: ChannelType.GuildCategory,
    });
    guild.channels.cache.delete(cat1.id);
    cat1.id = 'cat_cyber_1';
    guild.channels.cache.set('cat_cyber_1', cat1);

    const cat2 = await guild.channels.create({
      name: '🧠・CYBER SECURITY',
      type: ChannelType.GuildCategory,
    });
    guild.channels.cache.delete(cat2.id);
    cat2.id = 'cat_cyber_2';
    guild.channels.cache.set('cat_cyber_2', cat2);

    const cat3 = await guild.channels.create({
      name: '🧠・CYBER SECURITY',
      type: ChannelType.GuildCategory,
    });
    guild.channels.cache.delete(cat3.id);
    cat3.id = 'cat_cyber_3';
    guild.channels.cache.set('cat_cyber_3', cat3);

    // Create child channels under cat1 (including a duplicate announcements)
    const chAnn1 = await guild.channels.create({ name: 'announcements', type: ChannelType.GuildAnnouncement, parent: 'cat_cyber_1' });
    const chAnn2 = await guild.channels.create({ name: 'announcements', type: ChannelType.GuildAnnouncement, parent: 'cat_cyber_1' }); // duplicate!
    const chDisc1 = await guild.channels.create({ name: 'discussion', type: ChannelType.GuildForum, parent: 'cat_cyber_1' });

    // Create child channels under duplicate categories
    const chDup1 = await guild.channels.create({ name: 'announcements', type: ChannelType.GuildAnnouncement, parent: 'cat_cyber_2' });
    const chDup2 = await guild.channels.create({ name: 'discussion', type: ChannelType.GuildForum, parent: 'cat_cyber_3' });

    assert.strictEqual(guild.channels.cache.filter((c) => c.type === ChannelType.GuildCategory).size, 3, 'Initial categories count should be 3');

    // Run cleanupDuplicateClusterCategoriesAndChannels
    const canonical = await clusterSync.cleanupDuplicateClusterCategoriesAndChannels(guild, cluster);

    assert(canonical, 'Canonical category should be returned');
    assert.strictEqual(canonical.id, 'cat_cyber_1', 'Canonical category should be cat_cyber_1');

    // Verify duplicate categories were deleted
    assert(!guild.channels.cache.has('cat_cyber_2'), 'Duplicate category 2 must be deleted');
    assert(!guild.channels.cache.has('cat_cyber_3'), 'Duplicate category 3 must be deleted');
    assert.strictEqual(guild.channels.cache.filter((c) => c.type === ChannelType.GuildCategory).size, 1, 'Only 1 category should remain');

    // Verify child channels under duplicate categories were deleted
    assert(!guild.channels.cache.has(chDup1.id), 'Child channel under duplicate category 2 must be deleted');
    assert(!guild.channels.cache.has(chDup2.id), 'Child channel under duplicate category 3 must be deleted');

    // Verify duplicate announcements inside canonical category was deleted (only 1 announcements remains)
    const canonicalAnnouncements = guild.channels.cache.filter(
      (c) => c.parentId === 'cat_cyber_1' && c.name.toLowerCase() === 'announcements'
    );
    assert.strictEqual(canonicalAnnouncements.size, 1, 'Only 1 announcements channel must remain under canonical category');
  });

  await test('handleClusterCreated: never creates duplicate category or channels when called repeatedly', async () => {
    resetMockDb();
    const { client, guild } = createMockClient();
    mockDb.guild_config.push({
      guild_id: guild.id,
      guild_type: 'chapter',
      chapter_id: 'chapter_test',
    });

    const clusterId = 'cluster_idempotent_1';
    const cluster = {
      id: clusterId,
      name: 'Web Development',
      chapter_id: 'chapter_test',
      access_mode: 'invite',
    };
    mockDb.clusters.push(cluster);

    // First call: provisions cluster
    const res1 = await clusterSync.handleClusterCreated(client, cluster);
    assert(res1, 'First call should succeed');

    const catCount1 = guild.channels.cache.filter((c) => c.type === ChannelType.GuildCategory).size;
    const chanCount1 = guild.channels.cache.filter((c) => c.type !== ChannelType.GuildCategory).size;

    assert.strictEqual(catCount1, 1, 'Should create exactly 1 category');
    assert.strictEqual(chanCount1, 7, 'Should create exactly 7 child channels');

    // Second call with same cluster
    const res2 = await clusterSync.handleClusterCreated(client, cluster);
    assert(res2, 'Second call should succeed');

    const catCount2 = guild.channels.cache.filter((c) => c.type === ChannelType.GuildCategory).size;
    const chanCount2 = guild.channels.cache.filter((c) => c.type !== ChannelType.GuildCategory).size;

    assert.strictEqual(catCount2, 1, 'Category count must remain 1 (no duplicates)');
    assert.strictEqual(chanCount2, 7, 'Child channels count must remain 7 (no duplicates)');
  });

  await test('handleMemberAdded: assigns cluster role when userId is a Discord snowflake ID', async () => {
    resetMockDb();
    const { client, guild } = createMockClient();
    mockDb.guild_config.push({
      guild_id: guild.id,
      guild_type: 'chapter',
      chapter_id: 'chapter_test',
    });

    const clusterId = 'cluster_role_snowflake_1';
    const cluster = {
      id: clusterId,
      name: 'Robotics',
      chapter_id: 'chapter_test',
      access_mode: 'invite',
    };
    mockDb.clusters.push(cluster);

    const discordSnowflake = '987654321098765432';
    const member = addMockMember(guild, discordSnowflake, 'RoboUser#0001');

    await clusterSync.handleClusterCreated(client, cluster);
    const memberRole = guild.roles.cache.find((r) => r.name.toLowerCase() === 'robotics member');
    assert(memberRole, 'Robotics member role should exist');

    // Add member with direct snowflake ID
    await clusterSync.handleMemberAdded(client, {
      cluster_id: clusterId,
      user_id: discordSnowflake,
      role_in_cluster: 'member',
    });

    assert(member.roles.cache.has(memberRole.id), 'Member should receive Robotics Member role when snowflake ID is passed');
  });

  await test('reconcileClusterMembers: preserves cluster.created_by role and does not revoke it', async () => {
    resetMockDb();
    const { client, guild } = createMockClient();
    mockDb.guild_config.push({
      guild_id: guild.id,
      guild_type: 'chapter',
      chapter_id: 'chapter_test',
    });

    const creatorOsId = 'creator_os_uuid_1';
    const creatorDiscordId = '112233445566778899';

    mockDb.profiles.push({
      id: creatorOsId,
      discord_user_id: creatorDiscordId,
      discord_connected: true,
    });

    const clusterId = 'cluster_creator_test_1';
    const cluster = {
      id: clusterId,
      name: 'Cloud Architecture',
      chapter_id: 'chapter_test',
      created_by: creatorOsId,
      leader_id: null,
      access_mode: 'invite',
      member_ids: [],
    };
    mockDb.clusters.push(cluster);

    await clusterSync.handleClusterCreated(client, cluster);
    const memberRole = guild.roles.cache.find((r) => r.name.toLowerCase() === 'cloud architecture member');
    assert(memberRole, 'Role created');

    const creatorMember = addMockMember(guild, creatorDiscordId, 'CloudCreator#0001', [memberRole.id]);

    // Reconcile members
    const reconRes = await clusterSync.reconcileClusterMembers(client, clusterId);

    assert(!reconRes.revoked.includes(creatorDiscordId), 'Creator role must NOT be revoked during reconciliation');
    assert(creatorMember.roles.cache.has(memberRole.id), 'Creator must retain cluster role');
  });

  await test('Cluster permissions: only cluster member and host tags can access category & channels', async () => {
    resetMockDb();
    const { client, guild } = createMockClient();
    mockDb.guild_config.push({
      guild_id: guild.id,
      guild_type: 'chapter',
      chapter_id: 'chapter_test',
    });

    const leadRole = await guild.roles.create({ name: 'Campus Lead' });
    const founderRole = await guild.roles.create({ name: 'Founder' });
    const adminRole = await guild.roles.create({ name: 'HQ Admin' });
    const verifiedRole = await guild.roles.create({ name: 'Verified Member' });

    const clusterId = 'cluster_strict_member_only';
    const cluster = {
      id: clusterId,
      name: 'Smart Contracts',
      chapter_id: 'chapter_test',
      access_mode: 'invite',
    };
    mockDb.clusters.push(cluster);

    const setup = await clusterSync.handleClusterCreated(client, cluster);
    const catOverwrites = setup.category.appliedOverwrites;

    // Check @everyone & Verified Member explicitly DENIED
    const everyoneOw = catOverwrites.find((o) => o.id === guild.roles.everyone.id);
    assert(everyoneOw && everyoneOw.deny.includes(PermissionFlagsBits.ViewChannel), '@everyone must be DENIED');

    const vmOw = catOverwrites.find((o) => o.id === verifiedRole.id);
    assert(vmOw && vmOw.deny.includes(PermissionFlagsBits.ViewChannel), 'Verified Member must be DENIED');

    // Check Member & Host ALLOWED
    const memberOw = catOverwrites.find((o) => o.id === setup.memberRole.id);
    assert(memberOw && memberOw.allow.includes(PermissionFlagsBits.ViewChannel), 'Cluster Member must be ALLOWED');

    // Check Campus Lead, Founder, HQ Admin are NOT allowed
    const leadOw = catOverwrites.find((o) => o.id === leadRole.id);
    assert(!leadOw || !leadOw.allow?.includes(PermissionFlagsBits.ViewChannel), 'Campus Lead must NOT be allowed');

    const fOw = catOverwrites.find((o) => o.id === founderRole.id);
    assert(!fOw || !fOw.allow?.includes(PermissionFlagsBits.ViewChannel), 'Founder must NOT be allowed');

    const aOw = catOverwrites.find((o) => o.id === adminRole.id);
    assert(!aOw || !aOw.allow?.includes(PermissionFlagsBits.ViewChannel), 'HQ Admin must NOT be allowed');
  });

  await test('Auto-assign member tag: user receives cluster member tag immediately when added to cluster in OS', async () => {
    resetMockDb();
    const { client, guild } = createMockClient();
    mockDb.guild_config.push({
      guild_id: guild.id,
      guild_type: 'chapter',
      chapter_id: 'chapter_test',
    });

    const clusterId = 'cluster_auto_assign_1';
    const cluster = {
      id: clusterId,
      name: 'Game Dev',
      chapter_id: 'chapter_test',
      access_mode: 'invite',
      member_ids: [],
    };
    mockDb.clusters.push(cluster);

    await clusterSync.handleClusterCreated(client, cluster);
    const memberRole = guild.roles.cache.find((r) => r.name.toLowerCase() === 'game dev member');

    const userOsId = 'user_os_join_1';
    const userDiscordId = '123456789012345678';
    mockDb.profiles.push({
      id: userOsId,
      discord_user_id: userDiscordId,
      discord_connected: true,
    });
    const guildMember = addMockMember(guild, userDiscordId, 'Gamer#0001');

    // 1. Added via cluster_members with member_id alias
    await clusterSync.handleMemberAdded(client, {
      cluster_id: clusterId,
      member_id: userOsId,
      role: 'member',
    });

    assert(guildMember.roles.cache.has(memberRole.id), 'User must automatically receive member role tag when added to cluster in OS');

    // 2. Added via handleUserLinked for pre-existing cluster membership
    const unlinkedOsId = 'user_os_prelink_1';
    const unlinkedDiscordId = '876543210987654321';
    const unlinkedMember = addMockMember(guild, unlinkedDiscordId, 'PreLink#0001');

    // Cluster with member already in member_ids
    const cluster2 = {
      id: 'cluster_auto_assign_2',
      name: 'AI Engineering',
      chapter_id: 'chapter_test',
      access_mode: 'invite',
      member_ids: [unlinkedOsId],
    };
    mockDb.clusters.push(cluster2);
    await clusterSync.handleClusterCreated(client, cluster2);
    const cluster2Role = guild.roles.cache.find((r) => r.name.toLowerCase() === 'ai engineering member');

    // User now links account
    await clusterSync.handleUserLinked(client, {
      id: unlinkedOsId,
      discord_user_id: unlinkedDiscordId,
    });

    assert(unlinkedMember.roles.cache.has(cluster2Role.id), 'User must automatically receive cluster role tag for clusters they belong to upon linking');
  });

  console.log(`\n========================================`);
  console.log(`ALL CLUSTER SYNC TESTS PASSED! (${passedTests}/${totalTests} tests)`);
  console.log(`========================================\n`);
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
