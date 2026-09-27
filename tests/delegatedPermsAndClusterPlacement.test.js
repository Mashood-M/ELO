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
  if (typeof clusterSync !== 'undefined' && typeof clusterSync.clearClusterCaches === 'function') {
    clusterSync.clearClusterCaches();
  }
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

  const botRole = {
    id: 'role_bot',
    name: 'Elevates Bot',
    position: 50,
  };
  const me = {
    id: 'bot_user_id',
    user: { id: 'bot_user_id', tag: 'ElevatesBot#0001' },
    permissions: {
      has: () => true,
    },
    roles: {
      highest: botRole,
      cache: new Collection([['role_bot', botRole]]),
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
            position: opts.position !== undefined ? opts.position : 1,
          };
          rolesCol.set(id, newRole);
          return newRole;
        },
      },
      channels: {
        cache: channelsCol,
        fetch: async (id) => (id ? channelsCol.get(id) || null : channelsCol),
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
            messages: {
              fetch: async () => new Collection(),
            },
            send: async (msg) => {
              newChan.sentMessages = newChan.sentMessages || [];
              newChan.sentMessages.push(msg);
              return msg;
            },
            lockPermissions: async () => {
              newChan.permissionsLocked = true;
            },
            delete: async () => {
              channelsCol.delete(id);
              return newChan;
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

  // Seed standard main roles
  const standardRoles = ['Verified Member', 'Founder', 'HQ Admin', 'Executive Member'];
  for (const rName of standardRoles) {
    const id = `role_${rName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
    mainGuildRoles.set(id, {
      id,
      name: rName,
      members: new Collection(),
    });
  }

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
        if (guild.members.me?.roles?.highest?.position !== undefined && r?.position !== undefined) {
          if (guild.members.me.roles.highest.position <= r.position) {
            const err = new Error('Missing Permissions: Bot role is below or equal to target role in hierarchy');
            err.code = 50013;
            throw err;
          }
        }
        roleCache.set(rId, r);
        if (r?.members) r.members.set(id, member);
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

    // Verify open cluster category permissions are strictly private (same as invite-only):
    // @everyone: DENIED ViewChannel
    // Verified Member: DENIED ViewChannel
    // Cluster Member: ALLOWED ViewChannel
    const verifiedRole = env.mainGuild.roles.cache.find((r) => r.name === 'Verified Member');
    const hasVerifiedDeny = mainCategory.appliedOverwrites.some(
      (ow) => ow.id === verifiedRole.id && ow.deny && ow.deny.includes(PermissionFlagsBits.ViewChannel)
    );
    assert(hasVerifiedDeny, 'Open cluster category must explicitly DENY ViewChannel for Verified Member');

    const hasMemberAllow = mainCategory.appliedOverwrites.some(
      (ow) => ow.id === mainRole.id && ow.allow && ow.allow.includes(PermissionFlagsBits.ViewChannel)
    );
    assert(hasMemberAllow, 'Open cluster category must allow ViewChannel for cluster member role');

    // Verify nothing created in chapter guild
    const chapterRole = env.chapterGuild.roles.cache.find((r) => r.name.toLowerCase() === 'artificial intelligence member');
    assert(!chapterRole, 'No cluster role should be created in Chapter Server for open cluster');
  });

  await test('Open Cluster: created by admin or founder in OS shows in Main Server with strictly private overwrites', async () => {
    resetMockDb();
    const env = createMockEnvironment();

    mockDb.guild_config.push({
      guild_id: 'main_guild_1',
      guild_type: 'main',
    });

    const adminUserId = 'user_admin_creator_1';
    const adminDiscordId = 'discord_admin_creator_1';
    mockDb.profiles.push({
      id: adminUserId,
      role: 'founder',
      discord_user_id: adminDiscordId,
      discord_connected: true,
    });
    addMockMember(env.mainGuild, adminDiscordId, 'AdminFounder#0001');

    const openCluster = {
      id: 'cluster_open_admin_1',
      name: 'Open Source Development',
      created_by: adminUserId,
      chapter_id: null, // Created by admin in OS without chapter scoping
      access_mode: 'open',
    };
    mockDb.clusters.push(openCluster);

    // Sync cluster
    await clusterSync.syncCluster(env.client, openCluster.id);

    const mainCategory = env.mainGuild.channels.cache.find((c) => c.name.includes('OPEN SOURCE DEVELOPMENT'));
    assert(mainCategory, 'Category should be created in Main Server for admin-created open cluster');

    // Verify category denies Verified Member and allows only Cluster Member / Host
    const verifiedRole = env.mainGuild.roles.cache.find((r) => r.name === 'Verified Member');
    const memberRole = env.mainGuild.roles.cache.find((r) => r.name.toLowerCase() === 'open source development member');
    const hostRole = env.mainGuild.roles.cache.find((r) => r.name.toLowerCase() === 'open source development host');

    const verifiedDeny = mainCategory.appliedOverwrites.find((ow) => ow.id === verifiedRole.id && ow.deny?.includes(PermissionFlagsBits.ViewChannel));
    assert(verifiedDeny, 'Verified Member must be denied ViewChannel');

    const memberAllow = mainCategory.appliedOverwrites.find((ow) => ow.id === memberRole.id && ow.allow?.includes(PermissionFlagsBits.ViewChannel));
    assert(memberAllow, 'Cluster Member role must be allowed ViewChannel');

    const hostAllow = mainCategory.appliedOverwrites.find((ow) => ow.id === hostRole.id && ow.allow?.includes(PermissionFlagsBits.ViewChannel));
    assert(hostAllow, 'Cluster Host role must be allowed ViewChannel');

    // Verify creator was assigned host role
    assert(hostRole, 'Host role created for admin creator');
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

  await test('Invite Cluster: created by HQ or Admin creates strictly private category in MAIN server', async () => {
    resetMockDb();
    const env = createMockEnvironment();

    mockDb.guild_config.push({
      guild_id: 'main_guild_1',
      guild_type: 'main',
    });
    mockDb.guild_config.push({
      guild_id: 'chapter_guild_1',
      guild_type: 'chapter',
      chapter_id: 'chp_some_chapter',
    });

    const hqUserId = 'user_hq_founder_1';
    const hqDiscordId = 'discord_hq_founder_1';
    mockDb.profiles.push({
      id: hqUserId,
      role: 'founder',
      discord_user_id: hqDiscordId,
      discord_connected: true,
    });
    addMockMember(env.mainGuild, hqDiscordId, 'FounderUser#0001');

    const inviteHqCluster = {
      id: 'cluster_invite_hq_1',
      name: 'HQ Private Ops',
      created_by: hqUserId,
      chapter_id: null,
      access_mode: 'invite',
    };
    mockDb.clusters.push(inviteHqCluster);

    // Verify isClusterOpen is false for invite-only cluster
    const isOpen = await clusterSync.isClusterOpen(inviteHqCluster);
    assert.strictEqual(isOpen, false, 'Invite cluster must NOT be marked open even if created by founder/HQ');

    // Verify target guild is Main Server
    const targetGuild = await clusterSync.getClusterGuild(env.client, inviteHqCluster);
    assert.strictEqual(targetGuild?.id, env.mainGuild.id, 'HQ invite cluster must route to Main Server');

    const result = await clusterSync.handleClusterCreated(env.client, inviteHqCluster);
    assert(result, 'Creation should succeed for HQ invite cluster');

    // Category and role created in Main Server
    const mainRole = env.mainGuild.roles.cache.find((r) => r.name.toLowerCase() === 'hq private ops member');
    assert(mainRole, 'Member role should be created in Main Server');

    const mainCategory = env.mainGuild.channels.cache.find((c) => c.name.includes('HQ PRIVATE OPS'));
    assert(mainCategory, 'Category should be created in Main Server');

    // Verify privacy overwrites on Main Server:
    const everyoneRole = env.mainGuild.roles.everyone;
    const verifiedRole = env.mainGuild.roles.cache.find((r) => r.name === 'Verified Member');
    const founderRole = env.mainGuild.roles.cache.find((r) => r.name === 'Founder');
    const adminRole = env.mainGuild.roles.cache.find((r) => r.name === 'HQ Admin');

    // 1. @everyone: DENIED ViewChannel
    const everyoneDeny = mainCategory.appliedOverwrites.find((ow) => ow.id === everyoneRole.id && ow.deny?.includes(PermissionFlagsBits.ViewChannel));
    assert(everyoneDeny, '@everyone must be explicitly DENIED ViewChannel');

    // 2. Verified Member: DENIED ViewChannel
    const verifiedDeny = mainCategory.appliedOverwrites.find((ow) => ow.id === verifiedRole.id && ow.deny?.includes(PermissionFlagsBits.ViewChannel));
    assert(verifiedDeny, 'Verified Member must be explicitly DENIED ViewChannel in HQ private cluster');

    // 3. Cluster Member: ALLOWED ViewChannel
    const memberAllow = mainCategory.appliedOverwrites.find((ow) => ow.id === mainRole.id && ow.allow?.includes(PermissionFlagsBits.ViewChannel));
    assert(memberAllow, 'Cluster Member role must be ALLOWED ViewChannel');

    // 4. Founder / HQ Admin: MUST NOT have blanket ViewChannel (only cluster member/host tags)
    const founderAllow = mainCategory.appliedOverwrites.find((ow) => ow.id === founderRole.id && ow.allow?.includes(PermissionFlagsBits.ViewChannel));
    assert(!founderAllow, 'Founder must NOT have blanket ViewChannel on private cluster');

    const adminAllow = mainCategory.appliedOverwrites.find((ow) => ow.id === adminRole.id && ow.allow?.includes(PermissionFlagsBits.ViewChannel));
    assert(!adminAllow, 'HQ Admin must NOT have blanket ViewChannel on private cluster');

    // 5. Campus Lead overwrite should NOT exist on Main Server
    const campusLeadOverwrite = mainCategory.appliedOverwrites.find((ow) => ow.id === 'role_campus_lead');
    assert(!campusLeadOverwrite, 'Campus Lead overwrite must NOT exist on Main Server cluster category');

    // Verify nothing created in Chapter Server
    const chapterRole = env.chapterGuild.roles.cache.find((r) => r.name.toLowerCase() === 'hq private ops member');
    assert(!chapterRole, 'Nothing should be created in Chapter Server');
  });

  await test('Invite Cluster: created by Campus Lead in chapter creates private category in CHAPTER server', async () => {
    resetMockDb();
    const env = createMockEnvironment();

    const chapterId = 'chp_lead_test_1';
    mockDb.guild_config.push({
      guild_id: 'main_guild_1',
      guild_type: 'main',
    });
    mockDb.guild_config.push({
      guild_id: 'chapter_guild_1',
      guild_type: 'chapter',
      chapter_id: chapterId,
    });

    // Seed chapter roles
    const leadRoleId = 'role_campus_lead_chp';
    const campusLeadRole = { id: leadRoleId, name: 'Campus Lead', members: new Collection() };
    env.chapterGuild.roles.cache.set(leadRoleId, campusLeadRole);

    const verifiedRoleId = 'role_verified_chp';
    const verifiedRole = { id: verifiedRoleId, name: 'Verified Member', members: new Collection() };
    env.chapterGuild.roles.cache.set(verifiedRoleId, verifiedRole);

    const leadUserId = 'user_lead_creator_1';
    const leadDiscordId = 'discord_lead_creator_1';
    mockDb.profiles.push({
      id: leadUserId,
      role: 'campus_lead',
      chapter_id: chapterId,
      discord_user_id: leadDiscordId,
      discord_connected: true,
    });
    addMockMember(env.chapterGuild, leadDiscordId, 'CampusLead#0001', [leadRoleId]);

    const inviteLeadCluster = {
      id: 'cluster_invite_lead_1',
      name: 'Robotics Workshop',
      created_by: leadUserId,
      chapter_id: chapterId,
      access_mode: 'invite',
    };
    mockDb.clusters.push(inviteLeadCluster);

    // Verify isClusterOpen is false
    const isOpen = await clusterSync.isClusterOpen(inviteLeadCluster);
    assert.strictEqual(isOpen, false, 'Invite cluster must NOT be marked open');

    // Verify target guild is Chapter Server
    const targetGuild = await clusterSync.getClusterGuild(env.client, inviteLeadCluster);
    assert.strictEqual(targetGuild?.id, env.chapterGuild.id, 'Campus Lead invite cluster must route to Chapter Server');

    const result = await clusterSync.handleClusterCreated(env.client, inviteLeadCluster);
    assert(result, 'Creation should succeed for Campus Lead invite cluster');

    // Category and role created in Chapter Server
    const chapterRole = env.chapterGuild.roles.cache.find((r) => r.name.toLowerCase() === 'robotics workshop member');
    assert(chapterRole, 'Member role should be created in Chapter Server');

    const chapterCategory = env.chapterGuild.channels.cache.find((c) => c.name.includes('ROBOTICS WORKSHOP'));
    assert(chapterCategory, 'Category should be created in Chapter Server');

    // Check permissions on chapter category:
    // 1. @everyone: DENIED ViewChannel
    const everyoneDeny = chapterCategory.appliedOverwrites.find((ow) => ow.id === env.chapterGuild.roles.everyone.id && ow.deny?.includes(PermissionFlagsBits.ViewChannel));
    assert(everyoneDeny, '@everyone must be explicitly DENIED ViewChannel');

    // 2. Verified Member: DENIED ViewChannel
    const verifiedDeny = chapterCategory.appliedOverwrites.find((ow) => ow.id === verifiedRoleId && ow.deny?.includes(PermissionFlagsBits.ViewChannel));
    assert(verifiedDeny, 'Verified Member must be explicitly DENIED ViewChannel in Chapter Server');

    // 3. Cluster Member: ALLOWED ViewChannel
    const memberAllow = chapterCategory.appliedOverwrites.find((ow) => ow.id === chapterRole.id && ow.allow?.includes(PermissionFlagsBits.ViewChannel));
    assert(memberAllow, 'Cluster Member role must be ALLOWED ViewChannel');

    // 4. Campus Lead: MUST NOT have blanket ViewChannel (only cluster members/hosts)
    const leadAllow = chapterCategory.appliedOverwrites.find((ow) => ow.id === leadRoleId && ow.allow?.includes(PermissionFlagsBits.ViewChannel));
    assert(!leadAllow, 'Campus Lead must NOT have blanket ViewChannel in Chapter Server cluster category');

    // Verify nothing created in Main Server
    const mainRole = env.mainGuild.roles.cache.find((r) => r.name.toLowerCase() === 'robotics workshop member');
    assert(!mainRole, 'Nothing should be created in Main Server');
  });

  await test('Invite Cluster: created by Executive Member without explicit cluster chapter_id routes to their CHAPTER server', async () => {
    resetMockDb();
    const env = createMockEnvironment();

    const chapterId = 'chp_exec_test_1';
    mockDb.guild_config.push({
      guild_id: 'main_guild_1',
      guild_type: 'main',
    });
    mockDb.guild_config.push({
      guild_id: 'chapter_guild_1',
      guild_type: 'chapter',
      chapter_id: chapterId,
    });

    const execUserId = 'user_exec_creator_1';
    const execDiscordId = 'discord_exec_creator_1';
    mockDb.profiles.push({
      id: execUserId,
      role: 'student',
      chapter_id: chapterId,
      discord_user_id: execDiscordId,
      discord_connected: true,
    });
    mockDb.user_roles.push({
      user_id: execUserId,
      role_key: 'executive_member',
      chapter_id: chapterId,
    });
    addMockMember(env.chapterGuild, execDiscordId, 'ExecLead#0001');

    // Cluster created by Executive Member, but chapter_id is NOT populated on cluster record
    const inviteExecCluster = {
      id: 'cluster_invite_exec_1',
      name: 'Mobile App Dev',
      created_by: execUserId,
      chapter_id: null,
      access_mode: 'invite',
    };
    mockDb.clusters.push(inviteExecCluster);

    // Verify isClusterOpen is false
    const isOpen = await clusterSync.isClusterOpen(inviteExecCluster);
    assert.strictEqual(isOpen, false, 'Invite cluster must NOT be open');

    // Verify target guild resolves to Executive Member\'s Chapter Server
    const targetGuild = await clusterSync.getClusterGuild(env.client, inviteExecCluster);
    assert.strictEqual(targetGuild?.id, env.chapterGuild.id, 'Cluster created by Executive Member without chapter_id must route to their Chapter Server');

    const result = await clusterSync.handleClusterCreated(env.client, inviteExecCluster);
    assert(result, 'Creation should succeed for Executive Member cluster');

    // Category and role created in Chapter Server
    const chapterRole = env.chapterGuild.roles.cache.find((r) => r.name.toLowerCase() === 'mobile app dev member');
    assert(chapterRole, 'Member role should be created in Chapter Server');

    const chapterCategory = env.chapterGuild.channels.cache.find((c) => c.name.includes('MOBILE APP DEV'));
    assert(chapterCategory, 'Category should be created in Chapter Server');

    // Verify nothing created in Main Server
    const mainRole = env.mainGuild.roles.cache.find((r) => r.name.toLowerCase() === 'mobile app dev member');
    assert(!mainRole, 'Nothing should be created in Main Server');
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
    assert(memberInArray.roles.cache.has(memberRole.id), 'User in member_ids now has role');
    assert(!memberExcess.roles.cache.has(memberRole.id), 'Excess user no longer has role');
  });

  // ==========================================================================
  // 5. DIAGNOSTIC LOGGING, FAIL LOUDLY & IDEMPOTENCY FIXES
  // ==========================================================================
  await test('Cluster Placement: invite cluster in chapter WITHOUT registered chapter guild fails loudly and does NOT touch Main server', async () => {
    resetMockDb();
    const env = createMockEnvironment();

    // Only main guild is in guild_config; chapter 'chp_unregistered_999' has NO guild
    mockDb.guild_config.push({
      guild_id: 'main_guild_1',
      guild_type: 'main',
    });

    const unregisteredCluster = {
      id: 'cluster_invite_unregistered_1',
      name: 'Secret Quantum Lab',
      chapter_id: 'chp_unregistered_999',
      access_mode: 'invite',
    };
    mockDb.clusters.push(unregisteredCluster);

    // 1. Target guild lookup must return null (not fall back to main server)
    const targetGuild = await clusterSync.getClusterGuild(env.client, unregisteredCluster);
    assert.strictEqual(targetGuild, null, 'Must return null when chapter guild is missing for invite cluster');

    // 2. handleClusterCreated must fail and return null
    const result = await clusterSync.handleClusterCreated(env.client, unregisteredCluster);
    assert.strictEqual(result, null, 'Creation must return null and fail loudly');

    // 3. Main server must NOT have been touched
    const mainRole = env.mainGuild.roles.cache.find((r) => r.name.toLowerCase().includes('secret quantum lab'));
    assert(!mainRole, 'Main server must NOT receive role for unregistered chapter invite cluster');

    const mainCategory = env.mainGuild.channels.cache.find((c) => c.name.toLowerCase().includes('secret quantum lab'));
    assert(!mainCategory, 'Main server must NOT receive category for unregistered chapter invite cluster');

    // 4. Cluster record must still have null discord_category_id
    const dbCluster = mockDb.clusters.find((c) => c.id === unregisteredCluster.id);
    assert.strictEqual(dbCluster.discord_category_id, undefined, 'Cluster discord_category_id must remain unset');
  });

  await test('Cluster Placement & Idempotency: invite cluster in chapter WITH registered guild creates once and skips duplicate creation', async () => {
    resetMockDb();
    const env = createMockEnvironment();

    const chapterId = 'chp_registered_100';
    mockDb.guild_config.push({
      guild_id: 'main_guild_1',
      guild_type: 'main',
    });
    mockDb.guild_config.push({
      guild_id: 'chapter_guild_1',
      guild_type: 'chapter',
      chapter_id: chapterId,
    });

    const inviteCluster = {
      id: 'cluster_invite_registered_1',
      name: 'Mobile Dev Lab',
      chapter_id: chapterId,
      access_mode: 'invite',
    };
    mockDb.clusters.push(inviteCluster);

    // First call: initial creation
    const firstResult = await clusterSync.handleClusterCreated(env.client, inviteCluster);
    assert(firstResult, 'Initial creation must succeed');

    const createdCategory = env.chapterGuild.channels.cache.find((c) => c.name.includes('MOBILE DEV LAB'));
    assert(createdCategory, 'Category should be created in Chapter Server');

    const dbCluster = mockDb.clusters.find((c) => c.id === inviteCluster.id);
    assert.strictEqual(dbCluster.discord_category_id, createdCategory.id, 'discord_category_id should be written back early to DB');

    const initialChannelCount = env.chapterGuild.channels.cache.size;

    // Second call: duplicate event / reconciliation pass with the same cluster
    const secondResult = await clusterSync.handleClusterCreated(env.client, dbCluster);
    assert.strictEqual(secondResult?.skipped, true, 'Duplicate creation should be skipped with skipped: true');

    const afterSecondChannelCount = env.chapterGuild.channels.cache.size;
    assert.strictEqual(afterSecondChannelCount, initialChannelCount, 'Channel count must not increase on duplicate creation call');

    const categoriesWithSameName = env.chapterGuild.channels.cache.filter((c) => c.name.includes('MOBILE DEV LAB'));
    assert.strictEqual(categoriesWithSameName.size, 1, 'Only exactly 1 category should exist with no duplicates');
  });

  await test('Chapter Role Sync: two-condition verification, exact role search, and role hierarchy error surface', async () => {
    resetMockDb();
    const env = createMockEnvironment();

    const chapterId = 'chp_role_test_1';
    mockDb.guild_config.push({
      guild_id: 'chapter_guild_1',
      guild_type: 'chapter',
      chapter_id: chapterId,
    });

    const leadUserId = 'user_chp_lead_h1';
    const leadDiscordId = 'discord_chp_lead_h1';

    // Condition 1: connected = true
    // Condition 2: chapter matches guild's chapter
    mockDb.profiles.push({
      id: leadUserId,
      full_name: 'Lead Hero',
      chapter_id: chapterId,
      discord_user_id: leadDiscordId,
      discord_connected: true,
    });

    // OS user_roles has Campus Lead and Executive Member
    mockDb.user_roles.push({
      id: 'role_row_lead',
      user_id: leadUserId,
      role_key: 'campus_lead',
      chapter_id: chapterId,
    });
    mockDb.user_roles.push({
      id: 'role_row_exec',
      user_id: leadUserId,
      role_key: 'executive_member',
      chapter_id: chapterId,
    });

    // In chapter guild:
    // "Campus Lead" role is created with position: 20 (bot is at position: 50 -> manageable)
    const leadRole = await env.chapterGuild.roles.create({ name: 'Campus Lead', position: 20 });
    // "Executive Member" role is created with position: 90 (bot is at position: 50 -> hierarchy error!)
    const execRole = await env.chapterGuild.roles.create({ name: 'Executive Member', position: 90 });

    const member = addMockMember(env.chapterGuild, leadDiscordId, 'LeadHero#0001');

    // Run sync across guilds
    await api.syncUserAcrossGuilds(env.client, leadDiscordId, leadUserId);

    // 1. Campus Lead (position 20 < 50) was successfully assigned
    assert(member.roles.cache.has(leadRole.id), 'Campus Lead role should be assigned');

    // 2. Executive Member (position 90 > 50) was blocked due to role hierarchy and surfaced cleanly
    assert(!member.roles.cache.has(execRole.id), 'Executive Member role should NOT be assigned due to bot hierarchy');

    // 3. Test Condition 2 failure: chapter mismatch
    // If profile chapter does not match chapter guild
    mockDb.profiles[0].chapter_id = 'chp_mismatched_chapter';
    await api.syncUserAcrossGuilds(env.client, leadDiscordId, leadUserId);

    // With chapter mismatch, chapter role should be removed
    assert(!member.roles.cache.has(leadRole.id), 'Chapter role should be removed when user chapter no longer matches chapter guild');
  });

  console.log(`\n========================================`);
  console.log(`ALL DELEGATED PERMS & CLUSTER PLACEMENT TESTS PASSED! (${passed}/${total} tests)`);
  console.log(`========================================\n`);
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
