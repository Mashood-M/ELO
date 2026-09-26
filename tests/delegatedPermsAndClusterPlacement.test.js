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
  user_roles: [],
  roles: [],
  chapters: [],
  terms: [],
  term_members: [],
};

function resetMockDb() {
  mockDb.clusters = [];
  mockDb.cluster_members = [];
  mockDb.pending_discord_roles = [];
  mockDb.discord_sync_log = [];
  mockDb.discord_links = [];
  mockDb.profiles = [];
  mockDb.guild_config = [];
  mockDb.user_roles = [];
  mockDb.roles = [];
  mockDb.chapters = [];
  mockDb.terms = [];
  mockDb.term_members = [];
  if (api.invalidateGuildConfigCache) api.invalidateGuildConfigCache();
  if (api.invalidateTermMembersCache) api.invalidateTermMembersCache();
}

// Mock Supabase
const supabase = require('../src/lib/supabase');

supabase.from = function (table) {
  if (!mockDb[table]) mockDb[table] = [];
  const currentTable = mockDb[table];
  let filters = [];
  let selectFields = '*';
  let sortFn = null;
  let limitCount = null;

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
    ilike: (col, val) => {
      filters.push((row) => String(row[col] || '').toLowerCase() === String(val || '').toLowerCase());
      return chain;
    },
    in: (col, arr) => {
      filters.push((row) => arr.includes(row[col]));
      return chain;
    },
    order: (col, opts = {}) => {
      sortFn = (a, b) => {
        if (opts.ascending) return a[col] > b[col] ? 1 : -1;
        return a[col] < b[col] ? 1 : -1;
      };
      return chain;
    },
    limit: (n) => {
      limitCount = n;
      return chain;
    },
    maybeSingle: async () => {
      let filtered = currentTable.filter((row) => filters.every((fn) => fn(row)));
      if (sortFn) filtered.sort(sortFn);
      return { data: filtered[0] || null, error: null };
    },
    single: async () => {
      let filtered = currentTable.filter((row) => filters.every((fn) => fn(row)));
      if (sortFn) filtered.sort(sortFn);
      return { data: filtered[0] || null, error: filtered.length ? null : new Error('Row not found') };
    },
    then: (resolve, reject) => {
      let filtered = currentTable.filter((row) => filters.every((fn) => fn(row)));
      if (sortFn) filtered.sort(sortFn);
      if (limitCount !== null) filtered = filtered.slice(0, limitCount);
      return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
    },
  };
  return chain;
};

