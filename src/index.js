const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Partials, Collection, Events } = require('discord.js');
const config = require('./config');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,      // required for join/leave events + role management
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,    // required to receive DM verification replies
    GatewayIntentBits.MessageContent,    // required to read DM content
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember, Partials.User],
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

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}. Serving ${client.guilds.cache.size} guild(s).`);
  await checkMainGuildRoleSanity(client);
  initRealtimeSync(client);
  startServer(client);
});

client.login(config.token);
