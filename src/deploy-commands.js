const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');
const config = require('./config');

// --- Build deduplicated command list ---
// Commands are deduplicated by name — last file wins if two files define the same name.
const commandMap = new Map();
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'));

console.log(`Loading command definitions from ${commandsPath}...`);
for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  if (!command.data || typeof command.execute !== 'function') {
    console.warn(`[WARN] Skipping ${file}: missing 'data' or 'execute' export.`);
    continue;
  }
  const name = command.data.name;
  if (commandMap.has(name)) {
    console.warn(`[WARN] Duplicate command name "${name}" in ${file} — keeping first registered, skipping duplicate.`);
    continue;
  }
  commandMap.set(name, command.data.toJSON());
  console.log(`  ✓ Loaded command: ${name} (${file})`);
}

const commands = Array.from(commandMap.values());
console.log(`\nTotal unique commands to deploy: ${commands.length} [${commands.map((c) => c.name).join(', ')}]`);

const rest = new REST().setToken(config.token);

// Global commands: only /ticket and /connect work in DMs
const GLOBAL_COMMANDS = ['ticket', 'connect'];

async function deploy() {
  try {
    // --- Step 1: Deploy global commands (DM-accessible) ---
    console.log('\n--- Step 1: Deploying Global Commands (DM-accessible) ---');
    const globalCommands = commands.filter((c) => GLOBAL_COMMANDS.includes(c.name));
    await rest.put(Routes.applicationCommands(config.clientId), { body: globalCommands });
    console.log(`✓ Deployed ${globalCommands.length} global command(s): [${globalCommands.map((c) => c.name).join(', ')}]`);

    // --- Step 2: Resolve target guilds ---
    console.log('\n--- Step 2: Resolving Target Guilds ---');
    const targetGuildIds = new Set();

    if (config.mainGuildId) targetGuildIds.add(config.mainGuildId);
    if (process.env.GUILD_ID) targetGuildIds.add(process.env.GUILD_ID);

    // CLI argument: node src/deploy-commands.js <guildId>
    const cliGuildArg = process.argv.slice(2).find((arg) => /^\d{17,20}$/.test(arg));
    if (cliGuildArg) targetGuildIds.add(cliGuildArg);

    try {
      const userGuilds = await rest.get(Routes.userGuilds());
      for (const g of userGuilds) targetGuildIds.add(g.id);
      console.log(`Discovered ${userGuilds.length} guild(s) via Discord API.`);
    } catch (err) {
      console.warn(`Could not fetch bot user guilds: ${err.message}. Using configured guilds only.`);
    }

    if (targetGuildIds.size === 0) {
      console.error('❌ No target guilds found. Ensure MAIN_GUILD_ID is set in .env.');
      process.exit(1);
    }

    console.log(`Deploying to ${targetGuildIds.size} guild(s): [${Array.from(targetGuildIds).join(', ')}]`);

    // --- Step 3: Deploy to all guilds in parallel ---
    console.log('\n--- Step 3: Deploying Guild-Specific Commands (Parallel) ---');
    const results = await Promise.allSettled(
      Array.from(targetGuildIds).map(async (guildId) => {
        const result = await rest.put(
          Routes.applicationGuildCommands(config.clientId, guildId),
          { body: commands }
        );
        console.log(`  ✓ Guild ${guildId}: deployed ${result.length} commands [${result.map((c) => c.name).join(', ')}]`);
        return { guildId, count: result.length };
      })
    );

    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      console.warn(`\n⚠️ ${failed.length} guild(s) failed to deploy:`);
      failed.forEach((r) => console.warn(' ', r.reason?.message || r.reason));
    }

    console.log('\n✅ Command deployment complete!');
    console.log('Tip: If Discord still shows old commands, fully close + reopen Discord to clear its UI cache.');
  } catch (err) {
    console.error('❌ Deployment error:', err);
    process.exit(1);
  }
}

/**
 * Deploy all commands to a single guild. Used by guildCreate event to
 * instantly register commands when the bot joins a new server.
 */
async function deployToGuild(guildId) {
  if (!guildId) return [];
  const restClient = new REST().setToken(config.token);
  return restClient.put(
    Routes.applicationGuildCommands(config.clientId, guildId),
    { body: commands }
  );
}

if (require.main === module) {
  deploy();
}

module.exports = { deploy, deployToGuild, commands };
