const {
  Events,
  EmbedBuilder,
  ChannelType,
  PermissionFlagsBits,
  AuditLogEvent,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const api = require('../lib/api');
const supabase = require('../lib/supabase');
const config = require('../config');
const { deployToGuild } = require('../deploy-commands');

module.exports = {
  name: Events.GuildCreate,
  async execute(guild) {
    console.log(`[GuildCreate] Joined new guild: "${guild.name}" (${guild.id}) with ${guild.memberCount} members.`);

    // 1. Immediately register slash commands to the newly joined guild
    try {
      await deployToGuild(guild.id);
      console.log(`[GuildCreate] Registered slash commands to new guild ${guild.id}.`);
    } catch (cmdErr) {
      console.warn(`[GuildCreate] Failed to deploy commands to guild ${guild.id}:`, cmdErr.message);
    }

    // 2. Wait a few seconds to allow gateway and HTTP callback (if any) to settle
    await new Promise((resolve) => setTimeout(resolve, 3000));

    try {
      // 3. Check if guild_config already has an entry for this guild_id
      const currentConfig = await api.getGuildConfig(guild.id);
      if (currentConfig && (currentConfig.chapterId || currentConfig.guildType === 'main')) {
        console.log(`[GuildCreate] Guild ${guild.id} is already configured/activated (type: ${currentConfig.guildType}, chapter: ${currentConfig.chapterId}).`);
        return;
      }

      // Safety check: Never provision the Main Server as a chapter server
      if (guild.id === config.mainGuildId) return;

      // 4. Attempt automatic provisioning: Identify who added the bot or server owner
      let inviterId = null;
      try {
        const auditLogs = await guild.fetchAuditLogs({
          type: AuditLogEvent.BotAdd,
          limit: 1,
        }).catch(() => null);
        const entry = auditLogs?.entries?.first();
        if (entry && entry.executor) {
          inviterId = entry.executor.id;
        }
      } catch (_) {}

      const candidateUserIds = Array.from(new Set([inviterId, guild.ownerId].filter(Boolean)));
      let detectedChapter = null;
      let matchedLeadMember = null;

      for (const userId of candidateUserIds) {
        // A. Check for unused setup token
        try {
          const { data: tokens } = await supabase
            .from('chapter_setup_tokens')
            .select('*')
            .eq('campus_lead_discord_id', userId)
            .is('used_at', null)
            .order('created_at', { ascending: false })
            .limit(1);

          if (tokens && tokens.length > 0) {
            const tokenRecord = tokens[0];
            const chp = await api.getChapterByIdentifier(tokenRecord.chapter_id);
            if (chp) {
              const { data: existingGuild } = await supabase
                .from('guild_config')
                .select('guild_id')
                .eq('chapter_id', chp.id)
                .maybeSingle();

              if (!existingGuild) {
                detectedChapter = chp;
                matchedLeadMember = guild.members.cache.get(userId) ||
                  (await guild.members.fetch(userId).catch(() => null));
                await supabase
                  .from('chapter_setup_tokens')
                  .update({ used_at: new Date().toISOString() })
                  .eq('id', tokenRecord.id);
                break;
              }
            }
          }
        } catch (_) {}

        // B. Check ElevatesOS linked identity
        if (!detectedChapter) {
          try {
            const identity = await api.getIdentityByDiscordId(userId);
            if (identity && identity.profile) {
              const profile = identity.profile;
              const userRoles = identity.userRoles || [];

              let targetChapterId = profile.chapter_id;
              if (!targetChapterId) {
                const leadRole = userRoles.find(
                  (r) => (r.role_key || r.role) === 'campus_lead' && r.chapter_id
                );
                if (leadRole) targetChapterId = leadRole.chapter_id;
              }

              if (targetChapterId) {
                const chp = await api.getChapterByIdentifier(targetChapterId);
                if (chp) {
                  const { data: existingGuild } = await supabase
                    .from('guild_config')
                    .select('guild_id')
                    .eq('chapter_id', chp.id)
                    .maybeSingle();

                  if (!existingGuild) {
                    detectedChapter = chp;
                    matchedLeadMember = guild.members.cache.get(userId) ||
                      (await guild.members.fetch(userId).catch(() => null));
                    break;
                  }
                }
              }
            }
          } catch (_) {}
        }
      }

      // If chapter was detected, auto-provision right now!
      if (detectedChapter) {
        console.log(`[GuildCreate] Auto-provisioning guild "${guild.name}" (${guild.id}) for chapter "${detectedChapter.name}"...`);
        const provisioningResult = await api.provisionChapterGuild(
          guild.client,
          guild,
          detectedChapter.id,
          matchedLeadMember
        );

        // Run cluster sync
        const { syncChapterClusters } = require('../lib/clusterSync');
        syncChapterClusters(guild.client, detectedChapter.id).catch((err) =>
          console.error('[GuildCreate] Cluster sync error:', err.message)
        );

        // Send welcome embed to chapter server
        const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
        const welcomeChannel =
          guild.systemChannel ||
          guild.channels.cache.find(
            (c) =>
              c.type === ChannelType.GuildText &&
              c.name !== 'link-server' &&
              c.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)
          );

        if (welcomeChannel) {
          const linkChannel = guild.channels.cache.find((c) => c.name === 'link-server');
          const welcomeEmbed = new EmbedBuilder()
            .setColor(0x22C55E)
            .setTitle(`🎉 ${provisioningResult.chapterName} Discord Server Activated!`)
            .setDescription(
              `This server is now officially linked to the **${provisioningResult.chapterName}** chapter on ElevatesOS!\n\n` +
              `• **Elevates Chapter ID:** \`${provisioningResult.elevatesId || detectedChapter.id}\`\n` +
              `• **Campus Lead:** ${matchedLeadMember ? `<@${matchedLeadMember.id}>` : 'Configured'}\n` +
              `• **Campus Lead Role:** Configured with **Administrator** access\n` +
              `• **Chapter Roles:** Provisioned from ElevatesOS\n` +
              `• **Main Server Log Forum:** Created with dedicated starter audit threads\n` +
              `• **Account Linking:** Head over to ${linkChannel ? `<#${linkChannel.id}>` : '`#link-server`'} to connect your account.\n\n` +
              `Private cluster categories and channels will synchronize automatically.`
            )
            .setFooter({ text: 'ElevatesOS Chapter Provisioning Engine' })
            .setTimestamp();

          await welcomeChannel.send({ embeds: [welcomeEmbed] }).catch(() => {});
        }

        // Centralized audit log
        api.logChapterEvent(guild.client, detectedChapter.id, guild.id, 'chapter_activated', {
          activatedBy: matchedLeadMember ? matchedLeadMember.user.tag : (inviterId || 'Bot Add'),
          guildName: guild.name,
          guildId: guild.id,
        }, 'channel_role_changes').catch(() => {});

        console.log(`[GuildCreate] Successfully auto-provisioned chapter "${provisioningResult.chapterName}" on guild ${guild.id}.`);
        return;
      }

      // 5. Fallback: If not automatically activated, post friendly prompt with an Activate button
      const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
      if (!me) return;

      const welcomeChannel =
        guild.systemChannel ||
        guild.channels.cache.find(
          (c) =>
            c.type === ChannelType.GuildText &&
            c.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)
        );

      if (welcomeChannel) {
        const warningEmbed = new EmbedBuilder()
          .setColor(0xF59E0B)
          .setTitle('⚠️ Server Not Activated')
          .setDescription(
            '⚠️ This chapter server has not been activated yet.\n\n' +
            'If you are the Campus Lead or an Administrator, click **Activate Server** below or run `/chapter` to link this server to your ElevatesOS Chapter and set up the Main Server forum audit logs.'
          )
          .setFooter({ text: 'ElevatesOS Chapter Provisioning Engine' })
          .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('activate_chapter_server')
            .setLabel('⚡ Activate Server')
            .setStyle(ButtonStyle.Primary)
        );

        await welcomeChannel.send({ embeds: [warningEmbed], components: [row] }).catch(() => {});
      }
    } catch (err) {
      console.error('[GuildCreate] Error handling guild join fallback:', err);
    }
  },
};
