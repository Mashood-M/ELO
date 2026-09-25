const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const api = require('../lib/api');
const { checkCommandPermission } = require('../lib/permissions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Log a warning against a member.')
    .addUserOption((opt) => opt.setName('member').setDescription('Member to warn').setRequired(true))
    .addStringOption((opt) => opt.setName('reason').setDescription('Reason').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!(await checkCommandPermission(interaction, 'warn'))) return;

    const target = interaction.options.getUser('member');
    const reason = interaction.options.getString('reason');

    try {
      await api.addWarning(target.id, interaction.guild.id, reason, interaction.user.tag);
    } catch (err) {
      await interaction.editReply({ content: `Failed to log warning: ${err.message}` });
      return;
    }

    await target.send(`⚠️ You received a warning in ${interaction.guild.name}: ${reason}`).catch(() => {});
    await interaction.editReply(`⚠️ **${target.tag}** warned. Reason: ${reason}`);

    const modLog = interaction.guild.channels.cache.find((c) => c.name === 'mod-log');
    if (modLog) modLog.send(`⚠️ **${target.tag}** warned by **${interaction.user.tag}**. Reason: ${reason}`);

    const guildConfig = await api.getGuildConfig(interaction.guild.id).catch(() => null);
    api.logChapterEvent(interaction.client, guildConfig?.chapterId, interaction.guild.id, 'warn', {
      targetId: target.id,
      targetTag: target.tag,
      reason,
      by: interaction.user.tag,
      by_id: interaction.user.id,
    }, 'moderation').catch(() => {});
  },
};
