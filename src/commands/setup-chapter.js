const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const api = require('../lib/api');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('setup-chapter')
    .setDescription('One-time setup: link this server to an ElevatesOS chapter.')
    .addStringOption((opt) =>
      opt.setName('chapter_id').setDescription('The chapter ID from ElevatesOS').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    const chapterId = interaction.options.getString('chapter_id');

    await interaction.deferReply();

    let chapterInfo;
    try {
      chapterInfo = await api.setGuildConfig(interaction.guild.id, chapterId, 'chapter');
    } catch (err) {
      await interaction.editReply(`Couldn't set up this server: ${err.message}`);
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`🎉 ${chapterInfo.chapterName || 'Chapter'} server is live`)
      .setDescription(
        'This server is now linked to ElevatesOS.\n\n' +
        'New members will be asked to verify with their OS User ID before getting full access.'
      )
      .addFields(
        { name: 'Chapter ID', value: chapterId, inline: true },
        { name: 'Type', value: 'Chapter server', inline: true }
      )
      .setColor(0x5865f2);

    await interaction.editReply({ embeds: [embed] });
  },
};
