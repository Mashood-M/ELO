const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const api = require('../lib/api');
const { checkCommandPermission } = require('../lib/permissions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a member from this server.')
    .addUserOption((opt) => opt.setName('member').setDescription('Member to ban').setRequired(true))
    .addStringOption((opt) => opt.setName('reason').setDescription('Reason'))
    .addIntegerOption((opt) =>
      opt.setName('delete_days').setDescription('Days of message history to delete (0-7)').setMinValue(0).setMaxValue(7)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  async execute(interaction) {
    if (!(await checkCommandPermission(interaction, 'ban'))) return;

    await interaction.deferReply({ ephemeral: true });

    const target = interaction.options.getUser('member');
    const reason = interaction.options.getString('reason') || 'No reason given';
    const deleteDays = interaction.options.getInteger('delete_days') || 0;

    if (!interaction.guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)) {
      await interaction.editReply({
        content: "I don't have the **Ban Members** permission in this server. Please grant it to my role in Server Settings > Roles.",
      });
      return;
    }

    try {
      const member = await interaction.guild.members.fetch(target.id).catch(() => null);
      if (member) {
        if (!member.bannable) {
          await interaction.editReply({
            content: `I cannot ban **${target.tag}**. Their highest role is equal to or higher than my role, or they are the server owner.`,
          });
          return;
        }
        await member.send(`You were banned from ${interaction.guild.name}. Reason: ${reason}`).catch(() => {});
      }
      await interaction.guild.members.ban(target.id, { reason, deleteMessageSeconds: deleteDays * 86400 });
    } catch (err) {
      await interaction.editReply({ content: `Failed to ban: ${err.message}` });
      return;
    }

    await interaction.editReply(`🔨 **${target.tag}** was banned. Reason: ${reason}`);

    const modLog = interaction.guild.channels.cache.find((c) => c.name === 'mod-log');
    if (modLog) modLog.send(`🔨 **${target.tag}** banned by **${interaction.user.tag}**. Reason: ${reason}`);

    const guildConfig = await api.getGuildConfig(interaction.guild.id).catch(() => null);
    api.logChapterEvent(interaction.client, guildConfig?.chapterId, interaction.guild.id, 'ban', {
      targetId: target.id,
      targetTag: target.tag,
      reason,
      by: interaction.user.tag,
    }, 'moderation').catch(() => {});
  },
};
