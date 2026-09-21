const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');
const config = require('./config');

const commands = [];
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'));

console.log(`Loading command definitions from ${commandsPath}...`);
for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  if (!command.data || typeof command.execute !== 'function') {
    console.warn(`[WARN] Skipping ${file}: missing 'data' or 'execute' export.`);
    continue;
  }
  commands.push(command.data.toJSON());
  console.log(`  ✓ Loaded command: ${command.data.name} (${file})`);
}

const rest = new REST().setToken(config.token);

async function deploy() {
  try {
    console.log('\n--- Step 1: Cleaning Up Global Commands ---');
    console.log('Wiping all global application commands to prevent duplicate command listings in Discord...');
    await rest.put(Routes.applicationCommands(config.clientId), { body: [] });
    console.log('✓ Successfully cleared all global commands (0 global commands active).');

    console.log('\n--- Step 2: Resolving Target Guilds for Guild-Specific Registration ---');
    const targetGuildIds = new Set();

    if (config.mainGuildId) {
      targetGuildIds.add(config.mainGuildId);
    }
    if (process.env.GUILD_ID) {
      targetGuildIds.add(process.env.GUILD_ID);
    }

    // Process CLI arguments (e.g. node src/deploy-commands.js <guildId>)
    const cliGuildArg = process.argv.slice(2).find((arg) => /^\d{17,20}$/.test(arg));
    if (cliGuildArg) {
      targetGuildIds.add(cliGuildArg);
    }

    try {
      const userGuilds = await rest.get(Routes.userGuilds());
      for (const g of userGuilds) {
        targetGuildIds.add(g.id);
      }
      console.log(`Discovered ${userGuilds.length} guild(s) via Discord API.`);
    } catch (err) {
      console.warn(`Could not fetch bot user guilds: ${err.message}. Using configured guilds.`);
    }

    if (targetGuildIds.size === 0) {
      console.error('❌ No target guilds found to deploy commands to. Ensure MAIN_GUILD_ID is set in .env.');
      process.exit(1);
    }

    console.log(`Deploying to ${targetGuildIds.size} guild(s): ${Array.from(targetGuildIds).join(', ')}`);

    console.log('\n--- Step 3: Deploying Commands via Atomic PUT ---');
    for (const guildId of targetGuildIds) {
      console.log(`Deploying ${commands.length} commands to guild: ${guildId}...`);
      const result = await rest.put(
        Routes.applicationGuildCommands(config.clientId, guildId),
        { body: commands }
      );
      console.log(`✓ Successfully deployed ${result.length} commands to guild ${guildId}:`);
      console.log(`  [${result.map((c) => c.name).join(', ')}]`);
    }

    console.log('\n✅ Command deployment complete! All commands deployed guild-specifically with instant propagation.');
    console.log('Tip: If Discord UI still shows cached commands, fully close and restart the Discord desktop/mobile app to clear its client cache.');
  } catch (err) {
    console.error('❌ Deployment error:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  deploy();
}

module.exports = { deploy };

