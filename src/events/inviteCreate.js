const { Events } = require('discord.js');
const api = require('../lib/api');

module.exports = {
  name: Events.InviteCreate,
  async execute(invite) {
    try {
      if (!invite.guild) return;

      const guildConfig = await api.getGuildConfig(invite.guild.id).catch(() => null);
      if (!guildConfig || guildConfig.guildType !== 'chapter' || !guildConfig.chapterId) return;

      await api.logChapterEvent(
        invite.client,
        guildConfig.chapterId,
        invite.guild.id,
        'invite_created',
        {
          code: invite.code,
          created_by: invite.inviter ? `<@${invite.inviter.id}> (${invite.inviter.tag})` : 'System',
          channel: invite.channel ? `<#${invite.channel.id}>` : 'None',
          max_uses: invite.maxUses === 0 ? 'Unlimited' : invite.maxUses,
          temporary: invite.temporary ? 'Yes' : 'No',
          expires_at: invite.expiresAt ? `<t:${Math.floor(invite.expiresAt.getTime() / 1000)}:R>` : 'Never',
          discord_user_id: invite.inviter?.id || null,
        },
        'discord_activity'
      );
    } catch (err) {
      console.error('[inviteCreate] Error logging invite create:', err.message);
    }
  },
};
