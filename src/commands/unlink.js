const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const config = require('../config');
const api = require('../lib/api');
const { checkCommandPermission } = require('../lib/permissions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unlink')
    .setDescription("Force-unlink a member's ElevatesOS account from Discord.")
    .addUserOption((opt) => opt.setName('member').setDescription('Member to unlink').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    if (!(await checkCommandPermission(interaction, 'unlink'))) return;

    await interaction.deferReply({ ephemeral: true });

    const target = interaction.options.getMember('member');
    if (!target) {
      await interaction.editReply({ content: 'That member is not in this server.' });
      return;
    }

    try {
      await api.unlinkIdentity(target.id, interaction.guild.id, `unlinked_by_${interaction.user.tag}`);
    } catch (err) {
      await interaction.editReply({ content: `Failed to unlink: ${err.message}` });
      return;
    }

    const verifiedRole = interaction.guild.roles.cache.find(
      (r) => r.name.toLowerCase() === (config.roles.verified || 'ELEVATES • Member').toLowerCase()
    );
    const unverifiedRole = interaction.guild.roles.cache.find(
      (r) => r.name.toLowerCase() === (config.roles.unverified || 'elevates').toLowerCase()
    );

    if (verifiedRole) await target.roles.remove(verifiedRole).catch(() => {});
    if (unverifiedRole) await target.roles.add(unverifiedRole).catch(() => {});

    await interaction.editReply(`🔗 **${target.user.tag}** has been unlinked from ElevatesOS. They will need to re-link to regain chapter access.`);

    const guildConfig = await api.getGuildConfig(interaction.guild.id).catch(() => null);
    api.logChapterEvent(interaction.client, guildConfig?.chapterId, interaction.guild.id, 'unlink', {
      targetId: target.id,
      targetTag: target.user.tag,
      by: interaction.user.tag,
    }, 'moderation').catch(() => {});
  },
};
