const { PermissionFlagsBits } = require('discord.js');
const api = require('./api');
const config = require('../config');

/**
 * Permission matrix defining which ElevatesOS role keys can execute commands
 * based on the server type ('main' vs 'chapter').
 */
const COMMAND_PERMISSIONS = {
  main: {
    // Founders and HQ Admins have full access across the main server
    founder: ['*'],
    hq_admin: ['*'],
    hq_mentor: ['warn', 'warnings'],
    // Campus Leads can execute /chapter in the main server to provision their chapter server
    campus_lead: ['chapter'],
  },
  chapter: {
    // Founders and HQ Admins have oversight access across all chapter servers
    founder: ['*'],
    hq_admin: ['*'],
    // Campus Lead has full access in their OWN chapter server
    campus_lead: [
      'kick',
      'ban',
      'unban',
      'mute',
      'warn',
      'warnings',
      'unlink',
      'announce',
      'reply-as-bot',
      'cluster',
    ],
    // Class Representative has kick/mute/warn/warnings in their OWN chapter server only (NOT ban, unban, unlink)
    class_representative: ['kick', 'mute', 'warn', 'warnings', 'cluster'],
    class_rep: ['kick', 'mute', 'warn', 'warnings', 'cluster'],
    // Regular students can run informational commands like /cluster
    student: ['cluster'],
  },
};

/**
 * Evaluates whether a Discord user is authorized to execute a command in a guild
 * based strictly on their ElevatesOS identity link, OS roles, and guild configuration.
 *
 * @param {string} discordUserId - The Discord Snowflake ID of the user.
 * @param {string} guildId - The Discord Guild ID where the command was run.
 * @param {string} commandName - The command name (e.g. 'kick', 'ban', 'chapter').
 * @param {object} [member] - Optional GuildMember for Discord owner/admin fallback.
 * @returns {Promise<{ allowed: boolean, reason?: string, osUser?: object, guildConfig?: object }>}
 */
