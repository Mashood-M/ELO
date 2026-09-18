const { Events, EmbedBuilder } = require('discord.js');
const config = require('../config');
const api = require('../lib/api');

// In-memory rate-limit map for unverified member nudges (userId -> timestamp)
const unverifiedNudgeMap = new Map();
const NUDGE_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

/**
 * MessageCreate event handler.
 * - Feature 2: DM-to-staff forwarding for general user inquiries
 * - Feature 3: Friendly nudge for unverified members posting in chapter guilds
 */
module.exports = {
  name: Events.MessageCreate,
  async execute(message) {
    if (message.author.bot) return;

    // FEATURE 2: DM-to-staff forwarding (no DMs are used for verification anymore)
    if (!message.guild) {
      if (!config.features?.dmForwarding) return;

      try {
        // Inform the user their message has been forwarded
        await message.reply(
          "I can't chat here directly, but I've forwarded your message to the Elevates team — they'll get back to you soon!"
        ).catch(() => {});

        // Build staff support embed
        const dmEmbed = new EmbedBuilder()
          .setColor(0xFF6B00)
          .setAuthor({
            name: `${message.author.tag || message.author.username} (${message.author.id})`,
            iconURL: message.author.displayAvatarURL(),
          })
          .setTitle('📩 New Direct Message from Member')
          .setDescription(message.content || '*(No text content / attachment only)*')
          .setFooter({ text: `User ID: ${message.author.id} • Elevates Staff Forwarding` })
          .setTimestamp(message.createdAt);

        if (message.attachments.size > 0) {
          const fileLinks = message.attachments.map((a) => `[${a.name}](${a.url})`).join('\n');
          dmEmbed.addFields({ name: 'Attachments', value: fileLinks });
        }

        // Locate designated staff channel in MAIN server
        let targetChannel = null;
        const targetChannelName = config.staffDmForwardChannel || 'bot-commands';

        const mainConfig = await api.getMainGuildConfig().catch(() => null);
        let mainGuild = null;

        if (mainConfig?.guildId) {
          mainGuild = message.client.guilds.cache.get(mainConfig.guildId) ||
            (await message.client.guilds.fetch(mainConfig.guildId).catch(() => null));
        }

        if (!mainGuild) {
          mainGuild = message.client.guilds.cache.first();
        }

        if (mainGuild) {
          targetChannel = mainGuild.channels.cache.find(
            (c) =>
              c.isTextBased &&
              c.isTextBased() &&
              c.name === targetChannelName &&
              c.permissionsFor(mainGuild.members.me)?.has('SendMessages')
          );
        }

        if (targetChannel) {
          await targetChannel.send({ embeds: [dmEmbed] });
        } else {
          console.warn(`[dmForwarding] Could not find channel #${targetChannelName} to forward DM.`);
        }
      } catch (err) {
        console.error('[dmForwarding] Error forwarding DM to staff:', err);
      }
      return;
    }

    // FEATURE 3: Nudge unverified members who post in public channels
    if (message.guild) {
      if (!config.features?.unverifiedNudge) return;

      try {
        const guildConfig = await api.getGuildConfig(message.guild.id).catch(() => null);
        if (guildConfig?.guildType !== 'chapter') return;

        const unverifiedRoleName = (config.roles.unverified || 'elevates').toLowerCase();
        const hasUnverifiedRole = message.member?.roles?.cache?.some(
          (r) => r.name.toLowerCase() === unverifiedRoleName
        );

        if (!hasUnverifiedRole) return;

        // Rate limit: 1 nudge every 10 minutes per user
        const now = Date.now();
        const lastNudge = unverifiedNudgeMap.get(message.author.id);
        if (lastNudge && now - lastNudge < NUDGE_COOLDOWN_MS) {
          return;
        }

        unverifiedNudgeMap.set(message.author.id, now);

        await message.reply(
          "Looks like you haven't linked your account yet! Head over to the **#link-server** channel to connect your ElevatesOS account."
        ).catch(() => {});
      } catch (err) {
        console.error('[unverifiedNudge] Error checking unverified member:', err);
      }
    }
  },
};
