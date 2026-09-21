/**
 * One-time cleanup script for the Elevates Main Server roles.
 *
 * Removes every role that is NOT in the fixed allowed list:
 * - Founder
 * - HQ Admin
 * - Community Manager
 * - Campus Lead
 * - Class Rep
 * - Verified Member
 * - Guest
 * - Unverified
 *
 * Preserves Discord's own @everyone and bot integration roles (e.g. ELEVATES • Bot, managed roles).
 *
 * Usage:
 *   node scripts/cleanup-main-server-roles.js           # Dry-run mode (prints what it WOULD delete)
 *   node scripts/cleanup-main-server-roles.js --confirm # Actually executes deletions
 */

const { Client, GatewayIntentBits } = require('discord.js');
const config = require('../src/config');
const api = require('../src/lib/api');

async function main() {
  const isConfirmed = process.argv.includes('--confirm');

  console.log('============================================================');
  console.log('      Elevates Main Server Role Cleanup Script');
  console.log('============================================================');
  if (isConfirmed) {
    console.log('⚡ MODE: CONFIRMED (--confirm passed). Roles WILL be deleted.');
  } else {
    console.log('🔍 MODE: DRY-RUN (Pass --confirm to actually delete roles).');
  }
  console.log('============================================================\n');

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.once('clientReady', async () => {
    try {
      console.log(`[Bot] Logged in as ${client.user.tag}.`);

      // 1. Resolve Main Guild
      const mainConfig = await api.getMainGuildConfig();
      const mainGuildId = mainConfig?.guildId || config.mainGuildId;

      if (!mainGuildId) {
        console.error('❌ Could not determine Main Guild ID from guild_config or config.mainGuildId.');
        process.exit(1);
      }

      const guild = client.guilds.cache.get(mainGuildId) ||
        (await client.guilds.fetch(mainGuildId).catch(() => null));

      if (!guild) {
        console.error(`❌ Main Guild (${mainGuildId}) not found among bot's accessible guilds.`);
        process.exit(1);
      }

      console.log(`[Guild] Target Main Server: "${guild.name}" (${guild.id})\n`);

      const me = await guild.members.fetchMe();
      console.log(`[Permissions] Bot highest role: "${me.roles.highest.name}" (pos: ${me.roles.highest.position})`);
      console.log(`[Permissions] Bot has Administrator: ${me.permissions.has('Administrator')}\n`);

      // 2. Fetch all roles
      const roles = await guild.roles.fetch();
      console.log(`[Roles] Total roles found in server: ${roles.size}\n`);

      const allowedRoles = new Set(config.mainRoles.allowedRoles);

      const keptRoles = [];
      const wouldDeleteRoles = [];
      const deletedRoles = [];
      const skippedRoles = [];

      // Sort roles by position descending
      const sortedRoles = Array.from(roles.values()).sort((a, b) => b.position - a.position);

      for (const role of sortedRoles) {
        // Discord's own @everyone
        if (role.id === guild.roles.everyone.id || role.name === '@everyone') {
          keptRoles.push({ name: role.name, id: role.id, reason: 'Discord base @everyone' });
          continue;
        }

        // Managed bot roles (e.g. integration role 'elevates')
        if (role.managed) {
          keptRoles.push({ name: role.name, id: role.id, reason: 'Managed integration/bot role' });
          continue;
        }

        // Explicit bot roles
        if (role.name === 'ELEVATES • Bot' || role.tags?.botId) {
          keptRoles.push({ name: role.name, id: role.id, reason: 'Bot role' });
          continue;
        }

        // Allowed fixed roles
        if (allowedRoles.has(role.name)) {
          keptRoles.push({ name: role.name, id: role.id, reason: 'Allowed fixed role' });
          continue;
        }

        // Preserve Founder role if named ELEVATES • Founder
        if (role.name === 'ELEVATES • Founder') {
          keptRoles.push({ name: role.name, id: role.id, reason: 'Allowed Founder role variant' });
          continue;
        }

        // Check if role is higher than bot's highest role
        if (!role.editable) {
          skippedRoles.push({
            name: role.name,
            id: role.id,
            reason: `Role position (${role.position}) >= bot role (${me.roles.highest.position}); cannot be deleted by bot`,
          });
          continue;
        }

        // Role is NOT in allowed list and CAN be deleted
        if (isConfirmed) {
          try {
            console.log(`🗑️  [DELETING] "${role.name}" (ID: ${role.id}, Position: ${role.position})...`);
            await role.delete('Main server cleanup: not in fixed allowed role list');
            deletedRoles.push({ name: role.name, id: role.id });
            // Small delay to avoid Discord rate-limits
            await new Promise((resolve) => setTimeout(resolve, 300));
          } catch (delErr) {
            console.error(`❌ Failed to delete role "${role.name}":`, delErr.message);
            skippedRoles.push({ name: role.name, id: role.id, reason: `Deletion error: ${delErr.message}` });
          }
        } else {
          console.log(`⚠️  [WOULD DELETE] "${role.name}" (ID: ${role.id}, Position: ${role.position})`);
          wouldDeleteRoles.push({ name: role.name, id: role.id });
        }
      }

      console.log('\n============================================================');
      console.log('                     CLEANUP SUMMARY');
      console.log('============================================================');
      console.log(`✅ Roles kept (${keptRoles.length}):`);
      keptRoles.forEach((r) => console.log(`   • ${r.name} (${r.reason})`));

      if (isConfirmed) {
        console.log(`\n🗑️  Roles successfully deleted (${deletedRoles.length}):`);
        deletedRoles.forEach((r) => console.log(`   • ${r.name} (ID: ${r.id})`));
      } else {
        console.log(`\n⚠️  Roles that WOULD be deleted (${wouldDeleteRoles.length}):`);
        wouldDeleteRoles.forEach((r) => console.log(`   • ${r.name} (ID: ${r.id})`));
        console.log('\n👉 To execute deletions, run with --confirm:');
        console.log('   node scripts/cleanup-main-server-roles.js --confirm');
      }

      if (skippedRoles.length > 0) {
        console.log(`\n⚠️  Roles skipped (${skippedRoles.length}):`);
        skippedRoles.forEach((r) => console.log(`   • ${r.name}: ${r.reason}`));
      }
      console.log('============================================================\n');

      client.destroy();
      process.exit(0);
    } catch (err) {
      console.error('Fatal error during cleanup execution:', err);
      client.destroy();
      process.exit(1);
    }
  });

  client.login(config.token);
}

main();
