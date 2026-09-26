/**
 * Utility Script: apply-main-server-permissions.js
 *
 * Applies the agreed Elevates Main Server category-level channel visibility permissions:
 * - @everyone: View Channel allowed ONLY on "01 • Start Here" (and nothing else server-wide).
 * - Verified Member: View Channel allowed on all "public" categories:
 *     02 • Elevates Community, 03 • Discover Elevates, 04 • Open Events,
 *     05 • Open Clusters, 06 • Global Projects, 07 • Global Opportunities,
 *     08 • Elevates Network, 09 • ELO, and Community Voice.
 * - Locked categories:
 *     10 • Founders HQ, 11 • HQ Operations, 12 • Community Management,
 *     13 • Chapter Management, 14 • Cluster Management, 15 • Private Projects,
 *     Chapter Logs, Founder Tickets, Admin Tickets.
 *     Founder & HQ Admin only — deny everyone else, including Verified Member.
 * - The "Unverified" role gets no special permission overwrites anywhere.
 * - Child channels inherit by default from category; any child channels with explicit
 *   overwrites (desynced) are cleared/reset via lockPermissions() to eliminate unexpected overrides.
 *
 * Usage:
 *   node scripts/apply-main-server-permissions.js           # Dry-run mode (default)
 *   node scripts/apply-main-server-permissions.js --confirm # Executes permission updates
 *   node scripts/apply-main-server-permissions.js --confirm --guild-id <GUILD_ID>
 */

const { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits } = require('discord.js');
const config = require('../src/config');
const api = require('../src/lib/api');

// Category classification helper
function classifyCategory(categoryName) {
  const norm = categoryName.toLowerCase().replace(/[^a-z0-9]/g, ' ');

  // 1. Start Here
  if (/^01\b/.test(norm) || norm.includes('start here')) {
    return 'START_HERE';
  }

  // 2. Public categories (02 through 09 & Community Voice)
  if (
    /^(02|03|04|05|06|07|08|09)\b/.test(norm) ||
    norm.includes('elevates community') ||
    norm.includes('discover elevates') ||
    norm.includes('open events') ||
    norm.includes('open clusters') ||
    norm.includes('global projects') ||
    norm.includes('global opportunities') ||
    norm.includes('elevates network') ||
    /\belo\b/.test(norm) ||
    norm.includes('community voice')
  ) {
    return 'PUBLIC';
  }

  // 3. Locked categories (10 through 15, Chapter Logs, Founder Tickets, Admin Tickets)
  if (
    /^(10|11|12|13|14|15)\b/.test(norm) ||
    norm.includes('founders hq') ||
    norm.includes('hq operations') ||
    norm.includes('community management') ||
    norm.includes('chapter management') ||
    norm.includes('cluster management') ||
    norm.includes('private projects') ||
    norm.includes('chapter log') ||
    norm.includes('founder ticket') ||
    norm.includes('admin ticket')
  ) {
    return 'LOCKED';
  }

  return 'OTHER';
}

