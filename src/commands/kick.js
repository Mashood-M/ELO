const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const api = require('../lib/api');
const { checkCommandPermission } = require('../lib/permissions');
const config = require('../config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Kick a member from this server.')
    .addUserOption((opt) => opt.setName('member').setDescription('Member to kick').setRequired(true))
    .addStringOption((opt) => opt.setName('reason').setDescription('Reason'))
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),

  async execute(interaction) {
    if (!(await checkCommandPermission(interaction, 'kick'))) return;

    await interaction.deferReply({ ephemeral: true });

    const target = interaction.options.getMember('member');
    const reason = interaction.options.getString('reason') || 'No reason given';

    if (!target) {
      await interaction.editReply({ content: 'That member is not in this server.' });
      return;
    }

    if (!interaction.guild.members.me?.permissions.has(PermissionFlagsBits.KickMembers)) {
      await interaction.editReply({
        content: "I don't have the **Kick Members** permission in this server. Please grant it in Server Settings > Roles.",
      });
      return;
    }

    if (!target.kickable) {
      await interaction.editReply({
        content: "I can't kick that member. Their highest role is equal to or higher than mine, or they are the server owner.",
      });
      return;
    }

    try {
      await target.send(`You were removed from ${interaction.guild.name}. Reason: ${reason}`).catch(() => {});
      await target.kick(reason);
    } catch (err) {
      await interaction.editReply({ content: `Failed to kick: ${err.message}` });
      return;
    }

    await interaction.editReply(`👢 **${target.user.tag}** was kicked. Reason: ${reason}`);

    const modLog = interaction.guild.channels.cache.find((c) => c.name === 'mod-log');
    if (modLog) modLog.send(`👢 **${target.user.tag}** kicked by **${interaction.user.tag}**. Reason: ${reason}`);

    const guildConfig = await api.getGuildConfig(interaction.guild.id).catch(() => null);
    api.logChapterEvent(interaction.client, guildConfig?.chapterId, interaction.guild.id, 'kick', {
      targetId: target.id,
      targetTag: target.user.tag,
      reason,
      by: interaction.user.tag,
    }, 'moderation').catch(() => {});
  },
};
