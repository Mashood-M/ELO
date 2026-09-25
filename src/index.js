const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

// Configure global undici dispatcher to handle connect timeouts gracefully
try {
  const { setGlobalDispatcher, Agent } = require('undici');
  setGlobalDispatcher(
    new Agent({
      connect: {
        timeout: 30000,
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: 250,
      },
    })
  );
} catch (_) {}

// Process-level handlers to keep bot resilient against transient network timeouts
process.on('unhandledRejection', (reason) => {
  console.warn('[Global] Unhandled Rejection:', reason?.message || reason);
});

process.on('uncaughtException', (err) => {
  if (
    err?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
    err?.code === 'ETIMEDOUT' ||
    err?.code === 'ECONNRESET' ||
    err?.message?.includes('Connect Timeout Error')
  ) {
    console.warn('[Global] Suppressed transient network connect timeout:', err.message);
    return;
  }
  console.error('[Global] Uncaught Exception:', err);
});

const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Partials, Collection, Events } = require('discord.js');
const config = require('./config');

// Ensure single running instance of bot process
const PID_FILE = path.join(__dirname, '../data/bot.pid');
function acquireBotLock() {
  try {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    if (fs.existsSync(PID_FILE)) {
      const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
      if (oldPid && oldPid !== process.pid) {
        try {
          process.kill(oldPid, 0); // check if alive
          console.log(`[Startup] Found previous bot process PID ${oldPid}. Terminating to prevent duplicate listeners...`);
          process.kill(oldPid, 'SIGKILL');
        } catch (_) {
          // Process not running
        }
      }
    }
    fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');
  } catch (err) {
    console.warn('[Startup] Warning acquiring bot PID lock:', err.message);
  }
}
acquireBotLock();

process.on('exit', () => {
  try {
    if (fs.existsSync(PID_FILE)) {
      const cur = parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
      if (cur === process.pid) fs.unlinkSync(PID_FILE);
    }
  } catch (_) {}
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,      // required for join/leave events + role management
    GatewayIntentBits.GuildModeration,   // required for ban/unban + audit logs
    GatewayIntentBits.GuildMessages,     // required for message events
    GatewayIntentBits.GuildVoiceStates,  // required for voice channel activity
    GatewayIntentBits.GuildInvites,      // required for invite tracking
    GatewayIntentBits.DirectMessages,    // required to receive DM verification replies & tickets
    GatewayIntentBits.MessageContent,    // required to read message content (deletes/edits/DMs)
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember, Partials.User],
  rest: {
    timeout: 30000,
    retries: 5,
  },
});

// Load commands
client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'))) {
  const command = require(path.join(commandsPath, file));
  client.commands.set(command.data.name, command);
}

// Load events
const eventsPath = path.join(__dirname, 'events');
for (const file of fs.readdirSync(eventsPath).filter((f) => f.endsWith('.js'))) {
  const event = require(path.join(eventsPath, file));
  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args));
  } else {
    client.on(event.name, (...args) => event.execute(...args));
  }
}

const { initRealtimeSync } = require('./lib/realtime');
const { startServer } = require('./server');
const { checkMainGuildRoleSanity } = require('./lib/roleSanityCheck');
const { ensureAllMainTicketForums } = require('./lib/ticketSystem');

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}. Serving ${client.guilds.cache.size} guild(s).`);
  await checkMainGuildRoleSanity(client);
  initRealtimeSync(client);
  try {
    await ensureAllMainTicketForums(client);
    console.log('[Startup] Main server ticket forums (Founder & Admin) initialized.');
  } catch (ticketErr) {
    console.error('[Startup] ❌ Error initializing ticket forums:', ticketErr);
  }
});

client.login(config.token);
