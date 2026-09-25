const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType, MessageFlags } = require('discord.js');
const api = require('../lib/api');
const supabase = require('../lib/supabase');
const config = require('../config');

/**
 * Resolves caller identity and determines the target chapter.
 */
async function resolveCallerAndChapter(userId, inputChapterIdentifier) {
  const identity = await api.getIdentityByDiscordId(userId);
  if (!identity || !identity.profile) {
    return { error: '⚠️ You must link your ElevatesOS account first before activating or provisioning a chapter server. Please run `/connect` or check `#link-server`.' };
  }

  const profile = identity.profile;
  const userRoles = identity.userRoles || [];

  const isFounderOrAdmin =
    profile.role === 'founder' ||
    profile.role === 'hq_admin' ||
    userRoles.some((r) => ['founder', 'hq_admin'].includes((r.role_key || r.role || '').toLowerCase()));

  let targetChapter = null;

  if (inputChapterIdentifier) {
    targetChapter = await api.getChapterByIdentifier(inputChapterIdentifier.trim());
    if (!targetChapter) {
      return { error: `⚠️ Chapter not found for "${inputChapterIdentifier}". Please verify your Elevates ID (e.g. CHP-0033) or UUID.` };
    }

    const isCampusLeadByRole = userRoles.some(
      (r) =>
        (r.role_key || r.role) === 'campus_lead' &&
        (r.chapter_id === targetChapter.id ||
          (targetChapter.elevates_id && r.chapter_id?.toLowerCase() === targetChapter.elevates_id.toLowerCase()) ||
          !r.chapter_id)
    );

    const isCampusLeadByProfile =
      (profile.designation === 'campus_lead' || profile.role === 'campus_lead') &&
      (profile.chapter_id === targetChapter.id ||
        (targetChapter.elevates_id && profile.chapter_id?.toLowerCase() === targetChapter.elevates_id.toLowerCase()) ||
        !profile.chapter_id);

    const isDirectLead = targetChapter.campus_lead_id === profile.id;
    const isAuthorized = isFounderOrAdmin || isDirectLead || isCampusLeadByRole || isCampusLeadByProfile;

    if (!isAuthorized) {
      return { error: `⚠️ You are not authorized as the Campus Lead for **${targetChapter.name}** (${targetChapter.elevates_id || targetChapter.id}).` };
    }

    // Link campus_lead_id in chapters table if unassigned
    if (!targetChapter.campus_lead_id && (isCampusLeadByRole || isCampusLeadByProfile)) {
      try {
        await supabase
          .from('chapters')
          .update({ campus_lead_id: profile.id, updated_at: new Date().toISOString() })
          .eq('id', targetChapter.id)
          .is('campus_lead_id', null);
      } catch (_) {}
    }
  } else {
    // Auto-detect chapter from caller records
    const { data: directChapters } = await supabase
      .from('chapters')
      .select('*')
      .eq('campus_lead_id', profile.id);

    if (directChapters && directChapters.length > 0) {
      targetChapter = directChapters[0];
    }

    if (!targetChapter) {
      const leadRecord = userRoles.find(
        (r) => (r.role_key || r.role) === 'campus_lead' && r.chapter_id
      );
      if (leadRecord?.chapter_id) {
        targetChapter = await api.getChapterByIdentifier(leadRecord.chapter_id);
      }
    }

    if (!targetChapter && profile.chapter_id) {
      const isLead =
        profile.designation === 'campus_lead' ||
        profile.role === 'campus_lead' ||
        userRoles.some((r) => (r.role_key || r.role) === 'campus_lead');

      if (isLead) {
        targetChapter = await api.getChapterByIdentifier(profile.chapter_id);
      }
    }

    if (!targetChapter) {
      if (isFounderOrAdmin) {
        return { error: '⚠️ As a Founder / Admin, please specify which chapter to provision (e.g. `/chapter chapter_id: CHP-0033`).' };
      }
      return { error: '⚠️ Only verified **Campus Leads** assigned to an active ElevatesOS Chapter can provision chapter servers. If your chapter is assigned by Elevates ID (e.g. `CHP-0033`), specify it: `/chapter chapter_id: CHP-0033`.' };
    }
  }

  return { targetChapter, profile, userRoles, isFounderOrAdmin };
}

/**
 * Activates and provisions the current guild for the caller's chapter.
 */
