const { Events, EmbedBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const api = require('../lib/api');
const { ensureLinkChannel } = require('../lib/accountLinking');

module.exports = {
  name: Events.GuildCreate,
  async execute(guild) {
    console.log(`[GuildCreate] Joined new guild: "${guild.name}" (${guild.id}) with ${guild.memberCount} members.`);

    try {
      // Check if guild is already configured
      const config = await api.getGuildConfig(guild.id);
      if (config && config.chapterId) {
        console.log(`[GuildCreate] Guild ${guild.id} is already configured for chapter ${config.chapterId}.`);
        await ensureLinkChannel(guild);
        return;
      }

      // If not configured, check if we have permission to post a welcome message
      const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
      if (!me) return;

      const welcomeChannel =
        guild.systemChannel ||
        guild.channels.cache.find(
          (c) =>
            c.type === ChannelType.GuildText &&
            c.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)
        );

      if (welcomeChannel) {
        const promptEmbed = new EmbedBuilder()
          .setColor(0xFF6B00)
          .setTitle('👋 ElevatesOS Bot Initialized')
          .setDescription(
            `Thank you for inviting the **ElevatesOS Bot** to **${guild.name}**!\n\n` +
            `If this is a new chapter server, please have your **Campus Lead** complete server activation by running:\n` +
            '```\n/activate-chapter token:<YOUR_SETUP_TOKEN>\n```\n' +
            '_Tokens are obtained by running `/chapter` in the Elevates Main Server._'
          )
          .setFooter({ text: 'ElevatesOS Chapter Provisioning Engine' })
          .setTimestamp();

        await welcomeChannel.send({ embeds: [promptEmbed] }).catch(() => {});
      }

      // Ensure link portal channel is prepared
      await ensureLinkChannel(guild);
    } catch (err) {
      console.error('[GuildCreate] Error handling guild join:', err);
    }
  },
};
