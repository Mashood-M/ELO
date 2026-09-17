/**
 * CHANNEL PERMISSIONS (Manual Discord server-side setup):
 * The "Guest" role should be denied View Channel on the CLUSTERS & TASKS and EVENTS
 * categories, same as Unverified currently is.
 * However, Guest should be allowed to see GENERAL (#general-chat, #introductions)
 * and WELCOME (#rules, #announcements) — unlike Unverified, which is more restricted.
 * Ensure this permission scheme is configured when cloning the Server Template.
 */

const {
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const config = require('../config');
const api = require('../lib/api');
const verifySessions = require('../lib/verifySessions');

// Arcade color theme
const THEME_COLOR = 0xFF6B00; // Warm arcade orange
const PLACEHOLDER_THUMBNAIL = 'https://cdn.elevates.org/assets/arcade-avatar-placeholder.png';

module.exports = {
  name: Events.GuildMemberAdd,
  async execute(member) {
    try {
      let guildConfig;
      try {
        guildConfig = await api.getGuildConfig(member.guild.id);
      } catch (err) {
        console.error('Failed to fetch guild config on join:', err.message);
        return; // fail safe: don't gate access if the API is down
      }

      // Main server: no verification, just a light welcome.
      if (!guildConfig || guildConfig.guildType === 'main') {
        const generalChannel = member.guild.channels.cache.find((c) => c.name === 'general-chat');
        if (generalChannel) {
          generalChannel.send(`Welcome ${member}! Check out #rules and #cluster-updates to see what's active.`).catch(() => {});
        }
        return;
      }

      if (guildConfig.guildType === 'chapter') {
        // 1. Assign existing Unverified role immediately (ensure it's not a bot-managed role)
        const unverifiedRole = member.guild.roles.cache.find(
          (r) => !r.managed && r.name.toLowerCase() === config.roles.unverified?.toLowerCase()
        );
        if (unverifiedRole) {
          try {
            await member.roles.add(unverifiedRole);
          } catch (err) {
            console.error('Could not assign Unverified role:', err.message);
          }
        }

        // Track the verification session
        verifySessions.start(member.id, member.guild.id);

        const chapterName = guildConfig.chapterName || 'Chapter';

        // 2. Build arcade-styled Embed & Buttons
        const welcomeEmbed = new EmbedBuilder()
          .setColor(THEME_COLOR)
          .setTitle('🕹️ WELCOME PLAYER — ACCOUNT CHECK')
          .setDescription(
            `Welcome to the **${chapterName}** server! 🎮\n\n` +
            `To unlock full chapter access, clusters, and official roles, link your **ElevatesOS** account.\n\n` +
            `**Do you already have an ElevatesOS account?**`
          )
          .setThumbnail(PLACEHOLDER_THUMBNAIL)
          .setFooter({ text: 'ElevatesOS x Discord' })
          .setTimestamp();

        const buttonRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('os_link_yes')
            .setLabel('✅ Yes, I have an account')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId('os_link_no')
            .setLabel("🆕 No, I'm new here")
            .setStyle(ButtonStyle.Secondary)
        );

        // Find the server's welcome or verification channel
        const me = member.guild.members.me;
        const welcomeChannel = member.guild.channels.cache.find(
          (c) =>
            c.isTextBased &&
            c.isTextBased() &&
            (c.name === 'verify-here' || c.name.includes('welcome') || c.name.includes('verify')) &&
            c.permissionsFor(me)?.has('SendMessages')
        );

        // 1. Always post in the welcome channel so the user sees it in the server
        if (welcomeChannel) {
          const canEmbed = welcomeChannel.permissionsFor(me)?.has('EmbedLinks');
          const payload = {
            content: `👋 Welcome ${member}! **ELEVATES ACCOUNT CONNECT** 🎮\n` +
              `Link your **ElevatesOS** account below to unlock chapter clusters, tasks, and member roles:\n` +
              '*(Tip: You can also use `/connect` anywhere in the server)*',
            components: [buttonRow],
          };
          if (canEmbed) {
            payload.embeds = [welcomeEmbed];
          }

          await welcomeChannel.send(payload).catch((err) => {
            console.error('Could not post to welcome channel:', err.message);
          });
        } else {
          console.warn(
            `[guildMemberAdd] Bot lacks SendMessages permission in the welcome channel.`
          );
        }

        // 2. Also send via Direct Message
        await member.send({
          embeds: [welcomeEmbed],
          components: [buttonRow],
        }).catch(() => {
          // DMs closed, already posted in welcome channel
        });

        api.logEvent(member.guild.id, member.id, 'join', { username: member.user.tag }).catch(() => {});
      }
    } catch (err) {
      console.error('[guildMemberAdd] Uncaught error handling new member:', err);
    }
  },
};
