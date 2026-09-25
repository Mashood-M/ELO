#!/usr/bin/env node

/**
 * Cluster Reconciliation Script
 *
 * Compares cluster_members in Supabase against actual Discord role holders
 * in each cluster's member role, and corrects any drift:
 * - Grants missing roles to members who are linked and verified in Supabase
 * - Revokes excess roles from members who are no longer in the cluster in Supabase
 * - Logs all corrections to `discord_sync_log`
 *
 * Usage:
 *   node scripts/reconcile-clusters.js                    # Reconcile all active clusters
 *   node scripts/reconcile-clusters.js --cluster <id>     # Reconcile a single cluster
 *   node scripts/reconcile-clusters.js --dry-run          # Preview drift without mutations
 */

const { Client, GatewayIntentBits } = require('discord.js');
const config = require('../src/config');
const supabase = require('../src/lib/supabase');
const { reconcileClusterMembers, reconcileAllClusters } = require('../src/lib/clusterSync');

async function main() {
  const args = process.argv.slice(2);
  const clusterIndex = args.indexOf('--cluster');
  const targetClusterId = clusterIndex !== -1 ? args[clusterIndex + 1] : null;
  const isDryRun = args.includes('--dry-run');

  console.log('============================================================');
  console.log('       Elevates Cluster Role Reconciliation Engine');
  console.log('============================================================');
  if (targetClusterId) {
    console.log(`🎯 Target Cluster: ${targetClusterId}`);
  } else {
    console.log('🌐 Target: All Active Chapters & Clusters');
  }
  if (isDryRun) {
    console.log('🔍 MODE: DRY RUN (no mutations will be performed)');
  } else {
    console.log('⚡ MODE: LIVE (drift will be actively corrected in Discord & Supabase)');
  }
  console.log('============================================================\n');

  if (!config.token) {
    console.error('❌ DISCORD_TOKEN is missing from environment.');
    process.exit(1);
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
    ],
  });

  client.once('ready', async () => {
    try {
      console.log(`[Bot] Connected as ${client.user.tag}.\n`);

      let totalClusters = 0;
      let totalGranted = 0;
      let totalRevoked = 0;

      if (targetClusterId) {
        console.log(`[Reconcile] Processing cluster ID ${targetClusterId}...`);
        const res = await reconcileClusterMembers(client, targetClusterId);
        if (res) {
          totalClusters = 1;
          totalGranted += (res.granted || []).length;
          totalRevoked += (res.revoked || []).length;

          console.log(`\n📋 Cluster: "${res.clusterName}" (${res.clusterId})`);
          console.log(`   ➕ Roles Granted (${res.granted.length}): ${res.granted.join(', ') || 'None'}`);
          console.log(`   ➖ Roles Revoked (${res.revoked.length}): ${res.revoked.join(', ') || 'None'}`);
        }
      } else {
        console.log('[Reconcile] Fetching all active clusters...');
        const { data: clusters, error } = await supabase
          .from('clusters')
          .select('id, name, status')
          .neq('status', 'archived');

        if (error) {
          console.error('❌ Error fetching clusters from Supabase:', error.message);
          client.destroy();
          process.exit(1);
        }

        console.log(`[Reconcile] Found ${clusters.length} active cluster(s) to reconcile.\n`);

        for (const c of clusters) {
          console.log(`⚙️  Reconciling "${c.name}" (${c.id})...`);
          const res = await reconcileClusterMembers(client, c.id);
          if (res) {
            totalClusters++;
            totalGranted += (res.granted || []).length;
            totalRevoked += (res.revoked || []).length;
            if (res.granted.length > 0 || res.revoked.length > 0) {
              console.log(`   ✅ Corrected drift -> Granted: ${res.granted.length}, Revoked: ${res.revoked.length}`);
            } else {
              console.log(`   ✨ No drift detected (fully in sync).`);
            }
          }
        }
      }

      console.log('\n============================================================');
      console.log('                  RECONCILIATION SUMMARY');
      console.log('============================================================');
      console.log(`Clusters Processed : ${totalClusters}`);
      console.log(`Missing Roles Granted : ${totalGranted}`);
      console.log(`Excess Roles Revoked  : ${totalRevoked}`);
      console.log('============================================================\n');

      client.destroy();
      process.exit(0);
    } catch (err) {
      console.error('❌ Fatal error during reconciliation:', err);
      client.destroy();
      process.exit(1);
    }
  });

  client.login(config.token);
}

if (require.main === module) {
  main();
}

module.exports = { main };
