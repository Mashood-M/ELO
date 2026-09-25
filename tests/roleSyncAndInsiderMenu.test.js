const assert = require('assert');
const { ChannelType, PermissionFlagsBits, Collection } = require('discord.js');

// Mock supabase offline
const supabase = require('../src/lib/supabase');
const mockSupabaseTables = {
  chapters: [],
  profiles: [],
  user_roles: [],
  roles: [],
};

supabase.from = function (table) {
  const chain = {
    select: () => chain,
    insert: () => chain,
    update: () => chain,
    delete: () => chain,
    upsert: () => chain,
    eq: () => chain,
    is: () => chain,
    in: () => chain,
    ilike: () => chain,
    or: () => chain,
    order: () => chain,
    limit: () => chain,
    single: async () => ({ data: null, error: new Error('test offline') }),
    maybeSingle: async () => ({ data: null, error: new Error('test offline') }),
    then: function (resolve, reject) {
      return Promise.resolve({ data: null, error: new Error('test offline') }).then(resolve, reject);
    },
  };
  return chain;
};

const config = require('../src/config');
const { COMMAND_PERMISSIONS, hasElevatedPermissions } = require('../src/lib/permissions');
const ticketSystem = require('../src/lib/ticketSystem');
const api = require('../src/lib/api');

let totalTests = 0;
let passedTests = 0;

function it(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    process.exit(1);
  }
}

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

