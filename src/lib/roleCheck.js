const { PermissionFlagsBits } = require('discord.js');
const config = require('../config');

/**
 * Confirms the interacting member has at least one of the allowed role names,
 * has a Founder or Admin role, or is a Server Administrator.
 * Always re-checked server-side even though slash commands also restrict
 * visibility by permission, since template clones can drift.
 */
async function requireRole(interaction, allowedRoleNames) {
  const member = interaction.member;
  if (!member) {
    await interaction.reply({ content: "Couldn't verify your roles here.", ephemeral: true });
    return false;
  }

  // Administrators and guild owners always have full moderation permission
  if (
    (interaction.guild && interaction.guild.ownerId === interaction.user.id) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
    (member.permissions && typeof member.permissions.has === 'function' && member.permissions.has(PermissionFlagsBits.Administrator))
  ) {
    return true;
  }

  // Include Founder and Admin role variants alongside command-specific allowed roles
  const founderVariants = [
    config.roles.founder,
    config.roles.admin,
    'ELEVATES • Founder',
    'ELEVATES • Admin',
    'Founder',
    'Founders',
    'Admin',
    'Administrator',
  ].filter(Boolean);

  const allAllowed = [...allowedRoleNames, ...founderVariants];

  const hasRole = Boolean(
    member.roles?.cache?.some((memberRole) => {
      const roleName = memberRole.name.toLowerCase().trim();
      // 1. Direct match with configured or known role names
      if (allAllowed.some((allowed) => allowed && roleName === allowed.toLowerCase().trim())) {
        return true;
      }
      // 2. Keyword match for Founder or Admin in custom server role names (e.g. "ELEVATES • Founder")
      if (roleName.includes('founder') || roleName.includes('admin')) {
        return true;
      }
      return false;
    })
  );

  if (!hasRole) {
    await interaction.reply({
      content: "You don't have permission to use this command.",
      ephemeral: true,
    });
    return false;
  }

  return true;
}

const isCampusLead = (interaction) => requireRole(interaction, [config.roles.campusLead]);
const isLeadOrRep = (interaction) => requireRole(interaction, [config.roles.campusLead, config.roles.classRep]);
const isFounder = (interaction) => requireRole(interaction, [config.roles.founder, 'Founder', 'Founders']);

module.exports = { requireRole, isCampusLead, isLeadOrRep, isFounder };