// Discord Mock Environment Generator
function createMockEnvironment() {
  const mainGuildRoles = new Collection();
  const mainGuildChannels = new Collection();
  const mainGuildMembers = new Collection();

  const chapterGuildRoles = new Collection();
  const chapterGuildChannels = new Collection();
  const chapterGuildMembers = new Collection();

  const me = {
    id: 'bot_user_id',
    user: { id: 'bot_user_id', tag: 'ElevatesBot#0001' },
    permissions: {
      has: () => true,
    },
  };

  const createGuildObj = (guildId, name, rolesCol, channelsCol, membersCol) => {
    const everyoneRole = {
      id: `${guildId}_everyone`,
      name: '@everyone',
      permissions: { has: () => false },
    };
    rolesCol.set(everyoneRole.id, everyoneRole);

    const guildObj = {
      id: guildId,
      name,
      members: {
        me,
        cache: membersCol,
        fetchMe: async () => me,
        fetch: async (id) => (id ? membersCol.get(id) || null : membersCol),
      },
      roles: {
        everyone: everyoneRole,
        cache: rolesCol,
        fetch: async (id) => (id ? rolesCol.get(id) || null : rolesCol),
        create: async (opts) => {
          const id = `role_${opts.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Math.random().toString(36).slice(2, 6)}`;
          const newRole = {
            id,
            name: opts.name,
            color: opts.color,
            mentionable: Boolean(opts.mentionable),
            hoist: Boolean(opts.hoist),
            members: new Collection(),
            editable: true,
          };
          rolesCol.set(id, newRole);
          return newRole;
        },
      },
      channels: {
        cache: channelsCol,
        fetch: async (id) => channelsCol.get(id) || null,
        create: async (opts) => {
          const id = `chan_${opts.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Math.random().toString(36).slice(2, 6)}`;
          const newChan = {
            id,
            name: opts.name,
            type: opts.type,
            parentId: opts.parent || null,
            appliedOverwrites: opts.permissionOverwrites || [],
            permissionOverwrites: {
              cache: new Collection(),
              set: async (overwrites) => {
                newChan.appliedOverwrites = overwrites;
              },
            },
            setName: async (n) => {
              newChan.name = n;
            },
          };
          channelsCol.set(id, newChan);
          return newChan;
        },
      },
    };
    return guildObj;
  };

  const mainGuild = createGuildObj('main_guild_1', 'ELEVATES Main Server', mainGuildRoles, mainGuildChannels, mainGuildMembers);
  const chapterGuild = createGuildObj('chapter_guild_1', 'ELEVATES Beta Chapter', chapterGuildRoles, chapterGuildChannels, chapterGuildMembers);

  const client = {
    user: { id: 'bot_user_id' },
    guilds: {
      cache: new Collection([
        ['main_guild_1', mainGuild],
        ['chapter_guild_1', chapterGuild],
      ]),
      fetch: async (id) => {
        if (id === 'main_guild_1') return mainGuild;
        if (id === 'chapter_guild_1') return chapterGuild;
        return null;
      },
    },
  };

  return { client, mainGuild, chapterGuild, mainGuildRoles, chapterGuildRoles, mainGuildMembers, chapterGuildMembers };
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
    user: { id, tag, username: tag.split('#')[0] },
    displayName: tag.split('#')[0],
    roles: {
      cache: roleCache,
      add: async (roleOrId) => {
        const rId = typeof roleOrId === 'string' ? roleOrId : roleOrId.id;
        const r = guild.roles.cache.get(rId) || roleOrId;
        roleCache.set(rId, r);
        if (r.members) r.members.set(id, member);
        return member;
      },
      remove: async (roleOrId) => {
        const rId = typeof roleOrId === 'string' ? roleOrId : roleOrId.id;
        roleCache.delete(rId);
        const r = guild.roles.cache.get(rId);
        if (r?.members) r.members.delete(id);
        return member;
      },
    },
    manageable: true,
    setNickname: async () => {},
  };

  guild.members.cache.set(id, member);
  return member;
}

// Modules under test
const api = require('../src/lib/api');
const clusterSync = require('../src/lib/clusterSync');
const { canUserExecuteCommand, DELEGATED_PERMISSIONS } = require('../src/lib/permissions');
const config = require('../src/config');

