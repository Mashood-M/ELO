const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const api = require('../lib/api');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('cluster')
    .setDescription('Show the linked member count and list for this chapter.'),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    let guildConfig;
    try {
      guildConfig = await api.getGuildConfig(interaction.guild.id);
    } catch (err) {
      await interaction.editReply("Couldn't reach ElevatesOS right now.");
      return;
    }

    if (!guildConfig || guildConfig.guildType !== 'chapter' || !guildConfig.chapterId) {
      await interaction.editReply('This command only works in an official chapter server.');
      return;
    }

    let cluster;
    try {
      cluster = await api.getClusterMembers(guildConfig.chapterId);
    } catch (err) {
      await interaction.editReply(`Couldn't fetch chapter member data: ${err.message}`);
      return;
    }

    const members = cluster.members || [];
    const list = members.length
      ? members.map((m) => `• **${m.name}** (${m.designation || 'student'})`).join('\n')
      : '_No verified members linked yet._';

    const embed = new EmbedBuilder()
      .setTitle(`📊 ${guildConfig.chapterName || 'Chapter'} Member Directory`)
      .setDescription(`**${members.length}** active verified member(s) linked on ElevatesOS`)
      .addFields({ name: 'Verified Members', value: list.slice(0, 1024) })
      .setColor(0x57F287)
      .setFooter({ text: 'ElevatesOS Identity Directory' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
 
     api.logChapterEvent(interaction.client, guildConfig.chapterId, interaction.guild.id, 'cluster_directory_viewed', {
       viewedBy: interaction.user.tag,
       userId: interaction.user.id,
       memberCount: members.length,
     }, 'cluster_activity').catch(() => {});
   },
};
