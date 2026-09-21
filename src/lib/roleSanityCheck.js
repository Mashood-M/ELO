const config = require('../config');
const api = require('./api');

/**
 * Checks the main guild's roles against the expected fixed list size.
 * Logs a warning if the main guild's custom role count exceeds the expected fixed list size,
 * or if unexpected roles are detected.
 *
 * @param {import('discord.js').Client} client
 */
async function checkMainGuildRoleSanity(client) {
  if (!client) return;

  try {
    const mainConfig = await api.getMainGuildConfig();
    const mainGuildId = mainConfig?.guildId || config.mainGuildId;
    if (!mainGuildId) return;

    let guild = client.guilds.cache.get(mainGuildId);
    if (!guild) {
      guild = await client.guilds.fetch(mainGuildId).catch(() => null);
    }
    if (!guild) {
      console.warn(`[RoleSanityCheck] Main guild (${mainGuildId}) not found in bot's guilds.`);
      return;
    }

    const roles = await guild.roles.fetch();
    const allowedSet = new Set([
      ...config.mainRoles.allowedRoles,
      'ELEVATES • Founder', // Permitted legacy alias for Founder
      'ELEVATES • Admin',   // Permitted legacy alias for HQ Admin
    ]);

    const unexpectedRoles = [];
    let customRoleCount = 0;

    for (const [, role] of roles) {
      // Ignore Discord's native @everyone
      if (role.id === guild.roles.everyone.id || role.name === '@everyone') continue;
      // Ignore bot integration / managed roles
      if (role.managed || role.tags?.botId || role.name === 'ELEVATES • Bot') continue;

      customRoleCount++;
      if (!allowedSet.has(role.name)) {
        unexpectedRoles.push(`"${role.name}" (ID: ${role.id})`);
      }
    }

    const expectedCount = allowedSet.size;
    if (customRoleCount > expectedCount || unexpectedRoles.length > 0) {
      console.warn(
        `⚠️ [RoleSanityCheck] WARNING: Main guild "${guild.name}" (${guild.id}) role drift detected!\n` +
        `   • Expected maximum custom roles: ${expectedCount} (${config.mainRoles.allowedRoles.join(', ')})\n` +
        `   • Current custom roles count: ${customRoleCount}\n` +
        `   • Unexpected roles found (${unexpectedRoles.length}): ${unexpectedRoles.join(', ')}`
      );
    } else {
      console.log(`[RoleSanityCheck] Main guild "${guild.name}" role sanity check PASSED (${customRoleCount}/${expectedCount} roles).`);
    }
  } catch (err) {
    console.error('[RoleSanityCheck] Error running sanity check:', err.message);
  }
}

module.exports = {
  checkMainGuildRoleSanity,
};