async function runTests() {
  console.log('--- RUNNING DELEGATED PERMISSIONS & CLUSTER PLACEMENT TEST SUITE ---\n');
  let passed = 0;
  let total = 0;

  async function test(name, fn) {
    total++;
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(err);
      process.exit(1);
    }
  }

  // ==========================================================================
  // 1. EXECUTIVE MEMBER ROLE SYNC
  // ==========================================================================
  await test('Executive Member Role Sync: auto-creates "Executive Member" in chapter guild when not existing & assigns role', async () => {
    resetMockDb();
    const env = createMockEnvironment();

    const chapterId = 'chp_test_1';
    mockDb.guild_config.push({
      guild_id: 'chapter_guild_1',
      guild_type: 'chapter',
      chapter_id: chapterId,
    });

    const execUserId = 'os_exec_user_1';
    const execDiscordId = 'discord_exec_1';

    mockDb.profiles.push({
      id: execUserId,
      full_name: 'Exec Alex',
      chapter_id: chapterId,
      discord_user_id: execDiscordId,
      discord_connected: true,
    });

    // user_roles has executive_member
    mockDb.user_roles.push({
      id: 'role_row_1',
      user_id: execUserId,
      role_key: 'executive_member',
      chapter_id: chapterId,
      is_permanent: true, // Note: per schema is_permanent is true, but shouldn't prevent removal
    });

    const member = addMockMember(env.chapterGuild, execDiscordId, 'ExecAlex#0001');

    // Run sync across guilds
    await api.syncUserAcrossGuilds(env.client, execDiscordId, execUserId);

    // Verify "Executive Member" role was auto-created in chapter guild
    const createdRole = env.chapterGuild.roles.cache.find(
      (r) => r.name.toLowerCase() === 'executive member'
    );
    assert(createdRole, 'Executive Member role should have been auto-created in chapter guild');
    assert(member.roles.cache.has(createdRole.id), 'Member should have been assigned Executive Member role');
  });

  await test('Executive Member Role Sync: removes role when deleted from user_roles (even when is_permanent was true)', async () => {
    resetMockDb();
    const env = createMockEnvironment();

    const chapterId = 'chp_test_1';
    mockDb.guild_config.push({
      guild_id: 'chapter_guild_1',
      guild_type: 'chapter',
      chapter_id: chapterId,
    });

    const execUserId = 'os_exec_user_2';
    const execDiscordId = 'discord_exec_2';

    mockDb.profiles.push({
      id: execUserId,
      full_name: 'Exec Sarah',
      chapter_id: chapterId,
      discord_user_id: execDiscordId,
      discord_connected: true,
    });

    // Pre-create Executive Member role
    const execRole = await env.chapterGuild.roles.create({ name: 'Executive Member', color: 0x3B82F6 });
    const member = addMockMember(env.chapterGuild, execDiscordId, 'ExecSarah#0001', [execRole.id]);

    // user_roles is now EMPTY (term ended or row deleted)
    // Run sync with removedRoleKey = 'executive_member'
    await api.syncUserAcrossGuilds(env.client, execDiscordId, execUserId, 'executive_member');

    assert(!member.roles.cache.has(execRole.id), 'Executive Member role should be revoked from member when row is deleted');
  });

  // ==========================================================================
  // 2. PER-PERSON DELEGATED PERMISSIONS
  // ==========================================================================
  await test('Delegated Permissions: executive member authorized only for their specific permissions in active term', async () => {
    resetMockDb();
    const env = createMockEnvironment();

    const chapterId = 'chp_perms_1';
    mockDb.guild_config.push({
      guild_id: 'chapter_guild_1',
      guild_type: 'chapter',
      chapter_id: chapterId,
    });

    // Active term
    const activeTermId = 'term_active_1';
    mockDb.terms.push({
      id: activeTermId,
      chapter_id: chapterId,
      status: 'active',
      created_at: new Date().toISOString(),
    });

    // Executive Member 1: delegated ['kick', 'warn']
    const user1Id = 'user_exec_mod_1';
    const discord1Id = 'discord_exec_mod_1';
    mockDb.profiles.push({
      id: user1Id,
      chapter_id: chapterId,
      discord_user_id: discord1Id,
      discord_connected: true,
    });
    mockDb.user_roles.push({
      user_id: user1Id,
      role_key: 'executive_member',
      chapter_id: chapterId,
    });
    mockDb.term_members.push({
      term_id: activeTermId,
      user_id: user1Id,
      permissions: ['kick', 'warn'],
    });

    // Executive Member 2: delegated ['ban', 'unban']
    const user2Id = 'user_exec_mod_2';
    const discord2Id = 'discord_exec_mod_2';
    mockDb.profiles.push({
      id: user2Id,
      chapter_id: chapterId,
      discord_user_id: discord2Id,
      discord_connected: true,
    });
    mockDb.user_roles.push({
      user_id: user2Id,
      role_key: 'executive_member',
      chapter_id: chapterId,
    });
    mockDb.term_members.push({
      term_id: activeTermId,
      user_id: user2Id,
      permissions: ['ban', 'unban'],
    });

    // Invalidate cache to ensure fresh lookup
    api.invalidateTermMembersCache();

    // Check Member 1 (/kick and /warn should pass, /ban should fail)
    const kickCheck1 = await canUserExecuteCommand(discord1Id, 'chapter_guild_1', 'kick');
    assert.strictEqual(kickCheck1.allowed, true, 'User 1 should be allowed to /kick');

    const warnCheck1 = await canUserExecuteCommand(discord1Id, 'chapter_guild_1', 'warn');
    assert.strictEqual(warnCheck1.allowed, true, 'User 1 should be allowed to /warn');

    const banCheck1 = await canUserExecuteCommand(discord1Id, 'chapter_guild_1', 'ban');
    assert.strictEqual(banCheck1.allowed, false, 'User 1 should NOT be allowed to /ban');
    assert(banCheck1.reason.includes('ban'), 'Reason should mention missing delegated ban permission');

    // Check Member 2 (/ban should pass, /kick should fail)
    const banCheck2 = await canUserExecuteCommand(discord2Id, 'chapter_guild_1', 'ban');
    assert.strictEqual(banCheck2.allowed, true, 'User 2 should be allowed to /ban');

    const kickCheck2 = await canUserExecuteCommand(discord2Id, 'chapter_guild_1', 'kick');
    assert.strictEqual(kickCheck2.allowed, false, 'User 2 should NOT be allowed to /kick');
  });

  await test('Delegated Permissions: Campus Lead retains full access regardless of term_members array', async () => {
    resetMockDb();
    const env = createMockEnvironment();

    const chapterId = 'chp_lead_1';
    mockDb.guild_config.push({
      guild_id: 'chapter_guild_1',
      guild_type: 'chapter',
      chapter_id: chapterId,
    });

    const leadUserId = 'user_lead_1';
    const leadDiscordId = 'discord_lead_1';
    mockDb.profiles.push({
      id: leadUserId,
      chapter_id: chapterId,
      discord_user_id: leadDiscordId,
      discord_connected: true,
    });
    mockDb.user_roles.push({
      user_id: leadUserId,
      role_key: 'campus_lead',
      chapter_id: chapterId,
    });

    // Even if term_members permissions is empty for the active term
    mockDb.terms.push({ id: 'term_lead_1', chapter_id: chapterId, status: 'active' });
    mockDb.term_members.push({ term_id: 'term_lead_1', user_id: leadUserId, permissions: [] });

    // Campus Lead must still have full access to ban, kick, unlink, etc.
    const banCheck = await canUserExecuteCommand(leadDiscordId, 'chapter_guild_1', 'ban');
    assert.strictEqual(banCheck.allowed, true, 'Campus Lead retains full access to /ban');

    const kickCheck = await canUserExecuteCommand(leadDiscordId, 'chapter_guild_1', 'kick');
    assert.strictEqual(kickCheck.allowed, true, 'Campus Lead retains full access to /kick');

    const unlinkCheck = await canUserExecuteCommand(leadDiscordId, 'chapter_guild_1', 'unlink');
    assert.strictEqual(unlinkCheck.allowed, true, 'Campus Lead retains full access to /unlink');
  });

  // ==========================================================================
  // 3. CLUSTER PLACEMENT BY access_mode
  // ==========================================================================
  await test('Cluster Placement: access_mode = "open" creates presence in MAIN server', async () => {
    resetMockDb();
    const env = createMockEnvironment();

    // Configure main guild and chapter guild
    mockDb.guild_config.push({
      guild_id: 'main_guild_1',
      guild_type: 'main',
    });
    mockDb.guild_config.push({
      guild_id: 'chapter_guild_1',
      guild_type: 'chapter',
      chapter_id: 'chp_open_1',
    });

    const openCluster = {
      id: 'cluster_open_1',
      name: 'Artificial Intelligence',
      chapter_id: 'chp_open_1',
      access_mode: 'open',
    };
    mockDb.clusters.push(openCluster);

    // Create cluster presence
    const result = await clusterSync.handleClusterCreated(env.client, openCluster);
    assert(result, 'Creation should succeed for open cluster');

    // Role, category, and channels must be created in MAIN guild
    const mainRole = env.mainGuild.roles.cache.find((r) => r.name.toLowerCase() === 'artificial intelligence member');
    assert(mainRole, 'Member role should be created in Main Server');

    const mainCategory = env.mainGuild.channels.cache.find((c) => c.name.includes('ARTIFICIAL INTELLIGENCE'));
    assert(mainCategory, 'Category should be created in Main Server');

    // Verify clusters record updated with main guild IDs
    assert.strictEqual(openCluster.discord_role_id, mainRole.id);
    assert.strictEqual(openCluster.discord_category_id, mainCategory.id);

    // Verify nothing created in chapter guild
    const chapterRole = env.chapterGuild.roles.cache.find((r) => r.name.toLowerCase() === 'artificial intelligence member');
    assert(!chapterRole, 'No cluster role should be created in Chapter Server for open cluster');
  });

  await test('Cluster Placement: access_mode = "invite" creates presence in CHAPTER server', async () => {
    resetMockDb();
    const env = createMockEnvironment();

    mockDb.guild_config.push({
      guild_id: 'main_guild_1',
      guild_type: 'main',
    });
    mockDb.guild_config.push({
      guild_id: 'chapter_guild_1',
      guild_type: 'chapter',
      chapter_id: 'chp_invite_1',
    });

    const inviteCluster = {
      id: 'cluster_invite_1',
      name: 'Cyber Security',
      chapter_id: 'chp_invite_1',
      access_mode: 'invite',
    };
    mockDb.clusters.push(inviteCluster);

    const result = await clusterSync.handleClusterCreated(env.client, inviteCluster);
    assert(result, 'Creation should succeed for invite cluster');

    // Role, category, and channels must be created in CHAPTER guild
    const chapterRole = env.chapterGuild.roles.cache.find((r) => r.name.toLowerCase() === 'cyber security member');
    assert(chapterRole, 'Member role should be created in Chapter Server');

    const chapterCategory = env.chapterGuild.channels.cache.find((c) => c.name.includes('CYBER SECURITY'));
    assert(chapterCategory, 'Category should be created in Chapter Server');

    // Verify nothing created in main guild
    const mainRole = env.mainGuild.roles.cache.find((r) => r.name.toLowerCase() === 'cyber security member');
    assert(!mainRole, 'No cluster role should be created in Main Server for invite cluster');
  });

  // ==========================================================================
  // 4. MEMBERSHIP SYNC VIA ARRAY DIFFING
  // ==========================================================================
  await test('Membership Sync: member_ids array diffing grants role on addition & revokes on removal', async () => {
    resetMockDb();
    const env = createMockEnvironment();

    const chapterId = 'chp_array_diff_1';
    mockDb.guild_config.push({
      guild_id: 'chapter_guild_1',
      guild_type: 'chapter',
      chapter_id: chapterId,
    });

    // Create role in chapter guild
    const memberRole = await env.chapterGuild.roles.create({ name: 'Web Dev Member' });

    const clusterId = 'cluster_array_1';
    const cluster = {
      id: clusterId,
      name: 'Web Dev',
      chapter_id: chapterId,
      access_mode: 'invite',
      discord_role_id: memberRole.id,
      member_ids: [],
    };
    mockDb.clusters.push(cluster);

    const user1 = 'user_array_1';
    const discord1 = 'discord_array_1';
    mockDb.profiles.push({ id: user1, discord_user_id: discord1, discord_connected: true });
    const member1 = addMockMember(env.chapterGuild, discord1, 'DevUser1#0001');

    // Simulate addition via handleMemberAdded
    await clusterSync.handleMemberAdded(env.client, { cluster_id: clusterId, user_id: user1, role_in_cluster: 'member' });
    assert(member1.roles.cache.has(memberRole.id), 'Member 1 should receive cluster role upon addition');

    // Simulate removal via handleMemberRemoved
    await clusterSync.handleMemberRemoved(env.client, { cluster_id: clusterId, user_id: user1 });
    assert(!member1.roles.cache.has(memberRole.id), 'Member 1 should have cluster role revoked upon removal');
  });

  await test('Membership Sync: reconcileClusterMembers reads cluster.member_ids directly', async () => {
    resetMockDb();
    const env = createMockEnvironment();

    const chapterId = 'chp_reconcile_1';
    mockDb.guild_config.push({
      guild_id: 'chapter_guild_1',
      guild_type: 'chapter',
      chapter_id: chapterId,
    });

    const memberRole = await env.chapterGuild.roles.create({ name: 'Data Science Member' });

    const userInArray = 'user_in_array';
    const discordInArray = 'discord_in_array';
    mockDb.profiles.push({ id: userInArray, discord_user_id: discordInArray, discord_connected: true });
    const memberInArray = addMockMember(env.chapterGuild, discordInArray, 'DataScientist#0001'); // doesn't have role yet

    const userExcess = 'user_excess';
    const discordExcess = 'discord_excess';
    mockDb.profiles.push({ id: userExcess, discord_user_id: discordExcess, discord_connected: true });
    const memberExcess = addMockMember(env.chapterGuild, discordExcess, 'ExcessUser#0001', [memberRole.id]); // has role but not in member_ids

    const clusterId = 'cluster_ds_1';
    const cluster = {
      id: clusterId,
      name: 'Data Science',
      chapter_id: chapterId,
      access_mode: 'invite',
      discord_role_id: memberRole.id,
      member_ids: [userInArray], // userInArray is in member_ids UUID[]
    };
    mockDb.clusters.push(cluster);

    const result = await clusterSync.reconcileClusterMembers(env.client, clusterId);
    assert(result, 'Reconciliation should succeed');
    assert(result.granted.includes(discordInArray), 'User in member_ids should have missing role granted');
    assert(result.revoked.includes(discordExcess), 'Excess user should have role revoked');

    assert(memberInArray.roles.cache.has(memberRole.id), 'User in member_ids now has role');
    assert(!memberExcess.roles.cache.has(memberRole.id), 'Excess user no longer has role');
  });

  console.log(`\n========================================`);
  console.log(`ALL DELEGATED PERMS & CLUSTER PLACEMENT TESTS PASSED! (${passed}/${total} tests)`);
  console.log(`========================================\n`);
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
