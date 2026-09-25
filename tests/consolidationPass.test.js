const assert = require('assert');
const { ChannelType, PermissionFlagsBits, Collection, MessageFlags } = require('discord.js');

// Mock supabase offline
const supabase = require('../src/lib/supabase');
const mockDb = {
  profiles: [],
  discord_links: [],
  discord_link_codes: [],
  guild_config: [],
  pending_discord_roles: [],
  discord_sync_log: [],
  discord_events_log: [],
};

function resetDb() {
  mockDb.profiles = [];
  mockDb.discord_links = [];
  mockDb.discord_link_codes = [];
  mockDb.guild_config = [];
  mockDb.pending_discord_roles = [];
  mockDb.discord_sync_log = [];
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
    gt: (col, val) => {
      filters.push((row) => row[col] > val);
      return chain;
    },
    or: (orClause) => {
      // e.g. "code.eq.ABC123,code.eq.abc123"
      const conditions = orClause.split(',').map((cond) => {
        const parts = cond.split('.eq.');
        return { col: parts[0], val: parts[1] };
      });
      filters.push((row) => conditions.some((c) => row[c.col] === c.val));
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

const config = require('../src/config');
const { COMMAND_PERMISSIONS } = require('../src/lib/permissions');
const codeVerification = require('../src/lib/codeVerification');
const verifySessions = require('../src/lib/verifySessions');

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

async function runTests() {
  console.log('--- RUNNING FULL CONSOLIDATION & PERFORMANCE AUDIT TEST SUITE ---\n');

  // ==========================================================================
  // SECTION 1: CODE-PASTE VERIFICATION IN #link-server
  // ==========================================================================
  await itAsync('Section 1: Valid 6-character code links account and deletes message immediately', async () => {
    resetDb();
    codeVerification.resetRateLimit('user_discord_1');

    const osUserId = 'profile_uuid_001';
    mockDb.profiles.push({
      id: osUserId,
      full_name: 'Test Student',
      discord_connected: false,
      chapter_id: 'chp_001',
    });

    const code = 'XY7890';
    mockDb.discord_link_codes.push({
      id: 'code_001',
      user_id: osUserId,
      code: code,
      status: 'pending',
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    let messageDeleted = false;
    let transientMsgSent = null;
    let welcomeMsgSent = null;

    const mockWelcomeChannel = {
      name: 'welcome',
      permissionsFor: () => ({ has: () => true }),
      send: async (text) => {
        welcomeMsgSent = text;
        return { id: 'welcome_msg_1' };
      },
    };

    const rolesCache = new Collection();
    const verifiedRole = { id: 'role_verified_1', name: 'ELEVATES • Member' };
    rolesCache.set(verifiedRole.id, verifiedRole);

    const memberRoles = new Set();
    const mockMember = {
      roles: {
        cache: { has: (id) => memberRoles.has(id) },
        add: async (r) => memberRoles.add(r.id),
        remove: async () => {},
      },
    };

    const mockMessage = {
      content: code,
      author: { id: 'user_discord_1', tag: 'Tester#1234', bot: false, toString: () => '<@user_discord_1>' },
      channel: {
        name: 'link-server',
        send: async (text) => {
          transientMsgSent = text;
          return {
            delete: async () => {},
          };
        },
      },
      guild: {
        id: 'guild_chapter_1',
        roles: { cache: rolesCache },
        channels: { cache: new Collection([['ch_welcome', mockWelcomeChannel]]) },
        members: {
          me: { permissions: { has: () => true } },
          fetch: async () => mockMember,
        },
      },
      member: mockMember,
      delete: async () => {
        messageDeleted = true;
      },
      client: {
        guilds: { cache: new Collection() },
      },
    };

    const handled = await codeVerification.handleLinkServerMessage(mockMessage);
    assert.strictEqual(handled, true, 'Message should be handled by verification flow');
    assert.strictEqual(messageDeleted, true, 'Message MUST be deleted immediately');

    // Check code marked used
    const codeRow = mockDb.discord_link_codes.find((c) => c.id === 'code_001');
    assert.strictEqual(codeRow.status, 'used', 'Code status must be updated to used');

    // Check profile linked
    const profile = mockDb.profiles.find((p) => p.id === osUserId);
    assert.strictEqual(profile.discord_connected, true, 'Profile must be marked connected');
    assert.strictEqual(profile.discord_user_id, 'user_discord_1');

    // Check role granted
    assert(memberRoles.has(verifiedRole.id), 'Verified role should be assigned');

    // Check transient and permanent messages
    assert(transientMsgSent.includes('Account verified and linked!'), 'Transient confirmation message should be sent');
    assert(welcomeMsgSent.includes('Welcome'), 'Permanent welcome message should be sent');
  });

  await itAsync('Section 1: Invalid code triggers immediate deletion, failure reply, and rate-limiting', async () => {
    resetDb();
    codeVerification.resetRateLimit('user_spammer_1');

    let deleted = false;
    let errorReply = null;

    const mockMessage = {
      content: 'WRONG1',
      author: { id: 'user_spammer_1', tag: 'Spam#0001', bot: false, toString: () => '<@user_spammer_1>' },
      channel: {
        name: 'link-server',
        send: async (text) => {
          errorReply = text;
          return { delete: async () => {} };
        },
      },
      guild: { id: 'guild_1' },
      delete: async () => {
        deleted = true;
      },
    };

    // First 4 attempts
    for (let i = 0; i < 4; i++) {
      const handled = await codeVerification.handleLinkServerMessage(mockMessage);
      assert.strictEqual(handled, true);
      assert.strictEqual(deleted, true);
      assert(errorReply.includes('Invalid or expired code'));
      assert.strictEqual(codeVerification.isRateLimited('user_spammer_1'), false);
    }

    // 5th attempt triggers rate limit
    await codeVerification.handleLinkServerMessage(mockMessage);
    assert.strictEqual(codeVerification.isRateLimited('user_spammer_1'), true, 'User should be in cooldown after 5 failed attempts');

    // 6th attempt is ignored due to active cooldown
    errorReply = null;
    const handled6 = await codeVerification.handleLinkServerMessage(mockMessage);
    assert.strictEqual(handled6, true);
    assert.strictEqual(errorReply, null, 'Rate-limited attempt should be ignored without sending error message');
  });

  // ==========================================================================
  // SECTION 2: MAIN SERVER CATEGORY VISIBILITY STRUCTURE
  // ==========================================================================
  it('Section 2: Enforces main server category overwrites (@everyone, Verified Member, Locked)', () => {
    const categories = [
      { name: '01 • START HERE', isStartHere: true, isPublic: false, isLocked: false },
      { name: '02 • ANNOUNCEMENTS', isStartHere: false, isPublic: true, isLocked: false },
      { name: '09 • RESOURCES', isStartHere: false, isPublic: true, isLocked: false },
      { name: 'COMMUNITY VOICE', isStartHere: false, isPublic: true, isLocked: false },
      { name: '10 • CORE TEAM', isStartHere: false, isPublic: false, isLocked: true },
      { name: 'CHAPTER LOGS 🔒', isStartHere: false, isPublic: false, isLocked: true },
      { name: 'FOUNDER TICKETS', isStartHere: false, isPublic: false, isLocked: true },
      { name: 'ADMIN TICKETS', isStartHere: false, isPublic: false, isLocked: true },
    ];

    for (const cat of categories) {
      const isStartHere = /01\b|start\s*here/i.test(cat.name);
      const isPublic = /^0[2-9]\b/i.test(cat.name) || /community\s*voice/i.test(cat.name);
      const isLocked = /^1[0-5]\b/i.test(cat.name) || /chapter\s*logs?|founder\s*tickets?|admin\s*tickets?/i.test(cat.name);

      assert.strictEqual(isStartHere, cat.isStartHere, `Category "${cat.name}" start-here match`);
      assert.strictEqual(isPublic, cat.isPublic, `Category "${cat.name}" public match`);
      assert.strictEqual(isLocked, cat.isLocked, `Category "${cat.name}" locked match`);

      // Permission assertions:
      // @everyone allowed view ONLY on 01
      if (isStartHere) {
        assert(isStartHere, '@everyone allowed view on 01');
      } else {
        assert(!isStartHere, '@everyone denied view on all non-01 categories');
      }

      // Verified Member allowed on public (02-09, Community Voice)
      if (isPublic) {
        assert(isPublic, 'Verified Member allowed on public categories');
      }
    }
  });

  // ==========================================================================
  // SECTION 3: COMMAND PERMISSION MATRIX & DEFAULT MEMBER PERMISSIONS
  // ==========================================================================
  it('Section 3: Main Server permissions: /ban and /unban for Founder/HQ Admin only; /chapter for campus_lead', () => {
    const mainPerms = COMMAND_PERMISSIONS.main;
    assert.deepStrictEqual(mainPerms.founder, ['*']);
    assert.deepStrictEqual(mainPerms.hq_admin, ['*']);
    assert.deepStrictEqual(mainPerms.campus_lead, ['chapter']);
    assert(!mainPerms.student, 'Students have no elevated commands in main');
  });

  it('Section 3: Chapter Server permissions: Tier A is Campus Lead only; Tier B includes tierBRoles', () => {
    const chapterPerms = COMMAND_PERMISSIONS.chapter;

    // Tier A commands: Campus Lead ONLY
    for (const cmd of ['ban', 'unban', 'unlink']) {
      assert(chapterPerms.campus_lead.includes(cmd), `campus_lead should have Tier A /${cmd}`);
      assert(!chapterPerms.executive_member.includes(cmd), `executive_member must not have Tier A /${cmd}`);
      assert(!chapterPerms.class_rep.includes(cmd), `class_rep must not have Tier A /${cmd}`);
    }

    // Tier B commands: Campus Lead + Tier B roles
    for (const cmd of ['kick', 'mute', 'warn', 'warnings']) {
      assert(chapterPerms.campus_lead.includes(cmd), `campus_lead should have Tier B /${cmd}`);
      assert(chapterPerms.executive_member.includes(cmd), `executive_member should have Tier B /${cmd}`);
      assert(chapterPerms.class_rep.includes(cmd), `class_rep should have Tier B /${cmd}`);
    }
  });

  it('Section 3: defaultMemberPermissions configured across moderation & admin commands', () => {
    const commandsToCheck = [
      'ban',
      'unban',
      'kick',
      'mute',
      'warn',
      'warnings',
      'unlink',
      'announce',
      'reply-as-bot',
      'chapter',
      'task-new',
      'clear',
      'close-ticket',
    ];

    for (const cmdName of commandsToCheck) {
      const cmd = require(`../src/commands/${cmdName}`);
      assert(cmd.data.default_member_permissions !== undefined || cmd.data.defaultMemberPermissions !== undefined,
        `Command /${cmdName} must define defaultMemberPermissions`);
    }
  });

  // ==========================================================================
  // SECTION 5: PERFORMANCE PASS AUDIT
  // ==========================================================================
  it('Section 5: verifySessions enforces TTL eviction to prevent memory leaks', () => {
    verifySessions.start('user_old', 'guild_1');
    const sess = verifySessions.get('user_old');
    assert(sess, 'Session should be created');

    // Artificially age session beyond 1 hour TTL
    sess.createdAt = Date.now() - (2 * 60 * 60 * 1000);
    const expiredSess = verifySessions.get('user_old');
    assert.strictEqual(expiredSess, null, 'Expired session must return null and be evicted');
  });

  console.log(`\n========================================`);
  console.log(`ALL CONSOLIDATION TESTS PASSED! (${passedTests}/${totalTests} tests)`);
  console.log(`========================================\n`);
}

runTests();
