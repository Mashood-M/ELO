const { SlashCommandBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('create-cluster')
    .setDescription('Start a new event-based cluster/task thread in the main server.')
    .addStringOption((opt) => opt.setName('title').setDescription('Cluster/task title').setRequired(true))
    .addStringOption((opt) => opt.setName('description').setDescription('What this cluster is about'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageThreads),

  async execute(interaction) {
    const title = interaction.options.getString('title');
    const description = interaction.options.getString('description') || 'No description provided.';

    const forum = interaction.guild.channels.cache.find(
      (c) => c.name === 'doubts-and-help' && c.type === ChannelType.GuildForum
    );

    if (!forum) {
      await interaction.reply({
        content: "Couldn't find the #doubts-and-help forum channel. Make sure it exists and is a Forum Channel.",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply();

    const thread = await forum.threads.create({
      name: title,
      message: { content: `**${title}**\n\n${description}\n\nDrop your questions and progress here!` },
    });

    await interaction.editReply(`✅ Cluster created: ${thread}`);

    const updatesChannel = interaction.guild.channels.cache.find((c) => c.name === 'cluster-updates');
    if (updatesChannel) {
      updatesChannel.send(`🆕 New cluster started: **${title}** → ${thread}`);
    }
  },
};