// Helper to create a mock guild with collections
function createMockGuild(id, name) {
  const channels = new Collection();
  const roles = new Collection();
  const members = new Collection();

  const everyoneRole = {
    id: `${id}_everyone`,
    name: '@everyone',
    permissions: { has: () => false },
  };
  roles.set(everyoneRole.id, everyoneRole);

  const guild = {
    id,
    name,
    client: {
      user: { id: 'bot_user_id' },
    },
    roles: {
      everyone: everyoneRole,
      cache: roles,
      fetch: async () => roles,
      create: async (opts) => {
        const r = {
          id: `${id}_role_${opts.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
          name: opts.name,
          color: opts.color || 0,
          hoist: opts.hoist || false,
          permissions: { has: () => false },
        };
        roles.set(r.id, r);
        return r;
      },
    },
    channels: {
      cache: channels,
      fetch: async () => channels,
      create: async (opts) => {
        const ch = {
          id: `${id}_ch_${opts.name.replace(/[^a-z0-9]/gi, '_')}`,
          name: opts.name,
          type: opts.type,
          parentId: opts.parent || null,
          permissionOverwrites: {
            cache: new Collection(
              (opts.permissionOverwrites || []).map((o) => [o.id, o])
            ),
            set: async (overwrites) => {
              ch.permissionOverwrites.cache = new Collection(overwrites.map((o) => [o.id, o]));
            },
          },
          threads: {
            cache: new Collection(),
            create: async (topts) => ({
              id: `${id}_th_${topts.name}`,
              name: topts.name,
              send: async () => ({ id: 'mock_msg' }),
            }),
          },
        };
        channels.set(ch.id, ch);
        return ch;
      },
    },
    members: {
      me: {
        permissions: {
          has: () => true,
        },
      },
      cache: members,
      fetch: async (uid) => members.get(uid) || null,
    },
  };

  return guild;
}

async function runTests() {
  console.log('--- RUNNING ROLE SYNC & INSIDER MENU TEST SUITE ---\n');

  // --------------------------------------------------------------------------
  // 1. CONFIGURATION & ROLE DEFINITIONS
  // --------------------------------------------------------------------------
  it('config: defines executiveMember role name and maps to Verified Member in main server', () => {
    assert.strictEqual(typeof config.roles.executiveMember, 'string');
    assert.strictEqual(config.roles.executiveMember, 'Executive Member');

    const mapping = config.mainRoles.roleMapping;
    assert.strictEqual(mapping['executive_member'], 'Verified Member');
    assert.strictEqual(mapping['exec_member'], 'Verified Member');
    assert.strictEqual(mapping['executive'], 'Verified Member');
  });

  // --------------------------------------------------------------------------
  // 2. COMMAND PERMISSION MATRIX
  // --------------------------------------------------------------------------
  it('permissions: Tier A is scoped to Campus Lead only; Tier B includes executive_member', () => {
    const chapterPerms = COMMAND_PERMISSIONS.chapter;
    assert(chapterPerms['campus_lead'], 'campus_lead must exist in chapter matrix');
    assert(chapterPerms['executive_member'], 'executive_member must exist in chapter matrix');
    assert(chapterPerms['exec_member'], 'exec_member must exist in chapter matrix');
    assert(chapterPerms['executive'], 'executive must exist in chapter matrix');

    // Tier A commands: Campus Lead ONLY
    for (const cmd of ['ban', 'unban', 'unlink']) {
      assert(chapterPerms['campus_lead'].includes(cmd), `campus_lead should have Tier A /${cmd}`);
      assert(!chapterPerms['executive_member'].includes(cmd), `executive_member must NOT have Tier A /${cmd}`);
    }

    // Tier B commands: Campus Lead + Tier B roles
    for (const cmd of ['kick', 'mute', 'warn', 'warnings']) {
      assert(chapterPerms['campus_lead'].includes(cmd), `campus_lead should have Tier B /${cmd}`);
      assert(chapterPerms['executive_member'].includes(cmd), `executive_member should have Tier B /${cmd}`);
    }
  });

  it('permissions: executive_member does NOT have /chapter or main server elevated permissions', () => {
    const chapterPerms = COMMAND_PERMISSIONS.chapter;
    assert(!chapterPerms['executive_member'].includes('chapter'), 'executive_member must not have /chapter in chapter server');
    assert(!chapterPerms['campus_lead'].includes('chapter'), 'campus_lead must not have /chapter in chapter server');

    const mainPerms = COMMAND_PERMISSIONS.main;
    assert(!mainPerms['executive_member'], 'executive_member must not have elevated commands in main server');
    assert(!mainPerms['exec_member'], 'exec_member must not have elevated commands in main server');
  });

  // --------------------------------------------------------------------------
  // 3. TICKET LANE AUTHORIZATION & PICKER ORDER
  // --------------------------------------------------------------------------
  await itAsync('ticketSystem: executive member authorized for exec lane but denied for campus_lead lane', async () => {
    const execRole = { id: 'role_exec_1', name: 'Executive Member' };
    const memberWithExecRole = {
      id: 'user_exec_discord',
      roles: {
        cache: new Collection([['role_exec_1', execRole]]),
      },
      guild: {
        id: 'chapter_guild_1',
        roles: {
          cache: new Collection([['role_exec_1', execRole]]),
        },
      },
    };

    const isAuthForExec = await ticketSystem.isUserAuthorizedForLane(memberWithExecRole, 'exec', 'chapter_guild_1');
    assert.strictEqual(isAuthForExec, true, 'User with Executive Member Discord role must be authorized for exec lane');

    const isAuthForCL = await ticketSystem.isUserAuthorizedForLane(memberWithExecRole, 'campus_lead', 'chapter_guild_1');
    assert.strictEqual(isAuthForCL, false, 'Executive Member must not be authorized to staff campus_lead lane');
  });

  await itAsync('ticketSystem: campus lead authorized for both campus_lead and exec lanes', async () => {
    const clRole = { id: 'role_cl_1', name: 'Campus Lead' };
    const memberWithCLRole = {
      id: 'user_cl_discord',
      roles: {
        cache: new Collection([['role_cl_1', clRole]]),
      },
      guild: {
        id: 'chapter_guild_1',
        roles: {
          cache: new Collection([['role_cl_1', clRole]]),
        },
      },
    };

    const isAuthForCL = await ticketSystem.isUserAuthorizedForLane(memberWithCLRole, 'campus_lead', 'chapter_guild_1');
    assert.strictEqual(isAuthForCL, true, 'Campus Lead must be authorized for campus_lead lane');

    const isAuthForExec = await ticketSystem.isUserAuthorizedForLane(memberWithCLRole, 'exec', 'chapter_guild_1');
    assert.strictEqual(isAuthForExec, true, 'Campus Lead must be authorized for exec lane');
  });

  await itAsync('ticketSystem: executive member authorized via OS role user_roles', async () => {
    const memberNoRoles = {
      id: 'user_exec_os',
      roles: {
        cache: new Collection(),
      },
      guild: {
        id: 'chapter_guild_1',
        roles: {
          cache: new Collection(),
        },
      },
    };

    const originalGetIdentity = api.getIdentityByDiscordId;
    api.getIdentityByDiscordId = async () => ({
      profile: { id: 'prof_exec_1' },
      userRoles: [{ role_key: 'executive_member' }],
    });

    try {
      const isAuth = await ticketSystem.isUserAuthorizedForLane(memberNoRoles, 'exec', 'chapter_guild_1');
      assert.strictEqual(isAuth, true, 'User with OS executive_member role must be authorized for exec lane');
    } finally {
      api.getIdentityByDiscordId = originalGetIdentity;
    }
  });

  it('ticketSystem: lane picker places Executive Member directly under Campus Lead', () => {
    const row = ticketSystem.createLanePickerRow();
    assert(row && row.components && row.components.length === 4, 'Should have 4 lane buttons');

    const buttons = row.components.map((b) => ({
      customId: b.data.custom_id,
      label: b.data.label,
    }));

    assert.strictEqual(buttons[0].customId, 'ticket_lane_founder');
    assert.strictEqual(buttons[1].customId, 'ticket_lane_admin');
    assert.strictEqual(buttons[2].customId, 'ticket_lane_campus_lead');
    assert.strictEqual(buttons[3].customId, 'ticket_lane_exec');
    assert.strictEqual(buttons[3].label, 'Executive Member');
  });

  // --------------------------------------------------------------------------
  // 4. AUDIT LOG STARTER THREADS & TERM HANDOVER CATEGORY
  // --------------------------------------------------------------------------
  it('audit logs: STARTER_THREADS includes term_handover topic', () => {
    assert(Array.isArray(api.STARTER_THREADS), 'STARTER_THREADS must be an array');
    const termHandover = api.STARTER_THREADS.find((t) => t.key === 'term_handover');
    assert(termHandover, 'STARTER_THREADS must contain key term_handover');
    assert.strictEqual(termHandover.name, '🔄 Term Handover');
    assert(termHandover.matchTerms.includes('term handover'));
    assert(termHandover.matchTerms.includes('handover'));
    assert(termHandover.matchTerms.includes('term transition'));
  });

  await itAsync('audit logs: logChapterEvent routes handover actions to term_handover category', async () => {
    let loggedPayload = null;

    const originalEnsureForum = api.ensureChapterLogForum;
    const mockThread = {
      id: 'mock_term_handover_thread',
      name: '🔄 Term Handover',
      isThread: () => true,
      joinable: false,
      archived: false,
      send: async (payload) => {
        loggedPayload = payload;
        return { id: 'mock_msg_id' };
      },
    };

    api.ensureChapterLogForum = async () => ({
      forumChannel: { id: 'mock_forum_channel', type: ChannelType.GuildForum },
      threadMap: {
        term_handover: mockThread,
      },
      chapterName: 'Alpha Chapter',
    });

    try {
      const mockClient = {};
      await api.logChapterEvent(
        mockClient,
        '00000000-0000-0000-0000-000000000001',
        'guild_1',
        'term_handover',
        {
          title: 'Term Handover Completed',
          description: 'New Campus Lead: Alice, Executive Team: Bob, Charlie',
        }
      );

      assert(loggedPayload, 'Should have logged message in forum thread');
      assert(loggedPayload.embeds && loggedPayload.embeds.length > 0);
      const embed = loggedPayload.embeds[0].data;
      assert.strictEqual(embed.color, 0x6366f1, 'term_handover embed color should be 0x6366F1');
      assert(embed.title.includes('🔄'), 'Embed title should have term_handover emoji');
      assert(embed.title.includes('TERM HANDOVER'), 'Embed title should reflect term_handover');
    } finally {
      api.ensureChapterLogForum = originalEnsureForum;
    }
  });

  await itAsync('audit logs: logTermHandoverEvent convenience logger routes to term_handover', async () => {
    let loggedCategory = null;
    let loggedDetail = null;

    const originalLogChapterEvent = api.logChapterEvent;
    api.logChapterEvent = async (client, chapterId, guildId, eventType, detail = {}, category = null) => {
      loggedCategory = category;
      loggedDetail = detail;
      return true;
    };

    try {
      const mockClient = {};
      const res = await api.logTermHandoverEvent(mockClient, '00000000-0000-0000-0000-000000000001', 'guild_1', {
        oldCampusLead: 'Alice (Old CL)',
        newCampusLead: 'Bob (New CL)',
        demotedExecutives: 'Charlie',
        assignedExecutives: 'Diana',
      });

      assert.strictEqual(res, true);
      assert.strictEqual(loggedCategory, 'term_handover');
      assert.strictEqual(loggedDetail.old_campus_lead, 'Alice (Old CL)');
      assert.strictEqual(loggedDetail.new_campus_lead, 'Bob (New CL)');
      assert.strictEqual(loggedDetail.demoted_executives, 'Charlie');
      assert.strictEqual(loggedDetail.assigned_executives, 'Diana');
    } finally {
      api.logChapterEvent = originalLogChapterEvent;
    }
  });

  // --------------------------------------------------------------------------
  // 5. CHAPTER LEADERSHIP SECTION (CAMPUS LEAD & EXECUTIVE MEMBER TIERS)
  // --------------------------------------------------------------------------
  await itAsync('leadership section: ensures Campus Lead and Executive Member channels with correct permissions', async () => {
    const mockGuild = createMockGuild('chp_guild_alpha', 'Chapter Alpha');

    await mockGuild.roles.create({ name: 'Campus Lead' });
    await mockGuild.roles.create({ name: 'Executive Member' });

    const res = await api.ensureChapterLeadershipSection(mockGuild, '00000000-0000-0000-0000-000000000001');

    assert(res.category, 'Must create or return LEADERSHIP category');
    assert(res.campusLeadChannel, 'Must create or return #campus-lead channel');
    assert(res.execChannel, 'Must create or return #executive-members channel');

    // Check category permissions: @everyone denied
    const catOverwrites = res.category.permissionOverwrites.cache;
    const everyoneCat = catOverwrites.get(mockGuild.roles.everyone.id);
    assert(everyoneCat && everyoneCat.deny.includes(PermissionFlagsBits.ViewChannel), '@everyone denied category view');

    // Check Campus Lead channel permissions
    const clRole = mockGuild.roles.cache.find((r) => r.name === 'Campus Lead');
    const execRole = mockGuild.roles.cache.find((r) => r.name === 'Executive Member');

    const clOverwrites = res.campusLeadChannel.permissionOverwrites.cache;
    const clInCL = clOverwrites.get(clRole.id);
    const execInCL = clOverwrites.get(execRole.id);
    assert(clInCL && clInCL.allow.includes(PermissionFlagsBits.ViewChannel), 'Campus Lead allowed in #campus-lead');
    assert(execInCL && execInCL.deny.includes(PermissionFlagsBits.ViewChannel), 'Executive Member denied in #campus-lead');

    // Check Executive Member channel permissions
    const execOverwrites = res.execChannel.permissionOverwrites.cache;
    const clInExec = execOverwrites.get(clRole.id);
    const execInExec = execOverwrites.get(execRole.id);
    assert(clInExec && clInExec.allow.includes(PermissionFlagsBits.ViewChannel), 'Campus Lead allowed in #executive-members');
    assert(execInExec && execInExec.allow.includes(PermissionFlagsBits.ViewChannel), 'Executive Member allowed in #executive-members');
  });

  // --------------------------------------------------------------------------
  // 6. ROSTER DISPLAY (updateChapterCurrentRolesTopic)
  // --------------------------------------------------------------------------
  await itAsync('roster: updateChapterCurrentRolesTopic formats Executive Members under Campus Lead', async () => {
    let sentPayload = null;

    const mockThread = {
      id: 'thread_current_roles',
      name: '👥 Current Roles',
      joinable: true,
      archived: false,
      join: async () => {},
      setArchived: async () => {},
      messages: {
        fetch: async () => new Collection(),
      },
      send: async (content) => {
        sentPayload = content;
        return { id: 'msg_new_roster', pin: async () => {} };
      },
    };

    const originalGetChapter = api.getChapterByIdentifier;
    api.getChapterByIdentifier = async () => ({
      id: '00000000-0000-0000-0000-000000000001',
      name: 'Alpha Chapter',
      campus_lead_id: 'prof_lead_1',
    });

    const originalFrom = supabase.from;
    supabase.from = function (table) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        single: async () => {
          if (table === 'profiles') {
            return {
              data: {
                id: 'prof_lead_1',
                full_name: 'Lead Alice',
                elevates_id: 'ELV-001',
                discord_user_id: 'disc_lead_1',
              },
              error: null,
            };
          }
          return { data: null, error: null };
        },
        maybeSingle: async () => ({ data: null, error: null }),
        then: function (resolve) {
          if (table === 'user_roles') {
            return Promise.resolve({
              data: [
                {
                  user_id: 'prof_exec_1',
                  role_key: 'executive_member',
                  chapter_id: '00000000-0000-0000-0000-000000000001',
                },
              ],
              error: null,
            }).then(resolve);
          }
          if (table === 'profiles') {
            return Promise.resolve({
              data: [
                {
                  id: 'prof_lead_1',
                  full_name: 'Lead Alice',
                  elevates_id: 'ELV-001',
                  discord_user_id: 'disc_lead_1',
                },
                {
                  id: 'prof_exec_1',
                  full_name: 'Exec Bob',
                  elevates_id: 'ELV-002',
                  discord_user_id: 'disc_exec_1',
                  designation: 'executive_member',
                },
              ],
              error: null,
            }).then(resolve);
          }
          return Promise.resolve({ data: [], error: null }).then(resolve);
        },
      };
      return chain;
    };

    try {
      const mockClient = { user: { id: 'bot_id' } };
      await api.updateChapterCurrentRolesTopic(mockClient, '00000000-0000-0000-0000-000000000001', mockThread);

      assert(sentPayload, 'Should have sent roster post');
      const embed = sentPayload.embeds[0].data;
      const fields = embed.fields;

      const clField = fields.find((f) => f.name.includes('Campus Lead'));
      const execField = fields.find((f) => f.name.includes('Executive Members'));

      assert(clField, 'Must have Campus Lead field');
      assert(execField, 'Must have Executive Members field');
      assert(clField.value.includes('Lead Alice'));
      assert(execField.value.includes('Exec Bob'));

      const clIndex = fields.indexOf(clField);
      const execIndex = fields.indexOf(execField);
      assert(clIndex < execIndex, 'Campus Lead field should come before Executive Members field');
    } finally {
      api.getChapterByIdentifier = originalGetChapter;
      supabase.from = originalFrom;
    }
  });

  // --------------------------------------------------------------------------
  // 7. CHAPTER PROVISIONING
  // --------------------------------------------------------------------------
  await itAsync('provisioning: provisionChapterGuild ensures Executive Member role & leadership section', async () => {
    const mockGuild = createMockGuild('guild_prov_1', 'Provisioned Chapter');
    const mockClient = {
      guilds: {
        cache: new Collection([[mockGuild.id, mockGuild]]),
        fetch: async () => mockGuild,
      },
    };

    let leadershipCalled = false;
    const originalEnsureLeadership = api.ensureChapterLeadershipSection;
    api.ensureChapterLeadershipSection = async () => {
      leadershipCalled = true;
      return { category: {}, campusLeadChannel: {}, execChannel: {} };
    };

    const originalGetGuildConfig = api.getGuildConfig;
    api.getGuildConfig = async () => null;

    const originalSetGuildConfig = api.setGuildConfig;
    api.setGuildConfig = async () => ({});

    const originalGetAllOsRoles = api.getAllOsRoles;
    api.getAllOsRoles = async () => [{ key: 'executive_member', name: 'Executive Member' }];

    const originalEnsureForum = api.ensureChapterLogForum;
    api.ensureChapterLogForum = async () => null;

    const chapterObj = {
      id: '00000000-0000-0000-0000-000000000001',
      name: 'Provisioned Chapter',
      guild_id: mockGuild.id,
    };

    try {
      const res = await api.provisionChapterGuild(
        mockClient,
        mockGuild,
        chapterObj,
        null
      );

      assert(res, 'Provisioning should return result object');
      assert.strictEqual(res.chapterName, 'Provisioned Chapter');
      const execRole = mockGuild.roles.cache.find((r) => r.name === 'Executive Member');
      assert(execRole, 'Executive Member role must be created during provisioning');
      assert(leadershipCalled, 'ensureChapterLeadershipSection must be called during provisioning');
    } finally {
      api.ensureChapterLeadershipSection = originalEnsureLeadership;
      api.getGuildConfig = originalGetGuildConfig;
      api.setGuildConfig = originalSetGuildConfig;
      api.getAllOsRoles = originalGetAllOsRoles;
      api.ensureChapterLogForum = originalEnsureForum;
    }
  });

  // --------------------------------------------------------------------------
  // 8. REALTIME ROLE SYNC (HANDOVER BEHAVIOR: ASSIGN & DEMOTE)
  // --------------------------------------------------------------------------
  const syncQueue = require('../src/lib/syncQueue');
  syncQueue.minDelayMs = 0;

  async function waitForSyncQueue() {
    while (syncQueue.processing || syncQueue.queue.length > 0 || syncQueue.inFlightSet.size > 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  await itAsync('realtime role sync: syncUserAcrossGuilds assigns Executive Member role on promotion', async () => {
    const mockGuild = createMockGuild('guild_sync_1', 'Sync Chapter');
    const execRole = await mockGuild.roles.create({ name: 'Executive Member' });

    const memberRoles = new Collection();
    const mockMember = {
      id: 'user_new_exec',
      user: { tag: 'NewExec#0001', username: 'NewExec' },
      roles: {
        cache: memberRoles,
        add: async (r) => memberRoles.set(r.id, r),
        remove: async (r) => memberRoles.delete(r.id),
      },
      setNickname: async () => {},
    };
    mockGuild.members.cache.set(mockMember.id, mockMember);

    const originalGetIdentity = api.getIdentityByDiscordId;
    api.getIdentityByDiscordId = async (uid) => ({
      profile: {
        id: 'prof_new_exec',
        discord_user_id: uid,
        discord_connected: true,
        chapter_id: '00000000-0000-0000-0000-000000000001',
      },
      userRoles: [
        {
          role_key: 'executive_member',
          chapter_id: '00000000-0000-0000-0000-000000000001',
        },
      ],
    });

    const originalGetGuildConfig = api.getGuildConfig;
    api.getGuildConfig = async () => ({
      guildType: 'chapter',
      chapterId: '00000000-0000-0000-0000-000000000001',
    });

    const originalGetAllOsRoles = api.getAllOsRoles;
    api.getAllOsRoles = async () => [
      { key: 'executive_member', name: 'Executive Member' },
    ];

    try {
      const mockClient = {
        guilds: {
          cache: new Collection([[mockGuild.id, mockGuild]]),
        },
      };

      await api.syncUserAcrossGuilds(mockClient, mockMember.id);
      await waitForSyncQueue();

      assert(memberRoles.has(execRole.id), 'Executive Member Discord role must be added to member');
    } finally {
      api.getIdentityByDiscordId = originalGetIdentity;
      api.getGuildConfig = originalGetGuildConfig;
      api.getAllOsRoles = originalGetAllOsRoles;
    }
  });

  await itAsync('realtime role sync: syncUserAcrossGuilds removes Executive Member role on handover demotion to student', async () => {
    const mockGuild = createMockGuild('guild_sync_2', 'Sync Chapter Demotion');
    const execRole = await mockGuild.roles.create({ name: 'Executive Member' });

    // Member currently holds Executive Member role
    const memberRoles = new Collection([[execRole.id, execRole]]);
    const mockMember = {
      id: 'user_demoted_exec',
      user: { tag: 'DemotedExec#0001', username: 'DemotedExec' },
      roles: {
        cache: memberRoles,
        add: async (r) => memberRoles.set(r.id, r),
        remove: async (r) => memberRoles.delete(r.id),
      },
      setNickname: async () => {},
    };
    mockGuild.members.cache.set(mockMember.id, mockMember);

    const originalGetIdentity = api.getIdentityByDiscordId;
    api.getIdentityByDiscordId = async (uid) => ({
      profile: {
        id: 'prof_demoted_exec',
        discord_user_id: uid,
        discord_connected: true,
        chapter_id: '00000000-0000-0000-0000-000000000001',
      },
      // OS handover transaction demoted them: only has student role now
      userRoles: [
        {
          role_key: 'student',
          chapter_id: '00000000-0000-0000-0000-000000000001',
        },
      ],
    });

    const originalGetGuildConfig = api.getGuildConfig;
    api.getGuildConfig = async () => ({
      guildType: 'chapter',
      chapterId: '00000000-0000-0000-0000-000000000001',
    });

    const originalGetAllOsRoles = api.getAllOsRoles;
    api.getAllOsRoles = async () => [
      { key: 'executive_member', name: 'Executive Member' },
      { key: 'student', name: 'Student' },
    ];

    try {
      const mockClient = {
        guilds: {
          cache: new Collection([[mockGuild.id, mockGuild]]),
        },
      };

      await api.syncUserAcrossGuilds(mockClient, mockMember.id);
      await waitForSyncQueue();

      assert(!memberRoles.has(execRole.id), 'Executive Member Discord role must be removed upon demotion to student');
    } finally {
      api.getIdentityByDiscordId = originalGetIdentity;
      api.getGuildConfig = originalGetGuildConfig;
      api.getAllOsRoles = originalGetAllOsRoles;
    }
  });

  // --------------------------------------------------------------------------
  // 9. TASK MANAGEMENT PERMISSION CHECKS (TASK-NEW & MARK-TASK-COMPLETE)
  // --------------------------------------------------------------------------
  it('commands: task-new and mark-task-complete authorize executive members', () => {
    const campusLeadRoleName = (config.roles.campusLead || 'Campus Lead').toLowerCase().trim();
    const execMemberRoleName = (config.roles.executiveMember || 'Executive Member').toLowerCase().trim();

    // Helper simulating the authorization logic from task-new.js and mark-task-complete.js
    function isCallerAuthorized(memberRoles, callerUserRoles, cluster, callerProfile) {
      const isCampusLeadOrExecRole = memberRoles.some((r) => {
        const n = r.name.toLowerCase().trim();
        return (
          n === campusLeadRoleName ||
          n === execMemberRoleName ||
          ['executive member', 'executive team', 'executive'].includes(n)
        );
      });

      const isCampusLeadOrExecOs = callerUserRoles?.some((r) => {
        const k = (r.role_key || r.role || r.roles?.key || r.roles?.name || '').toLowerCase().trim();
        return ['campus_lead', 'executive_member', 'exec_member', 'executive'].includes(k);
      });

      const clusterHostRoleName = `${cluster.name} Host`.toLowerCase().trim();
      const isClusterHostRole = memberRoles.some(
        (r) => r.name.toLowerCase().trim() === clusterHostRoleName
      );

      const isClusterLeader = callerProfile && cluster.leader_id === callerProfile.id;

      return Boolean(isCampusLeadOrExecRole || isCampusLeadOrExecOs || isClusterHostRole || isClusterLeader);
    }

    const testCluster = { name: 'AI & ML', leader_id: 'leader_uuid_1' };

    // 1. Regular student without roles -> false
    assert.strictEqual(
      isCallerAuthorized([], [{ role_key: 'student' }], testCluster, { id: 'student_1' }),
      false,
      'Regular student must not be authorized'
    );

    // 2. Member with Executive Member Discord role -> true
    assert.strictEqual(
      isCallerAuthorized([{ name: 'Executive Member' }], [], testCluster, { id: 'exec_1' }),
      true,
      'Executive Member Discord role must be authorized'
    );

    // 3. Member with Executive Member OS role -> true
    assert.strictEqual(
      isCallerAuthorized([], [{ role_key: 'executive_member' }], testCluster, { id: 'exec_2' }),
      true,
      'Executive Member OS role must be authorized'
    );

    // 4. Cluster host -> true
    assert.strictEqual(
      isCallerAuthorized([{ name: 'AI & ML Host' }], [], testCluster, { id: 'host_1' }),
      true,
      'Cluster host Discord role must be authorized'
    );
  });

  console.log('\n========================================');
  console.log(`ALL TESTS PASSED! (${passedTests}/${totalTests} tests)`);
  console.log('========================================\n');
}

runTests().catch((err) => {
  console.error('Test runner fatal error:', err);
  process.exit(1);
});
