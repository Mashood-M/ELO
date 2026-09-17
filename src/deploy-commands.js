const fs = require('fs');
const path = require('path');
const { REST, Routes } = require('discord.js');
const config = require('./config');

const commands = [];
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter((f) => f.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  commands.push(command.data.toJSON());
}

const rest = new REST().setToken(config.token);

(async () => {
  try {
    console.log(`Registering ${commands.length} application (/) commands...`);
    await rest.put(Routes.applicationCommands(config.clientId), { body: commands });
    console.log('Done. Commands may take up to an hour to appear globally (instant in dev guilds).');
  } catch (err) {
    console.error(err);
  }
})();
