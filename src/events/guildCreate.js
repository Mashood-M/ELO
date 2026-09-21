const { Events, EmbedBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const api = require('../lib/api');

module.exports = {
  name: Events.GuildCreate,
  async execute(guild) {
    console.log(`[GuildCreate] Joined new guild: "${guild.name}" (${guild.id}) with ${guild.memberCount} members.`);

    // 1. Wait a few seconds to allow the HTTP callback to finish first if they race
    await new Promise((resolve) => setTimeout(resolve, 4000));

    try {
      // 2. Check if guild_config already has an entry for this guild_id
      const config = await api.getGuildConfig(guild.id);
      if (config && (config.chapterId || config.guildType === 'main')) {
        console.log(`[GuildCreate] Guild ${guild.id} is already configured/activated (type: ${config.guildType}, chapter: ${config.chapterId}).`);
        return;
      }

      // 3. Fallback: If not activated, post friendly message in system/welcome channel
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
        const warningEmbed = new EmbedBuilder()
          .setColor(0xF59E0B)
          .setTitle('⚠️ Server Not Activated')
          .setDescription(
            '⚠️ This chapter server has not been activated yet. Your Campus Lead must generate an activation link using `/chapter` in the Elevates Main Server.'
          )
          .setFooter({ text: 'ElevatesOS Chapter Provisioning Engine' })
          .setTimestamp();

        await welcomeChannel.send({ embeds: [warningEmbed] }).catch(() => {});
      }
    } catch (err) {
      console.error('[GuildCreate] Error handling guild join fallback:', err);
    }
  },
};
