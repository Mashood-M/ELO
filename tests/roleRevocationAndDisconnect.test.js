const assert = require('assert');
const { Collection } = require('discord.js');

const supabase = require('../src/lib/supabase');
const config = require('../src/config');
const api = require('../src/lib/api');
const syncQueue = require('../src/lib/syncQueue');
const unlinkCommand = require('../src/commands/unlink');

syncQueue.minDelayMs = 0;

async function waitForSyncQueue() {
  while (syncQueue.processing || syncQueue.queue.length > 0 || syncQueue.inFlightSet.size > 0) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

// In-memory mock database
const mockDb = {
  profiles: [],
  discord_links: [],
  guild_config: [],
  user_roles: [],
  roles: [],
  chapters: [],
  discord_events_log: [],
};

function resetDb() {
  mockDb.profiles = [];
  mockDb.discord_links = [];
  mockDb.guild_config = [];
  mockDb.user_roles = [];
  mockDb.roles = [];
  mockDb.chapters = [];
  mockDb.discord_events_log = [];
}

supabase.from = function (table) {
  const currentTable = mockDb[table] || [];
  let filters = [];

  const chain = {
    select: () => chain,
    insert: (data) => {
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        currentTable.push({ id: item.id || `mock_${Math.random().toString(36).slice(2, 8)}`, ...item });
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
          mockDb[table] = currentTable.filter((row) => {
            for (const [col, val] of Object.entries(deleteFilters)) {
              if (row[col] !== val) return true;
            }
            return false;
          });
          return Promise.resolve({ data: prevLen - mockDb[table].length, error: null }).then(resolve, reject);
        },
      };
      return delChain;
    },
    eq: (col, val) => {
      filters.push((row) => row[col] === val);
      return chain;
    },
    is: (col, val) => {
      filters.push((row) => (val === null ? row[col] === null || row[col] === undefined : row[col] === val));
      return chain;
    },
    ilike: (col, val) => {
      const cleanVal = String(val).replace(/%/g, '').toLowerCase();
      filters.push((row) => String(row[col] || '').toLowerCase().includes(cleanVal));
      return chain;
    },
    in: (col, vals) => {
      filters.push((row) => vals.includes(row[col]));
      return chain;
    },
    not: (col, op, val) => {
      if (op === 'is' && val === null) {
        filters.push((row) => row[col] !== null && row[col] !== undefined);
      }
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
      return { data: filtered[0] || null, error: filtered.length ? null : new Error('Not found') };
    },
    then: (resolve, reject) => {
      const filtered = currentTable.filter((row) => filters.every((fn) => fn(row)));
      return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
    },
  };
  return chain;
};

let totalTests = 0;
let passedTests = 0;

