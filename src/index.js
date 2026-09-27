const dns = require('dns');
const net = require('net');

dns.setDefaultResultOrder('ipv4first');
if (typeof net.setDefaultAutoSelectFamily === 'function') {
  net.setDefaultAutoSelectFamily(false);
}

// Configure global undici dispatcher to handle connect timeouts gracefully and enforce IPv4
try {
  const { setGlobalDispatcher, Agent } = require('undici');
  setGlobalDispatcher(
    new Agent({
      connect: {
        timeout: 30000,
        autoSelectFamily: false, // Explicitly disable dual-stack happy eyeballs to avoid EHOSTUNREACH on IPv6 NAT64
      },
    })
  );
} catch (_) {}

function isTransientNetworkError(err) {
  return (
    err?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
    err?.code === 'ETIMEDOUT' ||
    err?.code === 'ECONNRESET' ||
    err?.code === 'EHOSTUNREACH' ||
    err?.message?.includes('ETIMEDOUT') ||
    err?.message?.includes('Connect Timeout Error') ||
    (err instanceof AggregateError && err.errors?.some((e) => e?.code === 'ETIMEDOUT' || e?.code === 'EHOSTUNREACH'))
  );
}

// Process-level handlers to keep bot resilient against transient network timeouts
process.on('unhandledRejection', (reason) => {
  if (isTransientNetworkError(reason)) {
    console.warn('[Global] Suppressed transient network connect timeout rejection:', reason?.message || reason?.code || 'ETIMEDOUT');
    return;
  }
  console.warn('[Global] Unhandled Rejection:', reason?.stack || reason?.message || reason);
});

process.on('uncaughtException', (err) => {
  if (isTransientNetworkError(err)) {
    console.warn('[Global] Suppressed transient network connect timeout:', err?.message || err?.code || 'ETIMEDOUT');
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

// Load commands — deduplicated by name (first file wins; warns on collision)
client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'))) {
  const command = require(path.join(commandsPath, file));
  if (!command.data || typeof command.execute !== 'function') {
    console.warn(`[Startup] Skipping ${file}: missing 'data' or 'execute'.`);
    continue;
  }
  if (client.commands.has(command.data.name)) {
    console.warn(`[Startup] Duplicate command name "${command.data.name}" in ${file} — skipping.`);
    continue;
  }
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

// Resilient login with automatic retry on transient network failures
async function startBot(maxRetries = 10, retryDelayMs = 5000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Startup] Connecting to Discord Gateway (attempt ${attempt}/${maxRetries})...`);
      await client.login(config.token);
      return;
    } catch (err) {
      console.error(`[Startup] Discord connection failed (attempt ${attempt}/${maxRetries}):`, err?.message || err?.code || err);
      if (attempt === maxRetries) {
        console.error('[Startup] Maximum login attempts reached. Check internet connection and Discord bot token.');
        process.exit(1);
      }
      console.log(`[Startup] Retrying Discord connection in ${retryDelayMs / 1000} seconds...`);
      await new Promise((res) => setTimeout(res, retryDelayMs));
    }
  }
}

startBot();
