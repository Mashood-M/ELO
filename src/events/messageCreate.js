const { Events, EmbedBuilder } = require('discord.js');
const config = require('../config');
const api = require('../lib/api');
const verifySessions = require('../lib/verifySessions');

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

    // FEATURE 2: DM-to-staff forwarding
    if (!message.guild) {
      if (!config.features?.dmForwarding) return;

      // Only forward if the user does NOT have an active verification session
      const activeSession = verifySessions.get(message.author.id);
      if (activeSession) return;

      try {
        // Inform the user their message has been forwarded
        await message.reply(
          "I can't chat here directly, but I've forwarded your message to the team — they'll get back to you soon!"
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

        // 1. Try to find the configured 'main' guild
        const mainConfig = await api.getMainGuildConfig().catch(() => null);
        let mainGuild = null;

        if (mainConfig?.guildId) {
          mainGuild = message.client.guilds.cache.get(mainConfig.guildId) ||
            (await message.client.guilds.fetch(mainConfig.guildId).catch(() => null));
        }

        // Fallback: look through cached guilds if mainConfig wasn't explicitly set
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

        const unverifiedRoleName = config.roles.unverified?.toLowerCase();
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
          "Looks like you haven't verified yet! Check your DMs for the verification prompt, or ask a Campus Lead to resend it."
        ).catch(() => {});
      } catch (err) {
        console.error('[unverifiedNudge] Error checking unverified member:', err);
      }
    }
  },
};
