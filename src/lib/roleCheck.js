const { checkCommandPermission } = require('./permissions');

/**
 * Backward compatibility wrapper delegating to permissions.js.
 */
async function requireRole(interaction, allowedRoleNames) {
  return checkCommandPermission(interaction, interaction.commandName || 'moderation');
}

const isCampusLead = (interaction) => checkCommandPermission(interaction, interaction.commandName || 'campus_lead');
const isLeadOrRep = (interaction) => checkCommandPermission(interaction, interaction.commandName || 'lead_or_rep');
const isFounder = (interaction) => checkCommandPermission(interaction, interaction.commandName || 'founder');

module.exports = { requireRole, isCampusLead, isLeadOrRep, isFounder };
