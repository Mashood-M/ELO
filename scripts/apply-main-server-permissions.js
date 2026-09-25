/**
 * One-time corrective script to enforce category-level permission overwrites in the Elevates Main Server.
 *
 * Enforces:
 * - @everyone: View Channel allowed ONLY on "01 • Start Here" category, denied on every other category.
 * - Verified Member: View Channel allowed on all "public" categories (02 through 09, Community Voice).
 * - Locked categories (10-15, Chapter Logs, Founder Tickets, Admin Tickets): Founder/HQ Admin only.
 * - "Unverified" role has NO visibility permissions (purely a status tracking role).
 * - Bot integration maintains full management access across all categories.
 *
 * Usage:
 *   node scripts/apply-main-server-permissions.js           # Dry-run mode (scans & reports planned changes)
 *   node scripts/apply-main-server-permissions.js --confirm # Actually executes permission overwrites
 */

const { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits } = require('discord.js');
const config = require('../src/config');
const api = require('../src/lib/api');

async function main() {
  const isConfirmed = process.argv.includes('--confirm');

  console.log('============================================================');
  console.log('    Elevates Main Server Category Permissions Script');
  console.log('============================================================');
  if (isConfirmed) {
    console.log('⚡ MODE: CONFIRMED (--confirm passed). Permissions WILL be applied.');
  } else {
    console.log('🔍 MODE: DRY-RUN (Pass --confirm to actually apply permissions).');
  }
  console.log('============================================================\n');

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.once('clientReady', async () => {
    try {
      console.log(`[Bot] Logged in as ${client.user.tag}.`);

      // 1. Resolve Main Guild
      const mainConfig = await api.getMainGuildConfig().catch(() => null);
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

      console.log(`[Main Guild] Resolved: "${guild.name}" (${guild.id})\n`);

      // 2. Fetch all guild roles & channels
      await guild.roles.fetch();
      await guild.channels.fetch();

      const everyoneRole = guild.roles.everyone;
      const verifiedMemberRole = guild.roles.cache.find(
        (r) => r.name.toLowerCase().trim() === (config.mainRoles?.defaultRole || 'Verified Member').toLowerCase().trim()
      );
      const founderRole = guild.roles.cache.find(
        (r) => ['founder', 'elevates • founder', (config.roles?.founder || '').toLowerCase().trim()].includes(r.name.toLowerCase().trim())
      );
      const hqAdminRole = guild.roles.cache.find(
        (r) => ['hq admin', 'admin', 'elevates • admin', (config.roles?.admin || '').toLowerCase().trim()].includes(r.name.toLowerCase().trim())
      );
      const botMember = guild.members.me;

      if (!verifiedMemberRole) console.warn('⚠️ "Verified Member" role not found in main server.');
      if (!founderRole) console.warn('⚠️ "Founder" role not found in main server.');
      if (!hqAdminRole) console.warn('⚠️ "HQ Admin" role not found in main server.');

      // 3. Find all Category channels
      const categories = guild.channels.cache
        .filter((c) => c.type === ChannelType.GuildCategory)
        .sort((a, b) => a.position - b.position);

      console.log(`[Audit] Discovered ${categories.size} category channels in main server.\n`);

      let totalProcessed = 0;
      let totalUpdated = 0;

      for (const [, category] of categories) {
        totalProcessed++;
        const name = category.name.trim();
        const lowerName = name.toLowerCase();

        // Determine category classification
        const isStartHere = /01\b|start\s*here/i.test(name);
        const isPublic02to09 = /^0[2-9]\b/i.test(name) || /community\s*voice/i.test(lowerName);
        const isLocked10to15 = /^1[0-5]\b/i.test(name);
        const isChapterLogs = /chapter\s*logs?/i.test(lowerName);
        const isFounderTickets = /founder\s*tickets?/i.test(lowerName);
        const isAdminTickets = /admin\s*tickets?/i.test(lowerName);
        const isLockedCategory = isLocked10to15 || isChapterLogs || isFounderTickets || isAdminTickets;

        let classification = 'OTHER';
        if (isStartHere) classification = 'START_HERE (01)';
        else if (isPublic02to09) classification = 'PUBLIC (02-09 / Community Voice)';
        else if (isLockedCategory) classification = 'LOCKED (10-15 / Logs / Tickets)';

        console.log(`📁 Category: "${name}" [Type: ${classification}]`);

        // Compute intended overwrites
        const targetOverwrites = [];

        // Bot always gets full management
        if (botMember) {
          targetOverwrites.push({
            id: botMember.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.ManageChannels,
              PermissionFlagsBits.ManageRoles,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.Connect,
              PermissionFlagsBits.Speak,
            ],
          });
        }

        if (isStartHere) {
          // @everyone: ViewChannel ALLOWED, ReadMessageHistory ALLOWED, SendMessages DENIED
          targetOverwrites.push({
            id: everyoneRole.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions],
          });

          // Verified Member: Can also view
          if (verifiedMemberRole) {
            targetOverwrites.push({
              id: verifiedMemberRole.id,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            });
          }

          // Founder & HQ Admin: Full management
          if (founderRole) {
            targetOverwrites.push({
              id: founderRole.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ManageChannels,
              ],
            });
          }
          if (hqAdminRole) {
            targetOverwrites.push({
              id: hqAdminRole.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ManageChannels,
              ],
            });
          }
        } else if (isPublic02to09) {
          // @everyone: ViewChannel DENIED
          targetOverwrites.push({
            id: everyoneRole.id,
            deny: [PermissionFlagsBits.ViewChannel],
          });

          // Verified Member: ViewChannel ALLOWED
          if (verifiedMemberRole) {
            targetOverwrites.push({
              id: verifiedMemberRole.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.Connect,
                PermissionFlagsBits.Speak,
              ],
            });
          }

          // Founder & HQ Admin: Full management
          if (founderRole) {
            targetOverwrites.push({
              id: founderRole.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ManageChannels,
                PermissionFlagsBits.Connect,
                PermissionFlagsBits.Speak,
              ],
            });
          }
          if (hqAdminRole) {
            targetOverwrites.push({
              id: hqAdminRole.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ManageChannels,
                PermissionFlagsBits.Connect,
                PermissionFlagsBits.Speak,
              ],
            });
          }
        } else if (isLockedCategory) {
          // @everyone: ViewChannel DENIED
          targetOverwrites.push({
            id: everyoneRole.id,
            deny: [PermissionFlagsBits.ViewChannel],
          });

          // Verified Member: ViewChannel DENIED
          if (verifiedMemberRole) {
            targetOverwrites.push({
              id: verifiedMemberRole.id,
              deny: [PermissionFlagsBits.ViewChannel],
            });
          }

          // Founder: ALLOWED
          if (founderRole) {
            targetOverwrites.push({
              id: founderRole.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ManageChannels,
                PermissionFlagsBits.ManageThreads,
                PermissionFlagsBits.Connect,
                PermissionFlagsBits.Speak,
              ],
            });
          }

          // HQ Admin: ALLOWED
          if (hqAdminRole) {
            targetOverwrites.push({
              id: hqAdminRole.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ManageChannels,
                PermissionFlagsBits.ManageThreads,
                PermissionFlagsBits.Connect,
                PermissionFlagsBits.Speak,
              ],
            });
          }
        } else {
          // Default fallback: deny @everyone, allow Verified Member & Staff
          targetOverwrites.push({
            id: everyoneRole.id,
            deny: [PermissionFlagsBits.ViewChannel],
          });
          if (founderRole) {
            targetOverwrites.push({
              id: founderRole.id,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            });
          }
          if (hqAdminRole) {
            targetOverwrites.push({
              id: hqAdminRole.id,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            });
          }
        }

        // Print intended permissions
        console.log(`  -> @everyone: ${isStartHere ? 'ALLOW ViewChannel' : 'DENY ViewChannel'}`);
        console.log(`  -> Verified Member: ${isPublic02to09 ? 'ALLOW ViewChannel' : isStartHere ? 'ALLOW ViewChannel' : 'DENY ViewChannel'}`);
        console.log(`  -> Founder & HQ Admin: ALLOW ViewChannel & Manage`);

        if (isConfirmed) {
          await category.permissionOverwrites.set(
            targetOverwrites,
            'Enforcing Main Server Category Permissions Matrix via scripts/apply-main-server-permissions.js'
          );
          console.log(`  ✅ Overwrites applied successfully to "${name}".\n`);
          totalUpdated++;
        } else {
          console.log(`  🔍 [DRY-RUN] Overwrites would be updated for "${name}".\n`);
        }
      }

      console.log('============================================================');
      console.log(`Audit complete: ${totalProcessed} categories evaluated.`);
      if (isConfirmed) {
        console.log(`⚡ ${totalUpdated} categories successfully updated.`);
      } else {
        console.log('🔍 DRY-RUN complete. Run with --confirm to apply changes.');
      }
      console.log('============================================================');

      client.destroy();
      process.exit(0);
    } catch (err) {
      console.error('[Error] Failed executing permission apply script:', err);
      client.destroy();
      process.exit(1);
    }
  });

  client.login(config.token).catch((err) => {
    console.error('❌ Could not log in to Discord:', err.message);
    process.exit(1);
  });
}

main();