async function main() {
  const isConfirmed = process.argv.includes('--confirm');

  // Parse optional CLI arguments for guild ID
  let targetGuildId = null;
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--guild' || arg === '--guild-id') {
      targetGuildId = process.argv[i + 1];
    } else if (arg.startsWith('--guild=')) {
      targetGuildId = arg.split('=')[1];
    } else if (arg.startsWith('--guild-id=')) {
      targetGuildId = arg.split('=')[1];
    }
  }

  console.log('============================================================');
  console.log('    Elevates Main Server Channel Visibility Permissions');
  console.log('============================================================');
  if (isConfirmed) {
    console.log('⚡ MODE: CONFIRMED (--confirm passed). Changes WILL be applied.');
  } else {
    console.log('🔍 MODE: DRY-RUN (Pass --confirm to actually apply changes).');
  }
  console.log('============================================================\n');

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.once('clientReady', async () => {
    try {
      console.log(`[Bot] Connected as ${client.user.tag} (ID: ${client.user.id}).`);

      // 1. Resolve Main Guild
      let mainGuildId = targetGuildId;
      if (!mainGuildId) {
        const mainConfig = await api.getMainGuildConfig().catch(() => null);
        mainGuildId = mainConfig?.guildId || config.mainGuildId;
      }

      if (!mainGuildId) {
        console.error('❌ Could not determine Main Guild ID from command line, guild_config, or config.mainGuildId.');
        process.exit(1);
      }

      const guild = client.guilds.cache.get(mainGuildId) ||
        (await client.guilds.fetch(mainGuildId).catch(() => null));

      if (!guild) {
        console.error(`❌ Main Guild (${mainGuildId}) not found among bot accessible guilds.`);
        process.exit(1);
      }

      console.log(`[Guild] Target: "${guild.name}" (${guild.id})\n`);

      // 2. Fetch all roles & channels
      await guild.roles.fetch();
      await guild.channels.fetch();

      // 3. Look up roles by exact name
      const expectedRoles = ['@everyone', 'Verified Member', 'Executive Member', 'Founder', 'HQ Admin'];
      const resolvedRoles = {};
      const missingRoles = [];

      for (const roleName of expectedRoles) {
        let role;
        if (roleName === '@everyone') {
          role = guild.roles.everyone || guild.roles.cache.find((r) => r.name === '@everyone');
        } else {
          role = guild.roles.cache.find((r) => r.name === roleName) ||
            (roleName === 'Founder' ? guild.roles.cache.find((r) => r.name === 'ELEVATES • Founder') : null);
        }

        if (role) {
          resolvedRoles[roleName] = role;
          console.log(`[Role] Found "${roleName}" (ID: ${role.id})`);
        } else {
          missingRoles.push(roleName);
          console.warn(`⚠️ Warning: Expected role "${roleName}" was not found via guild.roles.cache.find(). Its permission overwrites will be skipped.`);
        }
      }

      const botMember = guild.members.me;
      console.log(`[Bot Member] Permissions cached: Admin=${botMember?.permissions.has('Administrator')}\n`);

      // 4. Find all categories
      const categories = guild.channels.cache
        .filter((c) => c.type === ChannelType.GuildCategory)
        .sort((a, b) => a.position - b.position);

      console.log(`[Categories] Discovered ${categories.size} categories to evaluate.\n`);

      let totalCategoriesEvaluated = 0;
      let totalCategoriesUpdated = 0;
      let totalChildChannelsToReset = 0;
      let totalChildChannelsReset = 0;
      const categoriesSkippedDueToMissingRoles = new Set();

      for (const [, category] of categories) {
        totalCategoriesEvaluated++;
        const categoryName = category.name.trim();
        const type = classifyCategory(categoryName);

        console.log(`------------------------------------------------------------`);
        console.log(`📁 Category: "${categoryName}" [Classification: ${type}]`);

        // Build target overwrites
        const targetOverwrites = [];

        // Bot member overwrite (ensures management access)
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

        // Apply rules per classification
        if (type === 'START_HERE') {
          // @everyone: ALLOW ViewChannel, ReadMessageHistory; DENY SendMessages, AddReactions
          if (resolvedRoles['@everyone']) {
            targetOverwrites.push({
              id: resolvedRoles['@everyone'].id,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
              deny: [
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.AddReactions,
                PermissionFlagsBits.CreatePublicThreads,
                PermissionFlagsBits.CreatePrivateThreads,
                PermissionFlagsBits.SendMessagesInThreads,
              ],
            });
            console.log(`   • @everyone: ALLOW ViewChannel, ReadMessageHistory | DENY SendMessages, AddReactions`);
          }

          // Verified Member: ALLOW ViewChannel, ReadMessageHistory
          if (resolvedRoles['Verified Member']) {
            targetOverwrites.push({
              id: resolvedRoles['Verified Member'].id,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            });
            console.log(`   • Verified Member: ALLOW ViewChannel, ReadMessageHistory`);
          } else {
            console.log(`   • Verified Member: ⚠️ SKIPPED (role not found)`);
            categoriesSkippedDueToMissingRoles.add('Verified Member');
          }

          // Executive Member: ALLOW ViewChannel, ReadMessageHistory
          if (resolvedRoles['Executive Member']) {
            targetOverwrites.push({
              id: resolvedRoles['Executive Member'].id,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            });
            console.log(`   • Executive Member: ALLOW ViewChannel, ReadMessageHistory`);
          }

          // Founder & HQ Admin: ALLOW ViewChannel, ReadMessageHistory, SendMessages, ManageChannels
          if (resolvedRoles['Founder']) {
            targetOverwrites.push({
              id: resolvedRoles['Founder'].id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ManageChannels,
                PermissionFlagsBits.ManageMessages,
              ],
            });
            console.log(`   • Founder: ALLOW ViewChannel, SendMessages, ManageChannels`);
          } else {
            console.log(`   • Founder: ⚠️ SKIPPED (role not found)`);
            categoriesSkippedDueToMissingRoles.add('Founder');
          }

          if (resolvedRoles['HQ Admin']) {
            targetOverwrites.push({
              id: resolvedRoles['HQ Admin'].id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ManageChannels,
                PermissionFlagsBits.ManageMessages,
              ],
            });
            console.log(`   • HQ Admin: ALLOW ViewChannel, SendMessages, ManageChannels`);
          } else {
            console.log(`   • HQ Admin: ⚠️ SKIPPED (role not found)`);
            categoriesSkippedDueToMissingRoles.add('HQ Admin');
          }
        } else if (type === 'PUBLIC') {
          // @everyone: DENY ViewChannel
          if (resolvedRoles['@everyone']) {
            targetOverwrites.push({
              id: resolvedRoles['@everyone'].id,
              deny: [PermissionFlagsBits.ViewChannel],
            });
            console.log(`   • @everyone: DENY ViewChannel`);
          }

          // Verified Member: ALLOW ViewChannel, SendMessages, ReadMessageHistory, Connect, Speak
          if (resolvedRoles['Verified Member']) {
            targetOverwrites.push({
              id: resolvedRoles['Verified Member'].id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.Connect,
                PermissionFlagsBits.Speak,
                PermissionFlagsBits.AddReactions,
                PermissionFlagsBits.AttachFiles,
                PermissionFlagsBits.EmbedLinks,
              ],
            });
            console.log(`   • Verified Member: ALLOW ViewChannel, SendMessages, Connect, Speak`);
          } else {
            console.log(`   • Verified Member: ⚠️ SKIPPED (role not found)`);
            categoriesSkippedDueToMissingRoles.add('Verified Member');
          }

          // Executive Member: ALLOW ViewChannel, SendMessages, ReadMessageHistory, Connect, Speak
          if (resolvedRoles['Executive Member']) {
            targetOverwrites.push({
              id: resolvedRoles['Executive Member'].id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.Connect,
                PermissionFlagsBits.Speak,
                PermissionFlagsBits.AddReactions,
                PermissionFlagsBits.AttachFiles,
                PermissionFlagsBits.EmbedLinks,
              ],
            });
            console.log(`   • Executive Member: ALLOW ViewChannel, SendMessages, Connect, Speak`);
          }

          // Founder & HQ Admin: Full management access
          if (resolvedRoles['Founder']) {
            targetOverwrites.push({
              id: resolvedRoles['Founder'].id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ManageChannels,
                PermissionFlagsBits.ManageMessages,
                PermissionFlagsBits.Connect,
                PermissionFlagsBits.Speak,
              ],
            });
            console.log(`   • Founder: ALLOW ViewChannel, SendMessages, ManageChannels, Connect, Speak`);
          } else {
            console.log(`   • Founder: ⚠️ SKIPPED (role not found)`);
            categoriesSkippedDueToMissingRoles.add('Founder');
          }

          if (resolvedRoles['HQ Admin']) {
            targetOverwrites.push({
              id: resolvedRoles['HQ Admin'].id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ManageChannels,
                PermissionFlagsBits.ManageMessages,
                PermissionFlagsBits.Connect,
                PermissionFlagsBits.Speak,
              ],
            });
            console.log(`   • HQ Admin: ALLOW ViewChannel, SendMessages, ManageChannels, Connect, Speak`);
          } else {
            console.log(`   • HQ Admin: ⚠️ SKIPPED (role not found)`);
            categoriesSkippedDueToMissingRoles.add('HQ Admin');
          }
        } else if (type === 'LOCKED') {
          // @everyone: DENY ViewChannel
          if (resolvedRoles['@everyone']) {
            targetOverwrites.push({
              id: resolvedRoles['@everyone'].id,
              deny: [PermissionFlagsBits.ViewChannel],
            });
            console.log(`   • @everyone: DENY ViewChannel`);
          }

          // Verified Member: DENY ViewChannel
          if (resolvedRoles['Verified Member']) {
            targetOverwrites.push({
              id: resolvedRoles['Verified Member'].id,
              deny: [PermissionFlagsBits.ViewChannel],
            });
            console.log(`   • Verified Member: DENY ViewChannel`);
          } else {
            console.log(`   • Verified Member: ⚠️ SKIPPED (role not found)`);
            categoriesSkippedDueToMissingRoles.add('Verified Member');
          }

          // Executive Member: DENY ViewChannel
          if (resolvedRoles['Executive Member']) {
            targetOverwrites.push({
              id: resolvedRoles['Executive Member'].id,
              deny: [PermissionFlagsBits.ViewChannel],
            });
            console.log(`   • Executive Member: DENY ViewChannel`);
          }

          // Founder & HQ Admin: Full locked access
          if (resolvedRoles['Founder']) {
            targetOverwrites.push({
              id: resolvedRoles['Founder'].id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ManageChannels,
                PermissionFlagsBits.ManageThreads,
                PermissionFlagsBits.ManageMessages,
                PermissionFlagsBits.Connect,
                PermissionFlagsBits.Speak,
              ],
            });
            console.log(`   • Founder: ALLOW ViewChannel, ManageChannels, ManageThreads`);
          } else {
            console.log(`   • Founder: ⚠️ SKIPPED (role not found)`);
            categoriesSkippedDueToMissingRoles.add('Founder');
          }

          if (resolvedRoles['HQ Admin']) {
            targetOverwrites.push({
              id: resolvedRoles['HQ Admin'].id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ManageChannels,
                PermissionFlagsBits.ManageThreads,
                PermissionFlagsBits.ManageMessages,
                PermissionFlagsBits.Connect,
                PermissionFlagsBits.Speak,
              ],
            });
            console.log(`   • HQ Admin: ALLOW ViewChannel, ManageChannels, ManageThreads`);
          } else {
            console.log(`   • HQ Admin: ⚠️ SKIPPED (role not found)`);
            categoriesSkippedDueToMissingRoles.add('HQ Admin');
          }
        } else {
          // Default OTHER: Deny @everyone
          if (resolvedRoles['@everyone']) {
            targetOverwrites.push({
              id: resolvedRoles['@everyone'].id,
              deny: [PermissionFlagsBits.ViewChannel],
            });
            console.log(`   • @everyone: DENY ViewChannel (default fallback)`);
          }
          if (resolvedRoles['Founder']) {
            targetOverwrites.push({
              id: resolvedRoles['Founder'].id,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            });
            console.log(`   • Founder: ALLOW ViewChannel`);
          }
          if (resolvedRoles['HQ Admin']) {
            targetOverwrites.push({
              id: resolvedRoles['HQ Admin'].id,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            });
            console.log(`   • HQ Admin: ALLOW ViewChannel`);
          }
        }

        // Note: The "Unverified" role gets NO overwrites anywhere per agreed specification.
        // It is omitted from targetOverwrites, removing any existing overwrites on category update.

        // Helper to check if a child channel already matches intended target overwrites
        function isChannelSyncedWithTarget(child, target) {
          if (child.permissionOverwrites.cache.size !== target.length) return false;
          for (const t of target) {
            const existing = child.permissionOverwrites.cache.get(t.id);
            if (!existing) return false;
            const targetAllow = Array.isArray(t.allow) ? t.allow.reduce((acc, p) => acc | BigInt(p), 0n) : BigInt(t.allow || 0);
            const targetDeny = Array.isArray(t.deny) ? t.deny.reduce((acc, p) => acc | BigInt(p), 0n) : BigInt(t.deny || 0);
            if (existing.allow.bitfield !== targetAllow || existing.deny.bitfield !== targetDeny) {
              return false;
            }
          }
          return true;
        }

        // Child channels check: inspect channels belonging to this category
        const childChannels = guild.channels.cache
          .filter((c) => c.parentId === category.id && c.type !== ChannelType.GuildCategory);

        const desyncedChildren = childChannels.filter((c) => !isChannelSyncedWithTarget(c, targetOverwrites));

        if (desyncedChildren.size > 0) {
          totalChildChannelsToReset += desyncedChildren.size;
          console.log(`   ↳ Found ${desyncedChildren.size} child channel(s) with explicit overwrites (desynced):`);
          desyncedChildren.forEach((child) => {
            if (isConfirmed) {
              console.log(`     • #${child.name}: WILL clear/reset explicit overwrites to inherit category`);
            } else {
              console.log(`     • #${child.name}: WOULD clear/reset explicit overwrites to inherit category`);
            }
          });
        }

        // Apply changes if confirmed
        if (isConfirmed) {
          try {
            await category.permissionOverwrites.set(
              targetOverwrites,
              'Enforce Main Server Category Permissions Matrix via scripts/apply-main-server-permissions.js'
            );
            console.log(`  ✅ Category "${categoryName}" permissions applied.`);
            totalCategoriesUpdated++;
            await new Promise((resolve) => setTimeout(resolve, 300));

            // Reset explicit overwrites on desynced child channels
            const channelsToLock = childChannels.filter((c) => !c.permissionsLocked);
            for (const [, child] of channelsToLock) {
              try {
                await child.lockPermissions();
                console.log(`     ↳ ✅ Reset explicit overwrites on #${child.name} (synced with category)`);
                totalChildChannelsReset++;
                await new Promise((resolve) => setTimeout(resolve, 250));
              } catch (childErr) {
                console.error(`     ↳ ❌ Failed to reset child channel #${child.name}: ${childErr.message}`);
              }
            }
          } catch (catErr) {
            console.error(`  ❌ Failed to set overwrites on category "${categoryName}": ${catErr.message}`);
          }
        } else {
          console.log(`  🔍 [DRY-RUN] Overwrites WOULD be set for category "${categoryName}".`);
          if (desyncedChildren.size > 0) {
            console.log(`  🔍 [DRY-RUN] ${desyncedChildren.size} child channel(s) WOULD be reset to sync with category.`);
          }
        }
      }

      // Summary
      console.log('\n============================================================');
      console.log('                     EXECUTION SUMMARY');
      console.log('============================================================');
      console.log(`Mode:                         ${isConfirmed ? 'CONFIRMED (Executed)' : 'DRY-RUN (Simulated)'}`);
      console.log(`Categories Evaluated:         ${totalCategoriesEvaluated}`);
      console.log(`Categories Updated:           ${totalCategoriesUpdated}`);
      if (isConfirmed) {
        console.log(`Child Channels Reset/Synced:  ${totalChildChannelsReset}`);
      } else {
        console.log(`Child Channels To Reset:      ${totalChildChannelsToReset}`);
      }

      console.log(`Missing Roles Skipped:        ${missingRoles.length > 0 ? missingRoles.join(', ') : 'None'}`);
      if (missingRoles.length > 0) {
        missingRoles.forEach((r) => {
          console.log(`   • ${r}: Skipped across ${categoriesSkippedDueToMissingRoles.has(r) ? 'relevant categories' : 'server'} because role does not exist by exact name.`);
        });
      }

      if (!isConfirmed) {
        console.log('\n👉 To apply these changes to Discord, run with --confirm:');
        console.log('   node scripts/apply-main-server-permissions.js --confirm');
      }
      console.log('============================================================\n');

      client.destroy();
      process.exit(0);
    } catch (err) {
      console.error('Fatal error during permission enforcement execution:', err);
      client.destroy();
      process.exit(1);
    }
  });

  let attempts = 0;
  while (attempts < 5) {
    try {
      attempts++;
      await client.login(config.token);
      break;
    } catch (err) {
      console.warn(`[Login] Attempt ${attempts} failed: ${err.message}. Retrying in 2s...`);
      if (attempts >= 5) {
        console.error('❌ Could not log in to Discord after multiple attempts:', err.message);
        process.exit(1);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

main();
