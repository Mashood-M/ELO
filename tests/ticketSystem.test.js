const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Clean test state before starting
const DATA_FILE = path.join(__dirname, '../data/tickets.json');
if (fs.existsSync(DATA_FILE)) {
  fs.unlinkSync(DATA_FILE);
}

const supabase = require('../src/lib/supabase');
// Instant offline mock for tests so tests don't wait for 5s network timeouts
supabase.from = function (table) {
  const chain = {
    select: () => chain,
    insert: () => chain,
    update: () => chain,
    delete: () => chain,
    upsert: () => chain,
    eq: () => chain,
    is: () => chain,
    ilike: () => chain,
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

const ticketSystem = require('../src/lib/ticketSystem');
const api = require('../src/lib/api');
const { ChannelType, PermissionFlagsBits, Collection } = require('discord.js');

let passedTests = 0;
let totalTests = 0;

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

// Mock Discord Client & Objects
function createMockClient() {
  const guilds = new Collection();
  const channels = new Collection();
  const users = new Collection();

  const client = {
    user: { id: 'bot_id', tag: 'ElevatesBot#0001' },
    guilds: {
      cache: guilds,
      fetch: async (id) => guilds.get(id) || null,
    },
    channels: {
      cache: channels,
      fetch: async (id) => channels.get(id) || null,
    },
    users: {
      cache: users,
      fetch: async (id) => users.get(id) || null,
    },
  };

  return client;
}

function createMockGuild(id, name, client) {
  const channels = new Collection();
  const roles = new Collection();
  const members = new Collection();

  const everyoneRole = { id: `${id}_everyone`, name: '@everyone', permissions: { has: () => false } };
  roles.set(everyoneRole.id, everyoneRole);

  const guild = {
    id,
    name,
    client,
    ownerId: `${id}_owner`,
    roles: {
      cache: roles,
      everyone: everyoneRole,
      fetch: async () => roles,
      create: async ({ name, color, permissions }) => {
        const role = {
          id: `${id}_role_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
          name,
          color,
          permissions: {
            has: (flag) => false,
            add: (flag) => ({ has: () => true }),
          },
        };
        roles.set(role.id, role);
        return role;
      },
    },
    channels: {
      cache: channels,
      fetch: async (channelId) => (channelId ? client.channels.cache.get(channelId) || channels.get(channelId) || null : channels),
      create: async ({ name, type, topic, parent, permissionOverwrites }) => {
        const ch = createMockChannel(`${id}_ch_${name}`, name, type, guild, client);
        ch.parentId = parent;
        ch.permissionOverwrites = permissionOverwrites;
        channels.set(ch.id, ch);
        client.channels.cache.set(ch.id, ch);
        return ch;
      },
    },
    members: {
      cache: members,
      me: { id: client.user.id, permissions: { has: () => true } },
      fetch: async (userId) => members.get(userId) || null,
    },
  };

  client.guilds.cache.set(id, guild);
  return guild;
}

function createMockChannel(id, name, type, guild, client) {
  const threads = new Collection();
  const sentMessages = [];

  const ch = {
    id,
    name,
    type,
    guild,
    client,
    parentId: null,
    threads: {
      cache: threads,
      fetchActive: async () => ({ threads }),
      fetchArchived: async () => ({ threads: new Collection() }),
      create: async ({ name, message }) => {
        const thread = createMockThread(`${id}_th_${name}`, name, ch, guild, client);
        threads.set(thread.id, thread);
        client.channels.cache.set(thread.id, thread);
        if (message) {
          thread.messages.push(message);
        }
        return thread;
      },
    },
    send: async (payload) => {
      sentMessages.push(payload);
      return { id: `msg_${Date.now()}`, ...payload };
    },
    isThread: () => false,
  };

  return ch;
}

function createMockThread(id, name, parentChannel, guild, client) {
  const messages = [];
  let archived = false;

  const thread = {
    id,
    name,
    parent: parentChannel,
    parentId: parentChannel.id,
    guild,
    client,
    messages,
    archived,
    joinable: true,
    isThread: () => true,
    join: async () => true,
    setArchived: async (val) => {
      thread.archived = val;
      return true;
    },
    send: async (payload) => {
      messages.push(payload);
      return { id: `msg_${Date.now()}`, ...payload };
    },
  };

  return thread;
}

async function runTests() {
  console.log('--- RUNNING TICKET SYSTEM TEST SUITE ---\n');

  const client = createMockClient();
  const mainGuild = createMockGuild('1544247855173345310', 'Elevates Main Server', client);
  const chapterGuild = createMockGuild('chp_guild_1', 'Elevates Chapter Alpha', client);

  // Setup basic roles
  await mainGuild.roles.create({ name: 'Founder' });
  await mainGuild.roles.create({ name: 'HQ Admin' });
  await chapterGuild.roles.create({ name: 'Campus Lead' });
  await chapterGuild.roles.create({ name: 'Executive Team' });

  // 1. TICKET LANES DEFINITIONS
  it('defines the 4 required lanes with correct scopes and verification settings', () => {
    assert.strictEqual(ticketSystem.TICKET_LANES.founder.key, 'founder');
    assert.strictEqual(ticketSystem.TICKET_LANES.founder.requiresVerification, false);
    assert.strictEqual(ticketSystem.TICKET_LANES.founder.scope, 'main');

    assert.strictEqual(ticketSystem.TICKET_LANES.admin.key, 'admin');
    assert.strictEqual(ticketSystem.TICKET_LANES.admin.requiresVerification, false);
    assert.strictEqual(ticketSystem.TICKET_LANES.admin.scope, 'main');

    assert.strictEqual(ticketSystem.TICKET_LANES.exec.key, 'exec');
    assert.strictEqual(ticketSystem.TICKET_LANES.exec.requiresVerification, true);
    assert.strictEqual(ticketSystem.TICKET_LANES.exec.scope, 'chapter');

    assert.strictEqual(ticketSystem.TICKET_LANES.campus_lead.key, 'campus_lead');
    assert.strictEqual(ticketSystem.TICKET_LANES.campus_lead.requiresVerification, true);
    assert.strictEqual(ticketSystem.TICKET_LANES.campus_lead.scope, 'chapter');
  });

  // 2. FORUM & CATEGORY CREATION AND PERMISSIONS
  await itAsync('ensures private forum channels and categories with strict permissions', async () => {
    const founderForum = await ticketSystem.ensureTicketForum(mainGuild, 'founder');
    assert.ok(founderForum);
    assert.strictEqual(founderForum.name, 'founder-tickets');

    // Verify category exists
    const founderCat = mainGuild.channels.cache.find((c) => c.name === 'FOUNDER TICKETS');
    assert.ok(founderCat);
    assert.strictEqual(founderForum.parentId, founderCat.id);

    // Verify admin forum
    const adminForum = await ticketSystem.ensureTicketForum(mainGuild, 'admin');
    assert.ok(adminForum);
    assert.strictEqual(adminForum.name, 'admin-tickets');

    // Verify chapter forums
    const execForum = await ticketSystem.ensureTicketForum(chapterGuild, 'exec');
    assert.ok(execForum);
    assert.strictEqual(execForum.name, 'executive-tickets');

    const campusLeadForum = await ticketSystem.ensureTicketForum(chapterGuild, 'campus_lead');
    assert.ok(campusLeadForum);
    assert.strictEqual(campusLeadForum.name, 'campus-lead-tickets');

    // Verify Campus Lead forum explicitly denies Executive Team
    const campusLeadPerms = campusLeadForum.permissionOverwrites;
    const execRole = chapterGuild.roles.cache.find((r) => r.name === 'Executive Team');
    const deniedExec = campusLeadPerms.find((p) => p.id === execRole.id);
    assert.ok(deniedExec, 'Executive Team must have explicit overwrite in Campus Lead forum');
    assert.deepStrictEqual(deniedExec.deny, [PermissionFlagsBits.ViewChannel]);
  });

  // 3. ENTRY POINT ROUTING
  await itAsync('Entry Point: User with 0 open tickets receives 4-lane button picker', async () => {
    let sentPayload = null;
    const mockDmMessage = {
      author: { id: 'user_new', tag: 'NewUser#0001', username: 'NewUser', bot: false },
      guild: null,
      content: 'I need some help please',
      client,
      attachments: new Map(),
      reply: async (payload) => {
        sentPayload = payload;
        return payload;
      },
    };

    client.users.cache.set('user_new', {
      id: 'user_new',
      tag: 'NewUser#0001',
      send: async (payload) => {
        sentPayload = payload;
        return payload;
      },
    });

    await ticketSystem.handleIncomingDm(mockDmMessage);
    assert.ok(sentPayload);
    assert.strictEqual(sentPayload.components.length, 1);
    const buttons = sentPayload.components[0].components;
    assert.strictEqual(buttons.length, 4);
    assert.strictEqual(buttons[0].data.custom_id, 'ticket_lane_founder');
    assert.strictEqual(buttons[1].data.custom_id, 'ticket_lane_admin');
    assert.strictEqual(buttons[2].data.custom_id, 'ticket_lane_campus_lead');
    assert.strictEqual(buttons[3].data.custom_id, 'ticket_lane_exec');
  });

  await itAsync('Entry Point: /ticket always shows full lane picker regardless of tickets', async () => {
    let sentPayload = null;
    const mockDmMessage = {
      author: { id: 'user_with_ticket', tag: 'TicketUser#0001', username: 'TicketUser', bot: false },
      guild: null,
      content: '/ticket',
      client,
      attachments: new Map(),
      reply: async (payload) => {
        sentPayload = payload;
        return payload;
      },
    };

    client.users.cache.set('user_with_ticket', {
      id: 'user_with_ticket',
      send: async (payload) => {
        sentPayload = payload;
        return payload;
      },
    });

    await ticketSystem.handleIncomingDm(mockDmMessage);
    assert.ok(sentPayload);
    const buttons = sentPayload.components[0].components;
    assert.strictEqual(buttons.length, 4);
    assert.strictEqual(buttons[0].data.label, 'Founder');
    assert.strictEqual(buttons[1].data.label, 'Admin');
    assert.strictEqual(buttons[2].data.label, 'Campus Lead');
    assert.strictEqual(buttons[3].data.label, 'Executive Member');
  });

  // 4. LANE SELECTION & VERIFICATION
  await itAsync('Lane Selection: Exec or Campus Lead requires linked account and stops unlinked user', async () => {
    let replyPayload = null;
    let modalShown = null;

    const mockInteraction = {
      user: { id: 'unlinked_user', tag: 'Unlinked#0001' },
      client,
      reply: async (payload) => {
        replyPayload = payload;
        return payload;
      },
      showModal: async (m) => {
        modalShown = m;
      },
    };

    // Mock unlinked user lookup
    const origGetIdentity = api.getIdentityByDiscordId;
    api.getIdentityByDiscordId = async (id) => null;

    await ticketSystem.handleLaneButtonClick(mockInteraction, 'exec');
    assert.ok(replyPayload);
    assert.ok(replyPayload.embeds[0].data.title.includes('Account Linking Required'));
    assert.strictEqual(modalShown, null, 'Modal must NOT be shown to unlinked user');

    // Restore
    api.getIdentityByDiscordId = origGetIdentity;
  });

  await itAsync('Lane Selection: Founder / Admin activates chat session directly without modal', async () => {
    let updatePayload = null;
    const mockInteraction = {
      user: { id: 'anyone_user', tag: 'Anyone#0001' },
      client,
      update: async (payload) => {
        updatePayload = payload;
      },
      reply: async (payload) => {
        updatePayload = payload;
      },
      showModal: async () => {},
    };

    await ticketSystem.handleLaneButtonClick(mockInteraction, 'founder');
    assert.ok(updatePayload);
    assert.ok(updatePayload.embeds[0].data.description.includes('Chat like normal Discord'));
  });

  // 5. TICKET CREATION & STORAGE
  let createdFounderTicketId = null;
  let createdFounderThreadId = null;

  await itAsync('Modal Submit: creates ticket, forum thread, and stores in discord_tickets', async () => {
    let deferred = false;
    let editReplyPayload = null;

    const mockModalInteraction = {
      customId: 'ticket_modal_founder_global',
      user: { id: 'user_alice', tag: 'Alice#0001', username: 'Alice', displayName: 'Alice' },
      client,
      fields: {
        getTextInputValue: (field) => 'Need urgent help with partnership agreement.',
      },
      deferReply: async () => {
        deferred = true;
      },
      editReply: async (payload) => {
        editReplyPayload = payload;
      },
    };

    await ticketSystem.handleTicketModalSubmit(mockModalInteraction);
    assert.ok(deferred);
    assert.ok(editReplyPayload.content.includes('Your ticket has been submitted to the Founder team!'));

    // Check that open tickets returns the ticket
    const openTickets = await ticketSystem.getOpenTicketsForUser('user_alice');
    assert.strictEqual(openTickets.length, 1);
    const ticket = openTickets[0];
    assert.strictEqual(ticket.lane, 'founder');
    assert.strictEqual(ticket.status, 'open');
    assert.strictEqual(ticket.discord_user_id, 'user_alice');
    createdFounderTicketId = ticket.id;
    createdFounderThreadId = ticket.thread_id;

    // Check thread in discord
    const thread = client.channels.cache.get(ticket.thread_id);
    assert.ok(thread);
    assert.ok(thread.messages.length > 0);
  });

  await itAsync('Constraint: Cannot open two tickets in the same lane simultaneously', async () => {
    let replyPayload = null;
    let modalShown = null;

    const mockInteraction = {
      user: { id: 'user_alice', tag: 'Alice#0001' },
      client,
      reply: async (payload) => {
        replyPayload = payload;
      },
      showModal: async (m) => {
        modalShown = m;
      },
    };

    await ticketSystem.handleLaneButtonClick(mockInteraction, 'founder');
    assert.ok(replyPayload);
    assert.ok(replyPayload.content.includes('You already have an open ticket in the **Founder** category'));
    assert.strictEqual(modalShown, null);
  });

  // 6. SINGLE TICKET DM ROUTING
  await itAsync('Follow-up: User with 1 open ticket DMs plain text -> routes straight to thread', async () => {
    let reaction = null;
    const mockDmMessage = {
      author: { id: 'user_alice', tag: 'Alice#0001', username: 'Alice', displayName: 'Alice', bot: false },
      guild: null,
      content: 'Here is the draft document I mentioned.',
      client,
      attachments: new Map([
        ['att1', { name: 'draft.pdf', url: 'https://cdn.example.com/draft.pdf' }],
      ]),
      react: async (r) => {
        reaction = r;
      },
    };

    await ticketSystem.handleIncomingDm(mockDmMessage);
    assert.strictEqual(reaction, '✅');

    const thread = client.channels.cache.get(createdFounderThreadId);
    assert.ok(thread);
    const lastMsg = thread.messages[thread.messages.length - 1];
    assert.ok(lastMsg.embeds[0].data.description.includes('Here is the draft document'));
    assert.ok(lastMsg.embeds[0].data.fields[0].value.includes('draft.pdf'));
  });

  // 7. MULTIPLE OPEN TICKETS ROUTING
  let createdAdminTicketId = null;
  let createdAdminThreadId = null;

  await itAsync('Creates a second ticket in Admin lane for user_alice', async () => {
    const mockModalInteraction = {
      customId: 'ticket_modal_admin_global',
      user: { id: 'user_alice', tag: 'Alice#0001', username: 'Alice', displayName: 'Alice' },
      client,
      fields: {
        getTextInputValue: (field) => 'Can you please check my roles?',
      },
      deferReply: async () => {},
      editReply: async () => {},
    };

    await ticketSystem.handleTicketModalSubmit(mockModalInteraction);
    const openTickets = await ticketSystem.getOpenTicketsForUser('user_alice');
    assert.strictEqual(openTickets.length, 2, 'user_alice should have 2 open tickets');
    const adminTicket = openTickets.find((t) => t.lane === 'admin');
    createdAdminTicketId = adminTicket.id;
    createdAdminThreadId = adminTicket.thread_id;
  });

  await itAsync('Follow-up: User with >1 open tickets DMs plain text -> prompted to pick ticket', async () => {
    let replyPayload = null;
    const mockDmMessage = {
      author: { id: 'user_alice', tag: 'Alice#0001', username: 'Alice', displayName: 'Alice', bot: false },
      guild: null,
      content: 'Quick update on my inquiry.',
      client,
      attachments: new Map(),
      reply: async (payload) => {
        replyPayload = payload;
      },
    };

    await ticketSystem.handleIncomingDm(mockDmMessage);
    assert.ok(replyPayload);
    assert.ok(replyPayload.embeds[0].data.description.includes('You currently have **2 open tickets**'));
    const buttons = replyPayload.components[0].components;
    assert.strictEqual(buttons.length, 2);

    // Simulate clicking the Admin ticket button
    let routeEditPayload = null;
    const mockRouteInteraction = {
      user: { id: 'user_alice' },
      client,
      deferUpdate: async () => {},
      editReply: async (payload) => {
        routeEditPayload = payload;
      },
    };

    await ticketSystem.handleRouteButtonClick(mockRouteInteraction, createdAdminTicketId);
    assert.ok(routeEditPayload.content.includes('Message routed to your **Admin** ticket'));

    // Verify thread received the message
    const adminThread = client.channels.cache.get(createdAdminThreadId);
    const lastMsg = adminThread.messages[adminThread.messages.length - 1];
    assert.ok(lastMsg.embeds[0].data.description.includes('Quick update on my inquiry'));
  });

  // 8. STAFF REPLIES & PROBLEM SOLVED / NOT YET BUTTONS
  await itAsync('Staff Reply: relays to user DM and sends Problem solved / Not yet buttons', async () => {
    const adminThread = client.channels.cache.get(createdAdminThreadId);
    const staffMember = {
      id: 'staff_admin_1',
      guild: mainGuild,
      roles: {
        cache: new Collection([
          ['admin_role', { name: 'HQ Admin' }],
        ]),
      },
      permissions: { has: () => false },
    };

    const dmMessagesSent = [];
    client.users.cache.set('user_alice', {
      id: 'user_alice',
      send: async (payload) => {
        dmMessagesSent.push(payload);
        return payload;
      },
    });

    let staffReact = null;
    const mockStaffMessage = {
      author: { id: 'staff_admin_1', tag: 'AdminStaff#0001', bot: false },
      member: staffMember,
      guild: mainGuild,
      channel: adminThread,
      content: 'I have checked your roles and updated them!',
      attachments: new Map(),
      client,
      react: async (r) => {
        staffReact = r;
      },
    };

    const handled = await ticketSystem.handleStaffReply(mockStaffMessage);
    assert.strictEqual(handled, true);
    assert.strictEqual(staffReact, '✅');
    assert.strictEqual(dmMessagesSent.length, 2);

    // 1st message is the relayed content
    assert.ok(dmMessagesSent[0].content.includes('**Elevates Admin Team:**\nI have checked your roles'));
    // 2nd message is the Problem solved / Not yet prompt
    assert.strictEqual(dmMessagesSent[1].content, 'Is your problem solved?');
    const buttons = dmMessagesSent[1].components[0].components;
    assert.strictEqual(buttons.length, 3);
    assert.strictEqual(buttons[0].data.label, 'Problem solved');
    assert.strictEqual(buttons[1].data.label, 'Not yet');
    assert.strictEqual(buttons[2].data.label, 'Add Attachment');
  });

  // 9. PROBLEM SOLVED FLOW
  await itAsync('User clicks Problem solved: marks closed, archives thread, sends thank you', async () => {
    let updatePayload = null;
    const mockInteraction = {
      user: { id: 'user_alice' },
      client,
      update: async (payload) => {
        updatePayload = payload;
      },
      deferUpdate: async () => {},
      editReply: async (payload) => {
        updatePayload = payload;
      },
    };

    await ticketSystem.handleSolveButtonClick(mockInteraction, createdAdminTicketId);
    assert.ok(updatePayload);
    assert.ok(updatePayload.content.includes('Your ticket has been marked as solved'));
    assert.deepStrictEqual(updatePayload.components, []);

    // Check thread archived in Discord
    const adminThread = client.channels.cache.get(createdAdminThreadId);
    assert.strictEqual(adminThread.archived, true);

    // Check ticket marked closed in store
    const ticket = await ticketSystem.getTicketByThreadId(createdAdminThreadId);
    assert.strictEqual(ticket.status, 'closed');
    assert.ok(ticket.closed_at);
  });

  // 10. NOT YET FLOW
  await itAsync('User clicks Not yet: wipes buttons, confirms ticket active, next DM routes to thread', async () => {
    let updatePayload = null;
    const mockNotYetButtonInteraction = {
      user: { id: 'user_alice' },
      client,
      update: async (payload) => {
        updatePayload = payload;
      },
      reply: async (payload) => {
        updatePayload = payload;
      },
    };

    await ticketSystem.handleNotYetButtonClick(mockNotYetButtonInteraction, createdFounderTicketId);
    assert.ok(updatePayload);
    assert.deepStrictEqual(updatePayload.components, []);
    assert.ok(updatePayload.embeds[0].data.description.includes('Chat like normal Discord'));

    // User sends their follow-up in DM like normal Discord
    let reaction = null;
    const mockFollowUpDm = {
      author: { id: 'user_alice', tag: 'Alice#0001', username: 'Alice', displayName: 'Alice', bot: false },
      guild: null,
      content: 'Still need help with clause 4B.',
      client,
      attachments: new Map(),
      react: async (r) => {
        reaction = r;
      },
    };

    await ticketSystem.handleIncomingDm(mockFollowUpDm);
    assert.strictEqual(reaction, '✅');

    const founderThread = client.channels.cache.get(createdFounderThreadId);
    const lastMsg = founderThread.messages[founderThread.messages.length - 1];
    assert.ok(lastMsg.embeds[0].data.description.includes('Still need help with clause 4B'));
  });

  // 11. STAFF-SIDE CLOSE
  await itAsync('Staff close: archives thread, closes in store, sends DM to user without solved? prompt', async () => {
    const founderThread = client.channels.cache.get(createdFounderThreadId);
    const founderMember = {
      id: 'founder_user_1',
      guild: mainGuild,
      roles: {
        cache: new Collection([
          ['founder_role', { name: 'Founder' }],
        ]),
      },
      permissions: { has: () => false },
    };

    let userDmSent = null;
    client.users.cache.set('user_alice', {
      id: 'user_alice',
      send: async (payload) => {
        userDmSent = payload;
        return payload;
      },
    });

    mainGuild.members.cache.set('founder_user_1', founderMember);

    let interactionReply = null;
    const mockCloseCmdInteraction = {
      channel: founderThread,
      user: { id: 'founder_user_1' },
      member: founderMember,
      client,
      deferReply: async () => {},
      editReply: async (payload) => {
        interactionReply = payload;
      },
      reply: async (payload) => {
        interactionReply = payload;
      },
    };

    const success = await ticketSystem.handleStaffClose(founderThread, founderMember, mockCloseCmdInteraction);
    assert.strictEqual(success, true);
    assert.ok(founderThread.archived);

    // Ticket closed
    const ticket = await ticketSystem.getTicketByThreadId(createdFounderThreadId);
    assert.strictEqual(ticket.status, 'closed');

    // Check user received direct closure DM (with no buttons)
    assert.ok(userDmSent.includes('Your support ticket has been closed by staff'));
  });

  // 12. UNAUTHORIZED STAFF CLOSE REJECTION
  await itAsync('Rejects close attempt by unauthorized member', async () => {
    // Create new ticket
    const newRecord = await ticketSystem.createTicketRecord({
      discordUserId: 'user_bob',
      lane: 'founder',
      chapterId: null,
      forumChannelId: 'main_founder_forum',
      threadId: 'th_bob_founder',
    });

    const thread = createMockThread('th_bob_founder', 'Bob Founder', { id: 'main_founder_forum' }, mainGuild, client);
    client.channels.cache.set('th_bob_founder', thread);

    const nonStaffMember = {
      id: 'random_user',
      guild: mainGuild,
      roles: { cache: new Collection() },
      permissions: { has: () => false },
    };
    mainGuild.members.cache.set('random_user', nonStaffMember);

    let errorReply = null;
    const mockInteraction = {
      channel: thread,
      user: { id: 'random_user' },
      member: nonStaffMember,
      client,
      reply: async (payload) => {
        errorReply = payload;
      },
    };

    const success = await ticketSystem.handleStaffClose(thread, nonStaffMember, mockInteraction);
    assert.strictEqual(success, false);
    assert.ok(errorReply.content.includes('Only authorized Founder staff can close this ticket'));
  });

  // 13. ONE POST PER USER PER LANE: REOPEN AND REUSE EXISTING THREAD
  await itAsync('One post per user per lane: new modal submit reuses existing forum thread and unarchives it', async () => {
    // user_alice previously had createdFounderThreadId which was closed and archived in test 11.
    const founderThread = client.channels.cache.get(createdFounderThreadId);
    assert.strictEqual(founderThread.archived, true, 'Thread should be archived before reopening');

    const prevMessageCount = founderThread.messages.length;
    let editReplyPayload = null;

    const mockModalInteraction = {
      customId: 'ticket_modal_founder_global',
      user: { id: 'user_alice', tag: 'Alice#0001', username: 'Alice', displayName: 'Alice' },
      client,
      fields: {
        getTextInputValue: (field) => 'Following up on another founder question later!',
      },
      deferReply: async () => {},
      editReply: async (payload) => {
        editReplyPayload = payload;
      },
    };

    await ticketSystem.handleTicketModalSubmit(mockModalInteraction);
    assert.ok(editReplyPayload.content.includes('Your message has been updated in your Founder ticket thread!'));

    // Verify thread unarchived
    assert.strictEqual(founderThread.archived, false, 'Thread must be unarchived');

    // Verify new message was sent to the same thread
    assert.strictEqual(founderThread.messages.length, prevMessageCount + 1);
    const latestMsg = founderThread.messages[founderThread.messages.length - 1];
    assert.ok(latestMsg.embeds[0].data.title.includes('Ticket Reopened'));
    assert.ok(latestMsg.embeds[0].data.description.includes('Following up on another founder question later!'));

    // Verify ticket status in store is open again
    const ticket = await ticketSystem.getTicketByThreadId(createdFounderThreadId);
    assert.strictEqual(ticket.status, 'open');
  });

  // 14. CHAT-LIKE-NORMAL-DISCORD FLOW
  await itAsync('Chat-native Flow: clicking lane button activates chat, subsequent DM creates ticket with attachment', async () => {
    let buttonUpdate = null;
    const mockButtonInteraction = {
      user: { id: 'user_chat_flow', tag: 'ChatUser#0001' },
      client,
      update: async (p) => {
        buttonUpdate = p;
      },
      reply: async (p) => {
        buttonUpdate = p;
      },
    };

    await ticketSystem.handleLaneButtonClick(mockButtonInteraction, 'founder');
    assert.ok(buttonUpdate);
    assert.ok(buttonUpdate.embeds[0].data.description.includes('Chat like normal Discord'));

    // Now user sends a message with an attached file like normal Discord
    let reaction = null;
    const mockDm = {
      author: { id: 'user_chat_flow', tag: 'ChatUser#0001', username: 'ChatUser', displayName: 'ChatUser', bot: false },
      guild: null,
      content: 'Here is my inquiry with attachment',
      client,
      attachments: new Map([
        ['att1', { name: 'invoice.pdf', url: 'https://example.com/invoice.pdf', contentType: 'application/pdf' }],
      ]),
      react: async (r) => {
        reaction = r;
      },
    };

    client.users.cache.set('user_chat_flow', {
      id: 'user_chat_flow',
      tag: 'ChatUser#0001',
      send: async (p) => p,
    });

    await ticketSystem.handleIncomingDm(mockDm);
    assert.strictEqual(reaction, '✅');

    const openTickets = await ticketSystem.getOpenTicketsForUser('user_chat_flow');
    assert.strictEqual(openTickets.length, 1);
    assert.strictEqual(openTickets[0].lane, 'founder');

    const thread = client.channels.cache.get(openTickets[0].thread_id);
    assert.ok(thread);
    const starter = thread.messages[0];
    assert.ok(starter.embeds[0].data.description.includes('Here is my inquiry with attachment'));
    assert.deepStrictEqual(starter.files, ['https://example.com/invoice.pdf']);
  });

  // 15. ADD ATTACHMENT BUTTON AND MODAL
  await itAsync('Add Attachment Flow: clicking Add Attachment opens modal, submitting posts to thread', async () => {
    let modalShown = null;
    const mockAttachButtonInteraction = {
      user: { id: 'user_alice' },
      client,
      showModal: async (m) => {
        modalShown = m;
      },
    };

    await ticketSystem.handleAttachButtonClick(mockAttachButtonInteraction, createdFounderTicketId);
    assert.ok(modalShown);
    assert.strictEqual(modalShown.data.custom_id, `ticket_attach_modal_${createdFounderTicketId}`);

    const founderThread = client.channels.cache.get(createdFounderThreadId);
    const prevMsgCount = founderThread.messages.length;
    let editReplyPayload = null;

    const mockAttachModalSubmit = {
      customId: `ticket_attach_modal_${createdFounderTicketId}`,
      user: { id: 'user_alice', tag: 'Alice#0001', displayName: 'Alice' },
      client,
      fields: {
        getTextInputValue: (field) => {
          if (field === 'attachment_url') return 'https://example.com/screenshot.png';
          if (field === 'attachment_note') return 'Screenshot of the error banner';
          return '';
        },
      },
      deferReply: async () => {},
      editReply: async (payload) => {
        editReplyPayload = payload;
      },
    };

    await ticketSystem.handleAttachModalSubmit(mockAttachModalSubmit);
    assert.ok(editReplyPayload.content.includes('Your attachment has been sent to our team!'));
    assert.strictEqual(founderThread.messages.length, prevMsgCount + 1);

    const attachMsg = founderThread.messages[founderThread.messages.length - 1];
    assert.ok(attachMsg.embeds[0].data.title.includes('Attachment Added by User'));
    assert.ok(attachMsg.embeds[0].data.description.includes('Screenshot of the error banner'));
    assert.strictEqual(attachMsg.embeds[0].data.image.url, 'https://example.com/screenshot.png');
    assert.deepStrictEqual(attachMsg.files, ['https://example.com/screenshot.png']);
  });

  // 16. INITIAL DM WITH ATTACHMENT FORWARDED TO NEW TICKET
  await itAsync('Initial DM with attachment: forwarded into newly created ticket thread', async () => {
    let sentPickerPayload = null;
    const mockDmMessage = {
      author: { id: 'user_with_photo', tag: 'PhotoUser#0001', username: 'PhotoUser', bot: false },
      guild: null,
      content: 'Here is the bug I found',
      client,
      attachments: new Map([
        ['att1', { name: 'bug_report.png', url: 'https://example.com/bug_report.png', contentType: 'image/png' }],
      ]),
      reply: async (payload) => {
        sentPickerPayload = payload;
        return payload;
      },
    };

    client.users.cache.set('user_with_photo', {
      id: 'user_with_photo',
      tag: 'PhotoUser#0001',
      send: async (payload) => payload,
    });

    await ticketSystem.handleIncomingDm(mockDmMessage);
    assert.ok(sentPickerPayload);

    // Now submit modal for Founder lane
    let modalEditReply = null;
    const mockModalSubmit = {
      customId: 'ticket_modal_founder_global',
      user: { id: 'user_with_photo', tag: 'PhotoUser#0001', username: 'PhotoUser', displayName: 'PhotoUser' },
      client,
      fields: {
        getTextInputValue: (field) => {
          if (field === 'issue_description') return 'Found a visual bug on dashboard';
          return '';
        },
      },
      deferReply: async () => {},
      editReply: async (payload) => {
        modalEditReply = payload;
      },
    };

    await ticketSystem.handleTicketModalSubmit(mockModalSubmit);
    assert.ok(modalEditReply.content.includes('Your ticket has been submitted to the Founder team!'));

    const openTickets = await ticketSystem.getOpenTicketsForUser('user_with_photo');
    assert.strictEqual(openTickets.length, 1);
    const newThread = client.channels.cache.get(openTickets[0].thread_id);
    assert.ok(newThread);
    const starterMsg = newThread.messages[0];
    assert.ok(starterMsg.embeds[0].data.fields.some((f) => f.name.includes('Attachments')));
    assert.strictEqual(starterMsg.embeds[0].data.image.url, 'https://example.com/bug_report.png');
    assert.deepStrictEqual(starterMsg.files, ['https://example.com/bug_report.png']);
  });

  // ----------------------------------------------------
  // TEST 21: sanitizeChapterId correctly handles all lanes
  // ----------------------------------------------------
  it('sanitizeChapterId enforces null for founder & admin and preserves valid UUIDs for chapter lanes', () => {
    assert.strictEqual(ticketSystem.sanitizeChapterId('founder', 'global'), null);
    assert.strictEqual(ticketSystem.sanitizeChapterId('founder', '550e8400-e29b-41d4-a716-446655440000'), null);
    assert.strictEqual(ticketSystem.sanitizeChapterId('admin', 'global'), null);
    assert.strictEqual(ticketSystem.sanitizeChapterId('admin', null), null);

    assert.strictEqual(ticketSystem.sanitizeChapterId('exec', 'global'), null);
    assert.strictEqual(ticketSystem.sanitizeChapterId('exec', '   '), null);
    assert.strictEqual(ticketSystem.sanitizeChapterId('exec', '550e8400-e29b-41d4-a716-446655440000'), '550e8400-e29b-41d4-a716-446655440000');
    assert.strictEqual(ticketSystem.sanitizeChapterId('campus_lead', '550e8400-e29b-41d4-a716-446655440000'), '550e8400-e29b-41d4-a716-446655440000');
  });

  // ----------------------------------------------------
  // TEST 22: One Post Per User Per Lane via forum scan fallback
  // ----------------------------------------------------
  await itAsync('One post per user per lane: forum thread scan reuses existing Discord thread even without DB record', async () => {
    const mainGuild = client.guilds.cache.get('1544247855173345310');
    const founderForum = mainGuild.channels.cache.get('1544247855173345310_ch_founder-tickets');

    // Create an existing Discord thread on the forum directly (as if from earlier session)
    const existingThread = {
      id: 'thread_scan_test_123',
      name: '💬 ScanUser (Founder)',
      archived: true,
      joinable: true,
      messages: [],
      setArchived: async function (val) {
        this.archived = val;
      },
      join: async function () {},
      send: async function (payload) {
        this.messages.push(payload);
        return payload;
      },
    };
    founderForum.threads.cache.set(existingThread.id, existingThread);
    client.channels.cache.set(existingThread.id, existingThread);

    const scanUser = {
      id: 'user_scan_test',
      username: 'ScanUser',
      displayName: 'ScanUser',
      tag: 'ScanUser#0001',
      send: async () => {},
    };
    client.users.cache.set(scanUser.id, scanUser);

    let initialThreadCount = founderForum.threads.cache.size;

    // Call createOrReopenTicket with 'global' chapterId
    await ticketSystem.createOrReopenTicket(
      client,
      scanUser,
      'founder',
      'global',
      'Follow-up message that must go into the existing post'
    );

    // Thread count on forum should NOT increase (no new post created)
    assert.strictEqual(founderForum.threads.cache.size, initialThreadCount);
    // Existing thread must have been unarchived
    assert.strictEqual(existingThread.archived, false);
    // Existing thread must have received the reopen message
    assert.strictEqual(existingThread.messages.length, 1);
    assert.ok(existingThread.messages[0].embeds[0].data.title.includes('Ticket Reopened'));
  });

  console.log(`\n========================================`);
  console.log(`ALL TESTS PASSED! (${passedTests}/${totalTests} tests)`);
  console.log(`========================================\n`);
}

runTests().catch((err) => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
