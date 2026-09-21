const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const api = require('../lib/api');
const supabase = require('../lib/supabase');
const config = require('../config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('chapter')
    .setDescription('Provision a new Discord server for your ElevatesOS Chapter (Campus Leads only).')
    .addStringOption((opt) =>
      opt
        .setName('chapter_id')
        .setDescription('Optional: Chapter Elevates ID (e.g. CHP-0033) or UUID')
        .setRequired(false)
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    // 1. Verify caller is in the MAIN server
    let guildConfig;
    try {
      guildConfig = await api.getGuildConfig(interaction.guildId);
    } catch (_) {}

    if (guildConfig && guildConfig.guildType !== 'main') {
      return interaction.editReply({
        content: '⚠️ The `/chapter` command can only be used in the Elevates **Main Server**.',
      });
    }

    // 2. Verify caller is linked to ElevatesOS
    const identity = await api.getIdentityByDiscordId(interaction.user.id);
    if (!identity || !identity.profile) {
      return interaction.editReply({
        content: '⚠️ You must link your ElevatesOS account first before provisioning a chapter server. Please run `/connect` or check `#link-server`.',
      });
    }

    const profile = identity.profile;
    const userRoles = identity.userRoles || [];

    const isFounderOrAdmin =
      profile.role === 'founder' ||
      profile.role === 'hq_admin' ||
      userRoles.some((r) => ['founder', 'hq_admin'].includes((r.role_key || r.role || '').toLowerCase()));

    // 3. Resolve chapter to provision (supports elevates_id e.g. CHP-0033 or UUID)
    const inputChapter = interaction.options.getString('chapter_id')?.trim();
    let targetChapter = null;

    if (inputChapter) {
      targetChapter = await api.getChapterByIdentifier(inputChapter);
      if (!targetChapter) {
        return interaction.editReply({
          content: `⚠️ Chapter not found for "${inputChapter}". Please verify your Elevates ID (e.g. CHP-0033) or UUID.`,
        });
      }

      // Check caller authorization for this specified chapter
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
        return interaction.editReply({
          content: `⚠️ You are not authorized as the Campus Lead for **${targetChapter.name}** (${targetChapter.elevates_id || targetChapter.id}).`,
        });
      }

      // Link campus_lead_id in chapters table if currently unassigned
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
      // Auto-detect chapter from caller's records
      // a. Check chapters table where caller is assigned as campus_lead_id
      const { data: directChapters } = await supabase
        .from('chapters')
        .select('*')
        .eq('campus_lead_id', profile.id);

      if (directChapters && directChapters.length > 0) {
        targetChapter = directChapters[0];
      }

      // b. Check user_roles for role_key = 'campus_lead'
      if (!targetChapter) {
        const leadRecord = userRoles.find(
          (r) => (r.role_key || r.role) === 'campus_lead' && r.chapter_id
        );
        if (leadRecord?.chapter_id) {
          targetChapter = await api.getChapterByIdentifier(leadRecord.chapter_id);
        }
      }

      // c. Check profile.chapter_id
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
          return interaction.editReply({
            content: '⚠️ As a Founder / Admin, please specify which chapter to provision (e.g. `/chapter chapter_id: CHP-0033`).',
          });
        }

        return interaction.editReply({
          content: '⚠️ Only verified **Campus Leads** assigned to an active ElevatesOS Chapter can provision chapter servers. If your chapter is assigned by Elevates ID (e.g. `CHP-0033`), specify it: `/chapter chapter_id: CHP-0033`.',
        });
      }
    }

    const chapterId = targetChapter.id;
    const chapterName = targetChapter.name || 'Your Chapter';
    const chapterElevatesId = targetChapter.elevates_id || null;

    // 4. RULE: One chapter server per Campus Lead
    // Query whether this Campus Lead's discord_user_id (or os_user_id) already has ANY
    // existing guild_config entry as the registered campus_lead for a different chapter.
    try {
      // 4a. Check guild_config directly for campus_lead_id / campus_lead_discord_id
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

      // 4b. Check if user is registered campus_lead of any chapter that already has a guild_config entry
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

      // 4c. Check if user has previously used a setup token for a different chapter
      const { data: usedTokens } = await supabase
        .from('chapter_setup_tokens')
        .select('chapter_id')
        .or(`campus_lead_id.eq.${profile.id},campus_lead_discord_id.eq.${interaction.user.id}`)
        .not('used_at', 'is', null)
        .neq('chapter_id', chapterId)
        .limit(1);

      if (usedTokens && usedTokens.length > 0) {
        return interaction.editReply({
          content: "You've already set up a chapter server. Each Campus Lead can create one chapter server only.",
        });
      }
    } catch (leadCheckErr) {
      console.warn('[chapter] Campus lead existing server check warning:', leadCheckErr.message);
    }

    // 5. Verify that this current chapter has no guild_config entry yet
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

    // 6. Generate one-time setup token (valid for 1 hour)
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
        `Clone this template to create your server: ${templateLink}\n\n` +
        `Invite the bot to your new server (this will activate it automatically): ${combinedInviteUrl}\n\n` +
        `⏱️ **Link Expiration:** 1 hour (<t:${Math.floor(new Date(expiresAt).getTime() / 1000)}:R>)\n\n` +
        `_Note: The invite link carries your secure one-time activation token and activates your chapter server automatically upon joining._`
      )
      .addFields(
        { name: 'Chapter Name', value: chapterName, inline: true },
        { name: 'Chapter ID', value: chapterElevatesId ? `\`${chapterElevatesId}\`` : `\`${chapterId}\``, inline: true }
      )
      .setFooter({ text: 'ElevatesOS Chapter Provisioning Engine' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
