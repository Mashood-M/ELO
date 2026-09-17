const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const config = require('../config');
const api = require('../lib/api');
const { isCampusLead } = require('../lib/roleCheck');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unlink')
    .setDescription('Force-unlink a member\'s ElevatesOS account from Discord.')
    .addUserOption((opt) => opt.setName('member').setDescription('Member to unlink').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    if (!(await isCampusLead(interaction))) return;

    await interaction.deferReply();

    const target = interaction.options.getMember('member');
    if (!target) {
      await interaction.editReply({ content: 'That member is not in this server.' });
      return;
    }

    try {
      await api.unlinkUser(target.id, interaction.guild.id, 'manual_unlink');
    } catch (err) {
      await interaction.editReply({ content: `Failed to unlink: ${err.message}` });
      return;
    }

    const verifiedRole = interaction.guild.roles.cache.find((r) => r.name === config.roles.verified);
    const unverifiedRole = interaction.guild.roles.cache.find((r) => r.name === config.roles.unverified);
    if (verifiedRole) await target.roles.remove(verifiedRole).catch(() => {});
    if (unverifiedRole) await target.roles.add(unverifiedRole).catch(() => {});

    await interaction.editReply(`🔗 **${target.user.tag}** has been unlinked. They'll need to re-verify.`);

    api.logEvent(interaction.guild.id, target.id, 'unlink', { by: interaction.user.tag }).catch(() => {});
  },
};