async function canUserExecuteCommand(discordUserId, guildId, commandName, member = null) {
  // 1. Fetch guild configuration (identifies 'main' vs 'chapter' and chapter_id)
  let guildConfig = null;
  try {
    guildConfig = await api.getGuildConfig(guildId);
  } catch (err) {
    console.error('[Permissions] Error fetching guild config:', err.message);
  }

  const guildType = guildConfig?.guildType || 'chapter';
  const guildChapterId = guildConfig?.chapterId || guildConfig?.chapter_id || null;

  // 2. Fetch user's ElevatesOS identity and active roles
  const identity = await api.getIdentityByDiscordId(discordUserId);

  // If user is Discord Guild Owner or Discord Administrator, provide safety fallback
  if (member) {
    const isOwner = member.guild?.ownerId === discordUserId;
    const isDiscordAdmin =
      member.permissions?.has && member.permissions.has(PermissionFlagsBits.Administrator);

    // If owner or discord admin, allow execution
    if (isOwner || isDiscordAdmin) {
      return { allowed: true, identity, guildConfig };
    }
  }

  // If user is not linked to any ElevatesOS account, deny access
  if (!identity || !identity.profile) {
    return {
      allowed: false,
      reason: 'Your Discord account is not linked to ElevatesOS. Run `/connect` or use `#link-server` first.',
      identity: null,
      guildConfig,
    };
  }

  const profile = identity.profile;
  const userRoles = identity.userRoles || [];

  // 3. Extract caller's relevant roles
  // Check global / HQ roles: founder, hq_admin, hq_mentor
  const hqRoleKeys = new Set(
    userRoles
      .filter((r) => !r.chapter_id || r.scope === 'hq' || ['founder', 'hq_admin', 'hq_mentor'].includes(r.role_key || r.role))
      .map((r) => (r.role_key || r.role || '').toLowerCase().trim())
  );

  // If profile itself has founder or admin designation
  if (profile.role && ['founder', 'hq_admin'].includes(profile.role.toLowerCase())) {
    hqRoleKeys.add(profile.role.toLowerCase());
  }

  // Check Founders / HQ Admin oversight (always allowed if founder or hq_admin)
  if (hqRoleKeys.has('founder') || hqRoleKeys.has('hq_admin')) {
    return { allowed: true, identity, guildConfig };
  }

  // 4. Server-specific checks
  if (guildType === 'main') {
    // In main server: check main permissions
    const allowedMainCommands = new Set();
    for (const r of hqRoleKeys) {
      const perms = COMMAND_PERMISSIONS.main[r] || [];
      for (const p of perms) allowedMainCommands.add(p);
    }

    // Check if user has campus_lead role in any chapter
    const isCampusLeadSomewhere =
      userRoles.some((r) => (r.role_key || r.role) === 'campus_lead') ||
      profile.designation === 'campus_lead' ||
      profile.role === 'campus_lead';

    if (isCampusLeadSomewhere) {
      for (const p of COMMAND_PERMISSIONS.main.campus_lead) {
        allowedMainCommands.add(p);
      }
    }

    if (allowedMainCommands.has('*') || allowedMainCommands.has(commandName)) {
      return { allowed: true, identity, guildConfig };
    }

    return {
      allowed: false,
      reason: `You do not have permission to run \`/${commandName}\` in the main server. This requires Founder or HQ Admin privileges.`,
      identity,
      guildConfig,
    };
  }

  // For chapter guilds:
  if (guildType === 'chapter') {
    if (!guildChapterId) {
      return {
        allowed: false,
        reason: 'This chapter server is not properly configured with a chapter ID.',
        identity,
        guildConfig,
      };
    }

    // Check user's chapter assignment: MUST match this chapter's ID!
    const userChapterId = profile.chapter_id;
    const hasChapterRoleInThisChapter = userRoles.some(
      (r) => r.chapter_id === guildChapterId
    );

    if (userChapterId !== guildChapterId && !hasChapterRoleInThisChapter) {
      return {
        allowed: false,
        reason: 'You are not a registered member of this chapter.',
        identity,
        guildConfig,
      };
    }

    // Extract roles held SPECIFICALLY in this chapter
    const chapterRoleKeys = new Set(
      userRoles
        .filter((r) => r.chapter_id === guildChapterId || !r.chapter_id)
        .map((r) => (r.role_key || r.role || '').toLowerCase().trim())
    );

    if (profile.chapter_id === guildChapterId) {
      if (profile.designation) chapterRoleKeys.add(profile.designation.toLowerCase().trim());
      if (profile.role) chapterRoleKeys.add(profile.role.toLowerCase().trim());
    }

    // Check permissions in chapter server
    const allowedChapterCommands = new Set();
    for (const r of chapterRoleKeys) {
      const perms = COMMAND_PERMISSIONS.chapter[r] || [];
      for (const p of perms) allowedChapterCommands.add(p);
    }

    if (allowedChapterCommands.has('*') || allowedChapterCommands.has(commandName)) {
      return { allowed: true, identity, guildConfig };
    }

    return {
      allowed: false,
      reason: `You do not have permission to run \`/${commandName}\` in this chapter server. Your current role is: **${Array.from(chapterRoleKeys).join(', ') || 'Student'}**.`,
      identity,
      guildConfig,
    };
  }

  return {
    allowed: false,
    reason: `Command \`/${commandName}\` is not permitted in this server type.`,
    identity,
    guildConfig,
  };
}

/**
 * Convenient wrapper for interaction execution.
 * Checks permission and automatically replies ephemerally if permission is denied.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {string} commandName
 * @returns {Promise<boolean>} True if allowed to proceed, false if denied.
 */
async function checkCommandPermission(interaction, commandName) {
  const result = await canUserExecuteCommand(
    interaction.user.id,
    interaction.guildId,
    commandName,
    interaction.member
  );

  if (!result.allowed) {
    const errorMsg = result.reason || "You don't have permission to use this command.";
    if (interaction.deferred) {
      await interaction.editReply({ content: `⚠️ ${errorMsg}`, flags: [1 << 6] }).catch(() => {});
    } else {
      await interaction.reply({ content: `⚠️ ${errorMsg}`, ephemeral: true }).catch(() => {});
    }
    return false;
  }

  return true;
}

module.exports = {
  COMMAND_PERMISSIONS,
  canUserExecuteCommand,
  checkCommandPermission,
};
