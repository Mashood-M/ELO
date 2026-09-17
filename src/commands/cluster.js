const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const api = require('../lib/api');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('cluster')
    .setDescription('Show the linked member count and list for this chapter.'),

  async execute(interaction) {
    await interaction.deferReply();

    let guildConfig;
    try {
      guildConfig = await api.getGuildConfig(interaction.guild.id);
    } catch (err) {
      await interaction.editReply("Couldn't reach ElevatesOS right now.");
      return;
    }

    if (!guildConfig || guildConfig.guildType !== 'chapter') {
      await interaction.editReply('This command only works in a chapter server.');
      return;
    }

    let cluster;
    try {
      cluster = await api.getClusterMembers(guildConfig.chapterId);
    } catch (err) {
      await interaction.editReply(`Couldn't fetch cluster data: ${err.message}`);
      return;
    }

    const members = cluster.members || [];
    const list = members.length
      ? members.map((m) => `• ${m.name} (${m.designation || 'student'})`).join('\n')
      : '_No verified members yet._';

    const embed = new EmbedBuilder()
      .setTitle(`📊 ${guildConfig.chapterName || 'Chapter'} Cluster`)
      .setDescription(`**${members.length}** verified member(s)`)
      .addFields({ name: 'Members', value: list.slice(0, 1024) })
      .setColor(0x57f287);

    await interaction.editReply({ embeds: [embed] });
  },
};
