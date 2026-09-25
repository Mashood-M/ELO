const { Events } = require('discord.js');
const config = require('../config');
const api = require('../lib/api');
const ticketSystem = require('../lib/ticketSystem');
const { handleLinkServerMessage } = require('../lib/codeVerification');

// In-memory rate-limit map for unverified member nudges (userId -> timestamp)
const unverifiedNudgeMap = new Map();
const NUDGE_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

// Periodic cleanup of stale nudge timestamps to prevent memory growth (Section 5.8)
setInterval(() => {
  const now = Date.now();
  for (const [userId, timestamp] of unverifiedNudgeMap.entries()) {
    if (now - timestamp > NUDGE_COOLDOWN_MS) {
      unverifiedNudgeMap.delete(userId);
    }
  }
}, 10 * 60 * 1000).unref();

/**
 * MessageCreate event handler.
 * - Feature 1: Code-paste account linking (#link-server channel)
 * - Feature 2: Lane-based ticketing system (users <-> staff forum threads)
 * - Feature 3: Friendly nudge for unverified members posting in chapter guilds
 */
module.exports = {
  name: Events.MessageCreate,
  async execute(message) {
    if (message.author.bot) return;

    // FEATURE 1: Code-paste account verification in #link-server
    if (message.guild && message.channel.name?.toLowerCase().trim() === 'link-server') {
      const handled = await handleLinkServerMessage(message);
      if (handled) return;
    }

    // FEATURE 2A: Incoming user DMs -> Ticket system entry point
    if (!message.guild) {
      console.log(`[DM] Received DM from ${message.author.tag} (${message.author.id}), routing to ticket system: "${message.content}"`);
      await ticketSystem.handleIncomingDm(message);
      return;
    }

    // FEATURE 2B: Staff replies inside ticket forum threads -> User DM
    if (message.guild && message.channel.isThread()) {
      const handled = await ticketSystem.handleStaffReply(message);
      if (handled) return;
    }

    // FEATURE 3: Nudge unverified members who post in public channels
    // Section 1.4: Old unverified-member-nudge MUST NOT fire inside #link-server itself
    if (message.guild) {
      if (message.channel.name?.toLowerCase().trim() === 'link-server') return;
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
