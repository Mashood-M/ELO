const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const api = require('../lib/api');
const { checkCommandPermission } = require('../lib/permissions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Unban a user by their Discord user ID.')
    .addStringOption((opt) => opt.setName('user_id').setDescription('Discord user ID to unban').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  async execute(interaction) {
    if (!(await checkCommandPermission(interaction, 'unban'))) return;

    await interaction.deferReply();

    const userId = interaction.options.getString('user_id');

    if (!interaction.guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)) {
      await interaction.editReply({
        content: "I don't have the **Ban Members** permission in this server. Please grant it in Server Settings > Roles.",
      });
      return;
    }

    try {
      await interaction.guild.members.unban(userId);
    } catch (err) {
      await interaction.editReply({ content: `Failed to unban: ${err.message}` });
      return;
    }

    await interaction.editReply(`✅ Unbanned user ID **${userId}**.`);

    const modLog = interaction.guild.channels.cache.find((c) => c.name === 'mod-log');
    if (modLog) modLog.send(`✅ **${userId}** unbanned by **${interaction.user.tag}**.`);

    const guildConfig = await api.getGuildConfig(interaction.guild.id).catch(() => null);
    api.logChapterEvent(interaction.client, guildConfig?.chapterId, interaction.guild.id, 'unban', {
      userId,
      by: interaction.user.tag,
    }).catch(() => {});
  },
};
