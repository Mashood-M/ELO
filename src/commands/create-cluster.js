const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('create-cluster')
    .setDescription('Create a new cluster forum thread in #doubts-and-help.')
    .addStringOption((opt) => opt.setName('title').setDescription('Cluster title').setRequired(true))
    .addStringOption((opt) => opt.setName('description').setDescription('Cluster description').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageThreads),

  async execute(interaction) {
    await interaction.deferReply();

    const title = interaction.options.getString('title');
    const description = interaction.options.getString('description');

    const forum = interaction.guild.channels.cache.find(
      (c) => c.name === 'doubts-and-help' && c.type === ChannelType.GuildForum
    );

    if (!forum) {
      await interaction.editReply({
        content: "Couldn't find the #doubts-and-help forum channel. Make sure it exists and is a Forum Channel.",
      });
      return;
    }

    const thread = await forum.threads.create({
      name: title,
      message: { content: `**${title}**\n\n${description}\n\nDrop your questions and progress here!` },
    });

    await interaction.editReply(`✅ Cluster created: ${thread}`);
  },
};
