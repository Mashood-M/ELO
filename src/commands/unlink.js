const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!(await checkCommandPermission(interaction, 'unlink'))) return;

    const target = interaction.options.getMember('member');
    if (!target) {
      await interaction.editReply({ content: 'That member is not in this server.' });
      return;
    }

    try {
      await api.unlinkIdentity(target.id, interaction.guild.id, `unlinked_by_${interaction.user.tag}`, interaction.client);
    } catch (err) {
      await interaction.editReply({ content: `Failed to unlink: ${err.message}` });
      return;
    }

    const verifiedRoles = interaction.guild.roles.cache.filter(
      (r) => !r.managed && (
        r.name.toLowerCase() === 'verified member' ||
        r.name.toLowerCase() === 'elevates • member' ||
        r.name.toLowerCase() === (config.roles.verified || '').toLowerCase()
      )
    );
    const unverifiedRole = interaction.guild.roles.cache.find(
      (r) => !r.managed && (
        r.name.toLowerCase() === 'unverified' ||
        r.name.toLowerCase() === (config.roles.unverified || 'elevates').toLowerCase()
      )
    );

    for (const [, vRole] of verifiedRoles) {
      if (target.roles.cache.has(vRole.id)) {
        await target.roles.remove(vRole).catch(() => {});
      }
    }
    if (unverifiedRole && !target.roles.cache.has(unverifiedRole.id)) {
      await target.roles.add(unverifiedRole).catch(() => {});
    }

    // Trigger complete de-provisioning across all guilds
    await api.syncUserAcrossGuilds(interaction.client, target.id).catch(() => {});

    await interaction.editReply(`🔗 **${target.user.tag}** has been unlinked from ElevatesOS. They will need to re-link to regain chapter access.`);

    const guildConfig = await api.getGuildConfig(interaction.guild.id).catch(() => null);
    api.logChapterEvent(interaction.client, guildConfig?.chapterId, interaction.guild.id, 'unlink', {
      targetId: target.id,
      targetTag: target.user.tag,
      by: interaction.user.tag,
    }, 'moderation').catch(() => {});
  },
};