async function activateCurrentGuild(interaction, inputChapter = null) {
  const guild = interaction.guild;
  if (!guild) {
    return interaction.editReply({ content: '⚠️ This command must be run inside a Discord server.' });
  }

  // Safety check: Never provision the Main Server as a chapter server
  if (guild.id === config.mainGuildId) {
    return interaction.editReply({ content: '⚠️ The Main Server cannot be provisioned as a chapter server.' });
  }

  // Check user permissions in this guild
  const member = interaction.member;
  const isOwner = guild.ownerId === interaction.user.id;
  const hasAdminPerm =
    member?.permissions?.has(PermissionFlagsBits.Administrator) ||
    member?.permissions?.has(PermissionFlagsBits.ManageGuild);

  if (!isOwner && !hasAdminPerm) {
    return interaction.editReply({
      content: '⚠️ You must be the Server Owner or have Administrator/Manage Server permissions in this server to activate it.',
    });
  }

  // Check if server is already configured
  const existingConfig = await api.getGuildConfig(guild.id);
  if (existingConfig && existingConfig.chapterId) {
    const chp = await api.getChapterByIdentifier(existingConfig.chapterId);
    return interaction.editReply({
      content: `⚠️ This server is already activated and linked to **${chp?.name || existingConfig.chapterId}**.`,
    });
  }

  // Resolve caller & target chapter
  const resolution = await resolveCallerAndChapter(interaction.user.id, inputChapter);
  if (resolution.error) {
    return interaction.editReply({ content: resolution.error });
  }

  const { targetChapter } = resolution;

  // Check if chapter already has a different Discord server
  const { data: existingGuild } = await supabase
    .from('guild_config')
    .select('guild_id')
    .eq('chapter_id', targetChapter.id)
    .maybeSingle();

  if (existingGuild && existingGuild.guild_id !== guild.id) {
    return interaction.editReply({
      content: `⚠️ Chapter **${targetChapter.name}** already has an active Discord server configured (Server ID: \`${existingGuild.guild_id}\`). A chapter can only have one active server at a time.`,
    });
  }

  // Execute provisioning
  try {
    const provisioningResult = await api.provisionChapterGuild(
      interaction.client,
      guild,
      targetChapter.id,
      interaction.member
    );

    // Sync clusters
    const { syncChapterClusters } = require('../lib/clusterSync');
    syncChapterClusters(interaction.client, targetChapter.id).catch((err) =>
      console.error('[chapter] Cluster sync error:', err.message)
    );

    // Provision Chapter Ticket Forums (Executive Member & Campus Lead)
    const ticketSystem = require('../lib/ticketSystem');
    ticketSystem.ensureTicketForum(guild, 'campus_lead', targetChapter).catch((err) =>
      console.warn('[chapter] Error ensuring campus lead ticket forum:', err.message)
    );
    ticketSystem.ensureTicketForum(guild, 'exec', targetChapter).catch((err) =>
      console.warn('[chapter] Error ensuring exec ticket forum:', err.message)
    );

    // Provision private leadership/insider section (Campus Lead tier + Executive Member tier)
    api.ensureChapterLeadershipSection(guild, targetChapter.id).catch((err) =>
      console.warn('[chapter] Error ensuring leadership section:', err.message)
    );

    // Centralized event log (which posts in Main Server starter thread)
    api.logChapterEvent(interaction.client, targetChapter.id, guild.id, 'chapter_activated', {
      activatedBy: interaction.user.tag,
      guildName: guild.name,
      guildId: guild.id,
    }, 'channel_role_changes').catch(() => {});

    const successEmbed = new EmbedBuilder()
      .setColor(0x22C55E)
      .setTitle(`🎉 ${targetChapter.name} Discord Server Activated!`)
      .setDescription(
        `This server is now officially linked to the **${targetChapter.name}** chapter on ElevatesOS!\n\n` +
        `• **Elevates Chapter ID:** \`${targetChapter.elevates_id || targetChapter.id}\`\n` +
        `• **Campus Lead:** <@${interaction.user.id}>\n` +
        `• **Campus Lead Role:** Granted Administrator permissions\n` +
        `• **Executive Member Tier:** Configured in Leadership & Support Channels\n` +
        `• **Chapter Roles:** Provisioned from ElevatesOS\n` +
        `• **Main Server Log Forum:** Created under **CHAPTER LOGS** (#chp-${provisioningResult.chapterSlug}) with dedicated audit topics\n` +
        `• **Account Linking:** Available in ${linkChannel ? `<#${linkChannel.id}>` : '`#link-server`'}\n\n` +
        `Private cluster categories and channels will synchronize automatically.`
      )
      .setFooter({ text: 'ElevatesOS Chapter Provisioning Engine' })
      .setTimestamp();

    return interaction.editReply({ embeds: [successEmbed] });
  } catch (err) {
    console.error('[chapter] Provisioning error:', err);
    return interaction.editReply({
      content: `❌ Failed to activate chapter server: ${err.message}`,
    });
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('chapter')
    .setDescription('Provision and activate a Discord server for your ElevatesOS Chapter.')
    .addStringOption((opt) =>
      opt
        .setName('chapter_id')
        .setDescription('Optional: Chapter Elevates ID (e.g. CHP-0033) or UUID')
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    let guildConfig;
    try {
      guildConfig = await api.getGuildConfig(interaction.guildId);
    } catch (_) {}

    const isMainServer = interaction.guildId === config.mainGuildId || guildConfig?.guildType === 'main';

    // If executed in a Chapter Server (or unprovisioned server), activate this server directly!
    if (!isMainServer) {
      const inputChapter = interaction.options.getString('chapter_id')?.trim();
      return activateCurrentGuild(interaction, inputChapter);
    }

    // Otherwise, executed in Main Server: generate invite link & setup token
    const inputChapter = interaction.options.getString('chapter_id')?.trim();
    const resolution = await resolveCallerAndChapter(interaction.user.id, inputChapter);
    if (resolution.error) {
      return interaction.editReply({ content: resolution.error });
    }

    const { targetChapter, profile } = resolution;
    const chapterId = targetChapter.id;
    const chapterName = targetChapter.name || 'Your Chapter';
    const chapterElevatesId = targetChapter.elevates_id || null;

    // RULE: One chapter server per Campus Lead
    try {
      const { data: directLeadConfigs } = await supabase
        .from('guild_config')
        .select('guild_id, chapter_id')
        .or(`campus_lead_id.eq.${profile.id},campus_lead_discord_id.eq.${interaction.user.id}`)
        .neq('chapter_id', chapterId)
        .limit(1);

      if (directLeadConfigs && directLeadConfigs.length > 0) {
        return interaction.editReply({
          content: "You've already set up a chapter server. Each Campus Lead can create one chapter server only.",
        });
      }

      const { data: leadChapters } = await supabase
        .from('chapters')
        .select('id')
        .eq('campus_lead_id', profile.id);

      if (leadChapters && leadChapters.length > 0) {
        const otherChapterIds = leadChapters.map((c) => c.id).filter((id) => id !== chapterId);
        if (otherChapterIds.length > 0) {
          const { data: otherGuildConfigs } = await supabase
            .from('guild_config')
            .select('guild_id, chapter_id')
            .in('chapter_id', otherChapterIds)
            .limit(1);

          if (otherGuildConfigs && otherGuildConfigs.length > 0) {
            return interaction.editReply({
              content: "You've already set up a chapter server. Each Campus Lead can create one chapter server only.",
            });
          }
        }
      }
    } catch (leadCheckErr) {
      console.warn('[chapter] Campus lead existing server check warning:', leadCheckErr.message);
    }

    // Verify current chapter has no guild_config entry yet
    const { data: existingGuild } = await supabase
      .from('guild_config')
      .select('guild_id')
      .eq('chapter_id', chapterId)
      .maybeSingle();

    if (existingGuild) {
      return interaction.editReply({
        content: `⚠️ Your chapter **${chapterName}** already has an active Discord server configured (Server ID: \`${existingGuild.guild_id}\`). A chapter can only have one active server at a time.`,
      });
    }

    // Generate one-time setup token (valid for 1 hour)
    const { token, expiresAt } = await api.createChapterSetupToken(
      chapterId,
      interaction.user.id,
      profile.id
    );

    const templateLink = config.chapterTemplateUrl || 'https://discord.new/w44zY38vKP4h';
    let combinedInviteUrl = `https://discord.com/oauth2/authorize?client_id=${config.clientId}&permissions=8&scope=bot%20applications.commands&state=${encodeURIComponent(token)}`;
    if (config.oauthRedirectUri) {
      combinedInviteUrl += `&redirect_uri=${encodeURIComponent(config.oauthRedirectUri)}&response_type=code`;
    }

    const embed = new EmbedBuilder()
      .setColor(0xFF6B00)
      .setTitle(`🏛️ Provision Server: ${chapterName}`)
      .setDescription(
        `Hello **${profile.full_name || 'Campus Lead'}**! You are authorized to provision the official Discord server for **${chapterName}**.\n\n` +
        `**Step 1:** Create your server using this template:\n${templateLink}\n\n` +
        `**Step 2:** Invite the bot to your new server:\n${combinedInviteUrl}\n\n` +
        `_Tip: Once the bot joins your server, it will activate automatically! If you already invited the bot, simply type \`/chapter\` inside your chapter server to activate it directly._\n\n` +
        `⏱️ **Token Expiration:** 1 hour (<t:${Math.floor(new Date(expiresAt).getTime() / 1000)}:R>)`
      )
      .addFields(
        { name: 'Chapter Name', value: chapterName, inline: true },
        { name: 'Chapter ID', value: chapterElevatesId ? `\`${chapterElevatesId}\`` : `\`${chapterId}\``, inline: true }
      )
      .setFooter({ text: 'ElevatesOS Chapter Provisioning Engine' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },

  activateCurrentGuild,
};
