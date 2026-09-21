const { Events } = require('discord.js');
const config = require('../config');
const api = require('../lib/api');
const { ensureLinkChannel } = require('../lib/accountLinking');

module.exports = {
  name: Events.GuildMemberAdd,
  async execute(member) {
    try {
      const guild = member.guild;
      let guildConfig = null;
      try {
        guildConfig = await api.getGuildConfig(guild.id);
      } catch (err) {
        console.error('[guildMemberAdd] Failed to fetch guild config:', err.message);
      }

      // Check if user is ALREADY linked to ElevatesOS identity
      const identity = await api.getIdentityByDiscordId(member.id);

      if (identity && identity.profile) {
        console.log(`[guildMemberAdd] Member ${member.user.tag} is already linked as ${identity.name}. Syncing roles immediately.`);
        // Sync roles and nickname across this guild immediately!
        await api.syncUserAcrossGuilds(member.client, member.id);

        api.logChapterEvent(member.client, guildConfig?.chapterId, guild.id, 'join_verified', {
          username: member.user.tag,
          discord_user_id: member.id,
          name: identity.name,
        }, 'membership').catch(() => {});
        return;
      }

      // Member is NOT linked yet
      if (guildConfig?.guildType === 'chapter') {
        // 1. Assign Unverified role
        const unverifiedRole = guild.roles.cache.find(
          (r) => !r.managed && r.name.toLowerCase() === (config.roles.unverified || 'elevates').toLowerCase()
        );
        if (unverifiedRole) {
          await member.roles.add(unverifiedRole).catch((err) =>
            console.error('[guildMemberAdd] Could not assign Unverified role:', err.message)
          );
        }

        // 2. Ensure #link-server has the public embed & button
        await ensureLinkChannel(guild);

        // 3. Post a friendly public welcome in #link-server or #welcome (NO DMs!)
        const linkChannel = guild.channels.cache.find(
          (c) => c.name === 'link-server' || c.name === 'welcome' || c.name.includes('verify')
        );

        if (linkChannel && linkChannel.permissionsFor(guild.members.me)?.has('SendMessages')) {
          linkChannel.send({
            content: `👋 Welcome ${member}! Please click the **🔗 Connect Account** button above to connect your ElevatesOS account and unlock chapter clusters and tasks.`,
          }).catch(() => {});
        }

        // Audit log
        api.logChapterEvent(member.client, guildConfig.chapterId, guild.id, 'join_unverified', {
          username: member.user.tag,
          discord_user_id: member.id,
        }, 'membership').catch(() => {});
      } else {
        // Main server join
        const generalChannel = guild.channels.cache.find((c) => c.name === 'general-chat' || c.name === 'general');
        if (generalChannel) {
          generalChannel.send(`Welcome ${member} to Elevates! Check out #link-server to connect your account.`).catch(() => {});
        }
      }
    } catch (err) {
      console.error('[guildMemberAdd] Uncaught error handling new member:', err);
    }
  },
};
