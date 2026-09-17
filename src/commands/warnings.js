const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const api = require('../lib/api');
const { isLeadOrRep } = require('../lib/roleCheck');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('warnings')
    .setDescription("View a member's warning history.")
    .addUserOption((opt) => opt.setName('member').setDescription('Member to check').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  async execute(interaction) {
    if (!(await isLeadOrRep(interaction))) return;

    await interaction.deferReply({ ephemeral: true });

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
      .setColor(0xfee75c);

    await interaction.editReply({ embeds: [embed] });
  },
};
