const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const api = require('../lib/api');
const { checkCommandPermission } = require('../lib/permissions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('warnings')
    .setDescription("View a member's warning history.")
    .addUserOption((opt) => opt.setName('member').setDescription('Member to check').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!(await checkCommandPermission(interaction, 'warnings'))) return;

    const target = interaction.options.getUser('member');

    let warnings;
    try {
      warnings = await api.getWarnings(interaction.guild.id, target.id);
    } catch (err) {
      await interaction.editReply({ content: `Couldn't fetch warnings: ${err.message}` });
      return;
    }

    const list = (warnings.items || []);
    const description = list.length
      ? list.map((w, i) => `**${i + 1}.** ${w.reason} — _${w.issuedBy}, ${new Date(w.createdAt).toLocaleDateString()}_`).join('\n')
      : '_No warnings on record._';

    const embed = new EmbedBuilder()
      .setTitle(`Warnings for ${target.tag}`)
      .setDescription(description)
      .setColor(0xFEE75C);

    await interaction.editReply({ embeds: [embed] });

    const guildConfig = await api.getGuildConfig(interaction.guild.id).catch(() => null);
    api.logChapterEvent(interaction.client, guildConfig?.chapterId, interaction.guild.id, 'warnings_viewed', {
      targetId: target.id,
      targetTag: target.tag,
      viewedBy: interaction.user.tag,
    }, 'moderation').catch(() => {});
  },
};
