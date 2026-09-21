const {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');
const config = require('../config');
const api = require('../lib/api');
const { checkCommandPermission } = require('../lib/permissions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('announce')
    .setDescription('Broadcast an announcement message to a specific channel.')
    .addChannelOption((opt) =>
      opt
        .setName('channel')
        .setDescription('Channel to post the announcement in')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('message')
        .setDescription('The message content to broadcast')
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  async execute(interaction) {
    if (!config.features?.adminBroadcast) {
      return interaction.reply({
        content: '⚠️ Admin broadcast commands are currently disabled.',
        ephemeral: true,
      });
    }

    // Role check: Campus Lead (in their own chapter) or Founder/Admin
    if (!(await checkCommandPermission(interaction, 'announce'))) return;

    const targetChannel = interaction.options.getChannel('channel');
    const messageContent = interaction.options.getString('message');

    if (!targetChannel.permissionsFor(interaction.guild.members.me)?.has('SendMessages')) {
      return interaction.reply({
        content: `⚠️ I do not have permission to send messages in ${targetChannel}.`,
        ephemeral: true,
      });
    }

    try {
      await targetChannel.send(messageContent);

      await interaction.reply({
        content: `✅ Announcement posted successfully to ${targetChannel}.`,
        ephemeral: true,
      });

      const guildConfig = await api.getGuildConfig(interaction.guild.id).catch(() => null);
      api.logChapterEvent(interaction.client, guildConfig?.chapterId, interaction.guild.id, 'announce', {
        channelId: targetChannel.id,
        channelName: targetChannel.name,
        by: interaction.user.tag,
      }, 'channel_role_changes').catch(() => {});
    } catch (err) {
      console.error('[announce] Error broadcasting message:', err);
      await interaction.reply({
        content: `Failed to send announcement: ${err.message}`,
        ephemeral: true,
      });
    }
  },
};