async function itAsync(name, fn) {
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

function createMockGuild(guildId, guildName, guildType = 'chapter', chapterId = null) {
  const roles = new Collection();
  const members = new Collection();

  const guild = {
    id: guildId,
    name: guildName,
    roles: {
      cache: roles,
      create: async ({ name }) => {
        const r = { id: `role_${Math.random().toString(36).slice(2, 7)}`, name, editable: true };
        roles.set(r.id, r);
        return r;
      },
    },
    members: {
      cache: members,
      fetch: async (id) => members.get(id) || null,
    },
  };

  mockDb.guild_config.push({
    guild_id: guildId,
    guild_type: guildType,
    chapter_id: chapterId,
  });

  return guild;
}

function createMockMember(discordId, tag, initialRoles = []) {
  const memberRoles = new Set(initialRoles.map((r) => r.id));
  const member = {
    id: discordId,
    displayName: tag.split('#')[0],
    user: { tag, username: tag.split('#')[0] },
    manageable: true,
    roles: {
      cache: {
        has: (id) => memberRoles.has(id),
        some: (fn) => Array.from(memberRoles).some((id) => fn({ id, name: id })),
        [Symbol.iterator]: function* () {
          for (const id of memberRoles) yield [id, { id, name: id }];
        },
      },
      add: async (r) => {
        memberRoles.add(r.id);
      },
      remove: async (r) => {
        memberRoles.delete(r.id);
      },
    },
    setNickname: async () => {},
  };
  return { member, memberRoles };
}

async function runTests() {
  console.log('--- RUNNING ROLE REVOCATION & DISCONNECT TEST SUITE ---\n');

  // ==========================================================================
  // TEST 1: Role Revocation on Main Server when OS role is removed
  // ==========================================================================
  await itAsync('Main Server: removes Campus Lead role when revoked in ElevatesOS, preserving Verified Member', async () => {
    resetDb();

    const mainGuild = createMockGuild(config.mainGuildId, "Elevates's server", 'main');
    const verifiedRole = await mainGuild.roles.create({ name: 'Verified Member' });
    const campusLeadRole = await mainGuild.roles.create({ name: 'Campus Lead' });
    const unverifiedRole = await mainGuild.roles.create({ name: 'Unverified' });

    const discordUserId = 'user_cl_1';
    const osUserId = 'prof_cl_1';

    // Member currently holds Verified Member and Campus Lead
    const { member, memberRoles } = createMockMember(discordUserId, 'LeadUser#0001', [verifiedRole, campusLeadRole]);
    mainGuild.members.cache.set(discordUserId, member);

    // Profile in OS is connected, but user_roles no longer has campus_lead (it was deleted)
    mockDb.profiles.push({
      id: osUserId,
      discord_user_id: discordUserId,
      discord_connected: true,
      full_name: 'Lead User',
    });

    const mockClient = {
      guilds: {
        cache: new Collection([[mainGuild.id, mainGuild]]),
      },
    };

    // Run sync passing removedRoleKey = 'campus_lead'
    await api.syncUserAcrossGuilds(mockClient, discordUserId, osUserId, 'campus_lead');
    await waitForSyncQueue();

    assert(!memberRoles.has(campusLeadRole.id), 'Campus Lead role must be removed from member');
    assert(memberRoles.has(verifiedRole.id), 'Verified Member role must remain on connected member');
    assert(!memberRoles.has(unverifiedRole.id), 'Unverified role must NOT be added to connected member');
  });

  // ==========================================================================
  // TEST 2: Role Revocation on Chapter Server when OS role is removed
  // ==========================================================================
  await itAsync('Chapter Server: removes Executive Member role when revoked in ElevatesOS, preserving Verified role', async () => {
    resetDb();

    const chapterId = 'chp_alpha_01';
    const chapterGuild = createMockGuild('guild_chp_1', 'Alpha Chapter Server', 'chapter', chapterId);
    const verifiedRole = await chapterGuild.roles.create({ name: 'ELEVATES • Member' });
    const execRole = await chapterGuild.roles.create({ name: 'Executive Member' });
    const unverifiedRole = await chapterGuild.roles.create({ name: 'Unverified' });

    const discordUserId = 'user_exec_1';
    const osUserId = 'prof_exec_1';

    const { member, memberRoles } = createMockMember(discordUserId, 'ExecUser#0001', [verifiedRole, execRole]);
    chapterGuild.members.cache.set(discordUserId, member);

    mockDb.profiles.push({
      id: osUserId,
      discord_user_id: discordUserId,
      discord_connected: true,
      chapter_id: chapterId,
      full_name: 'Exec User',
    });

    const mockClient = {
      guilds: {
        cache: new Collection([[chapterGuild.id, chapterGuild]]),
      },
    };

    // Run sync with removedRoleKey = 'executive_member'
    await api.syncUserAcrossGuilds(mockClient, discordUserId, osUserId, 'executive_member');
    await waitForSyncQueue();

    assert(!memberRoles.has(execRole.id), 'Executive Member role must be removed from chapter member');
    assert(memberRoles.has(verifiedRole.id), 'Verified role must remain on connected member');
    assert(!memberRoles.has(unverifiedRole.id), 'Unverified role must NOT be added to connected member');
  });

  // ==========================================================================
  // TEST 3: Account Disconnect / Unlink on Main Server
  // ==========================================================================
  await itAsync('Main Server: disconnect removes Verified Member and OS roles, and assigns Unverified', async () => {
    resetDb();

    const mainGuild = createMockGuild(config.mainGuildId, "Elevates's server", 'main');
    const verifiedRole = await mainGuild.roles.create({ name: 'Verified Member' });
    const campusLeadRole = await mainGuild.roles.create({ name: 'Campus Lead' });
    const unverifiedRole = await mainGuild.roles.create({ name: 'Unverified' });

    const discordUserId = 'user_dc_1';
    const osUserId = 'prof_dc_1';

    // Member previously had Verified Member and Campus Lead
    const { member, memberRoles } = createMockMember(discordUserId, 'DisconnectUser#0001', [verifiedRole, campusLeadRole]);
    mainGuild.members.cache.set(discordUserId, member);

    // Profile in OS is now DISCONNECTED (discord_connected: false, discord_user_id: null)
    mockDb.profiles.push({
      id: osUserId,
      discord_user_id: null,
      discord_connected: false,
      full_name: 'Disconnected User',
    });

    const mockClient = {
      guilds: {
        cache: new Collection([[mainGuild.id, mainGuild]]),
      },
    };

    // Run syncUserAcrossGuilds for disconnected user
    await api.syncUserAcrossGuilds(mockClient, discordUserId, osUserId);
    await waitForSyncQueue();

    assert(!memberRoles.has(verifiedRole.id), 'Verified Member role must be removed upon disconnect');
    assert(!memberRoles.has(campusLeadRole.id), 'Campus Lead role must be removed upon disconnect');
    assert(memberRoles.has(unverifiedRole.id), 'Unverified role must be assigned upon disconnect');
  });

  // ==========================================================================
  // TEST 4: Account Disconnect / Unlink on Chapter Server
  // ==========================================================================
  await itAsync('Chapter Server: disconnect removes all verified variants and chapter roles, and assigns Unverified', async () => {
    resetDb();

    const chapterId = 'chp_beta_02';
    const chapterGuild = createMockGuild('guild_chp_2', 'Beta Chapter Server', 'chapter', chapterId);
    const verifiedRole1 = await chapterGuild.roles.create({ name: 'Verified Member' });
    const verifiedRole2 = await chapterGuild.roles.create({ name: 'ELEVATES • Member' });
    const clRole = await chapterGuild.roles.create({ name: 'Campus Lead' });
    const unverifiedRole = await chapterGuild.roles.create({ name: 'Unverified' });

    const discordUserId = 'user_dc_2';
    const osUserId = 'prof_dc_2';

    // Member holds verified roles and Campus Lead
    const { member, memberRoles } = createMockMember(discordUserId, 'BetaUser#0001', [verifiedRole1, verifiedRole2, clRole]);
    chapterGuild.members.cache.set(discordUserId, member);

    // Profile is disconnected
    mockDb.profiles.push({
      id: osUserId,
      discord_user_id: null,
      discord_connected: false,
      chapter_id: chapterId,
    });

    const mockClient = {
      guilds: {
        cache: new Collection([[chapterGuild.id, chapterGuild]]),
      },
    };

    await api.syncUserAcrossGuilds(mockClient, discordUserId, osUserId);
    await waitForSyncQueue();

    assert(!memberRoles.has(verifiedRole1.id), '"Verified Member" must be removed upon disconnect');
    assert(!memberRoles.has(verifiedRole2.id), '"ELEVATES • Member" must be removed upon disconnect');
    assert(!memberRoles.has(clRole.id), 'Campus Lead role must be removed upon disconnect');
    assert(memberRoles.has(unverifiedRole.id), 'Unverified role must be assigned upon disconnect');
  });

  // ==========================================================================
  // TEST 5: Complete Cross-Guild Unlink via /unlink Command
  // ==========================================================================
  await itAsync('/unlink command: de-provisions user across Main Server and Chapter Server', async () => {
    resetDb();

    const mainGuild = createMockGuild(config.mainGuildId, "Elevates's server", 'main');
    const mainVerified = await mainGuild.roles.create({ name: 'Verified Member' });
    const mainUnverified = await mainGuild.roles.create({ name: 'Unverified' });
    const mainLead = await mainGuild.roles.create({ name: 'Campus Lead' });

    const chapterId = 'chp_gamma_03';
    const chapterGuild = createMockGuild('guild_chp_3', 'Gamma Chapter Server', 'chapter', chapterId);
    const chapterVerified = await chapterGuild.roles.create({ name: 'ELEVATES • Member' });
    const chapterUnverified = await chapterGuild.roles.create({ name: 'Unverified' });
    const chapterLead = await chapterGuild.roles.create({ name: 'Campus Lead' });

    const targetDiscordId = 'user_to_unlink';
    const osUserId = 'prof_gamma_1';

    // Member holds roles in both guilds
    const { member: mainMember, memberRoles: mainRoles } = createMockMember(targetDiscordId, 'UnlinkTarget#0001', [mainVerified, mainLead]);
    const { member: chapterMember, memberRoles: chRoles } = createMockMember(targetDiscordId, 'UnlinkTarget#0001', [chapterVerified, chapterLead]);

    mainGuild.members.cache.set(targetDiscordId, mainMember);
    chapterGuild.members.cache.set(targetDiscordId, chapterMember);

    // Initial linked state in database
    mockDb.profiles.push({
      id: osUserId,
      discord_user_id: targetDiscordId,
      discord_connected: true,
      chapter_id: chapterId,
      full_name: 'Gamma Lead',
    });
    mockDb.discord_links.push({
      id: 'link_gamma_1',
      discord_user_id: targetDiscordId,
      os_user_id: osUserId,
      status: 'linked',
    });

    const mockClient = {
      guilds: {
        cache: new Collection([
          [mainGuild.id, mainGuild],
          [chapterGuild.id, chapterGuild],
        ]),
      },
    };

    let replyMessage = null;
    const mockInteraction = {
      guild: mainGuild,
      guildId: mainGuild.id,
      client: mockClient,
      user: { id: 'admin_mod_1', tag: 'AdminMod#9999' },
      member: {
        id: 'admin_mod_1',
        permissions: {
          has: (perm) => true,
        },
      },
      options: {
        getMember: () => mainMember,
      },
      deferred: false,
      deferReply: async () => {
        mockInteraction.deferred = true;
      },
      editReply: async (payload) => {
        replyMessage = typeof payload === 'string' ? payload : payload.content;
      },
      reply: async (payload) => {
        replyMessage = typeof payload === 'string' ? payload : payload.content;
      },
    };

    // Execute /unlink
    await unlinkCommand.execute(mockInteraction);
    await waitForSyncQueue();

    assert(replyMessage.includes('has been unlinked from ElevatesOS'), 'Confirmation reply sent');

    // DB state must be updated
    const profile = mockDb.profiles.find((p) => p.id === osUserId);
    assert.strictEqual(profile.discord_connected, false, 'Profile discord_connected must be false');
    assert.strictEqual(profile.discord_user_id, null, 'Profile discord_user_id must be null');

    // Main server roles check
    assert(!mainRoles.has(mainVerified.id), 'Main server: Verified Member must be removed');
    assert(!mainRoles.has(mainLead.id), 'Main server: Campus Lead must be removed');
    assert(mainRoles.has(mainUnverified.id), 'Main server: Unverified must be added');

    // Chapter server roles check
    assert(!chRoles.has(chapterVerified.id), 'Chapter server: ELEVATES • Member must be removed');
    assert(!chRoles.has(chapterLead.id), 'Chapter server: Campus Lead must be removed');
    assert(chRoles.has(chapterUnverified.id), 'Chapter server: Unverified must be added');
  });

  // ==========================================================================
  // TEST 6: Admin / HQ Admin Role Demotion on Main Server
  // ==========================================================================
  await itAsync('Main Server: removes HQ Admin and Admin roles when revoked in ElevatesOS', async () => {
    resetDb();

    const mainGuild = createMockGuild(config.mainGuildId, "Elevates's server", 'main');
    const verifiedRole = await mainGuild.roles.create({ name: 'Verified Member' });
    const hqAdminRole = await mainGuild.roles.create({ name: 'HQ Admin' });
    const adminRole = await mainGuild.roles.create({ name: 'Admin' });
    const elevAdminRole = await mainGuild.roles.create({ name: 'ELEVATES • Admin' });

    const discordUserId = 'user_admin_demote';
    const osUserId = 'prof_admin_demote';

    const { member, memberRoles } = createMockMember(discordUserId, 'AdminUser#0001', [
      verifiedRole,
      hqAdminRole,
      adminRole,
      elevAdminRole,
    ]);
    mainGuild.members.cache.set(discordUserId, member);

    mockDb.profiles.push({
      id: osUserId,
      discord_user_id: discordUserId,
      discord_connected: true,
      role: 'member',
      designation: null,
      full_name: 'Former Admin',
    });

    const mockClient = {
      guilds: {
        cache: new Collection([[mainGuild.id, mainGuild]]),
      },
    };

    // Run sync passing removedRoleKey = 'admin'
    await api.syncUserAcrossGuilds(mockClient, discordUserId, osUserId, 'admin');
    await waitForSyncQueue();

    assert(!memberRoles.has(hqAdminRole.id), 'HQ Admin role must be removed');
    assert(!memberRoles.has(adminRole.id), 'Admin role must be removed');
    assert(!memberRoles.has(elevAdminRole.id), 'ELEVATES • Admin role must be removed');
    assert(memberRoles.has(verifiedRole.id), 'Verified Member must be preserved');
  });

  // ==========================================================================
  // TEST 7: unlinkIdentity with Client automatically de-provisions across guilds
  // ==========================================================================
  await itAsync('unlinkIdentity: passing client invokes cross-guild role de-provisioning', async () => {
    resetDb();

    const mainGuild = createMockGuild(config.mainGuildId, "Elevates's server", 'main');
    const verifiedRole = await mainGuild.roles.create({ name: 'Verified Member' });
    const unverifiedRole = await mainGuild.roles.create({ name: 'Unverified' });

    const discordUserId = 'user_direct_unlink';
    const osUserId = 'prof_direct_unlink';

    const { member, memberRoles } = createMockMember(discordUserId, 'DirectUnlink#0001', [verifiedRole]);
    mainGuild.members.cache.set(discordUserId, member);

    mockDb.profiles.push({
      id: osUserId,
      discord_user_id: discordUserId,
      discord_connected: true,
      full_name: 'Direct Unlink User',
    });
    mockDb.discord_links.push({
      id: 'link_direct_1',
      discord_user_id: discordUserId,
      os_user_id: osUserId,
      status: 'linked',
    });

    const mockClient = {
      guilds: {
        cache: new Collection([[mainGuild.id, mainGuild]]),
      },
    };

    await api.unlinkIdentity(discordUserId, mainGuild.id, 'manual_api_call', mockClient);
    await waitForSyncQueue();

    assert(!memberRoles.has(verifiedRole.id), 'Verified Member must be removed after unlinkIdentity');
    assert(memberRoles.has(unverifiedRole.id), 'Unverified must be added after unlinkIdentity');

    const profile = mockDb.profiles.find((p) => p.id === osUserId);
    assert.strictEqual(profile.discord_connected, false);
    assert.strictEqual(profile.discord_user_id, null);
  });

  // ==========================================================================
  // TEST 8: Executive Member Role Assignment and Revocation on Main Server
  // ==========================================================================
  await itAsync('Main Server: assigns Executive Member on assignment and revokes on removal', async () => {
    resetDb();

    const mainGuild = createMockGuild(config.mainGuildId, "Elevates's server", 'main');
    const verifiedRole = await mainGuild.roles.create({ name: 'Verified Member' });
    const execRole = await mainGuild.roles.create({ name: 'Executive Member' });
    const unverifiedRole = await mainGuild.roles.create({ name: 'Unverified' });

    const discordUserId = 'user_exec_main_1';
    const osUserId = 'prof_exec_main_1';

    const { member, memberRoles } = createMockMember(discordUserId, 'ExecMain#0001', []);
    mainGuild.members.cache.set(discordUserId, member);

    mockDb.profiles.push({
      id: osUserId,
      discord_user_id: discordUserId,
      discord_connected: true,
      full_name: 'Exec Main User',
    });
    mockDb.user_roles.push({
      id: 'ur_exec_1',
      user_id: osUserId,
      role_key: 'executive_member',
    });

    const mockClient = {
      guilds: {
        cache: new Collection([[mainGuild.id, mainGuild]]),
      },
    };

    // 1. Initial sync -> Assigns Executive Member and Verified Member
    await api.syncUserAcrossGuilds(mockClient, discordUserId, osUserId);
    await waitForSyncQueue();

    assert(memberRoles.has(execRole.id), 'Executive Member role must be assigned in Main Server');
    assert(memberRoles.has(verifiedRole.id), 'Verified Member base role must be assigned');

    // 2. Remove role in OS -> Revoked
    mockDb.user_roles = [];
    await api.syncUserAcrossGuilds(mockClient, discordUserId, osUserId, 'executive_member');
    await waitForSyncQueue();

    assert(!memberRoles.has(execRole.id), 'Executive Member role must be removed upon OS revocation');
    assert(memberRoles.has(verifiedRole.id), 'Verified Member base role must be preserved');
  });

  console.log(`\n========================================`);
  console.log(`ALL ROLE REVOCATION & DISCONNECT TESTS PASSED! (${passedTests}/${totalTests} tests)`);
  console.log(`========================================\n`);
}

runTests();
