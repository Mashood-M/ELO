const {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!config.features?.adminBroadcast) {
      return interaction.editReply({
        content: '⚠️ Admin broadcast commands are currently disabled.',
      });
    }

    // Role check: Campus Lead (in their own chapter) or Founder/Admin
    if (!(await checkCommandPermission(interaction, 'announce'))) return;

    const targetChannel = interaction.options.getChannel('channel');
    const messageContent = interaction.options.getString('message');

    if (!targetChannel.permissionsFor(interaction.guild.members.me)?.has('SendMessages')) {
      return interaction.editReply({
        content: `⚠️ I do not have permission to send messages in ${targetChannel}.`,
      });
    }

    try {
      await targetChannel.send(messageContent);

      await interaction.editReply({
        content: `✅ Announcement posted successfully to ${targetChannel}.`,
      });

      const guildConfig = await api.getGuildConfig(interaction.guild.id).catch(() => null);
      api.logChapterEvent(interaction.client, guildConfig?.chapterId, interaction.guild.id, 'announce', {
        channelId: targetChannel.id,
        channelName: targetChannel.name,
        by: interaction.user.tag,
      }, 'channel_role_changes').catch(() => {});
    } catch (err) {
      console.error('[announce] Error broadcasting message:', err);
      await interaction.editReply({
        content: `Failed to send announcement: ${err.message}`,
      });
    }
  },
};
