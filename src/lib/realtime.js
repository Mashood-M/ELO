const supabase = require('./supabase');
const api = require('./api');

/**
 * Initializes Supabase Realtime listeners for automatic Discord role assignment
 * when users verify their OTP on Elevates OS.
 */
function initRealtimeSync(client) {
  if (!supabase) return;

  try {
    const channel = supabase
      .channel('discord_links_realtime')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'discord_links',
        },
        async (payload) => {
          try {
            const row = payload.new;
            if (!row || row.status !== 'linked') return;

            const guildId = row.guild_id;
            const discordUserId = row.discord_user_id;
            if (!guildId || !discordUserId) return;

            const guild = client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId).catch(() => null));
            if (!guild) return;

            const member = await guild.members.fetch(discordUserId).catch(() => null);
            if (!member) return;

            const linkData = await api.getUserLink(discordUserId, guildId);
            if (!linkData) return;

            const synced = await api.syncMemberRoles(guild, member, {
              name: linkData.name,
              designation: linkData.designation || linkData.role,
            });

            if (synced) {
              const { postVerificationWelcomeCard } = require('./generateWelcomeCard');
              await postVerificationWelcomeCard(guild, member, linkData.name);

              const modLog = guild.channels.cache.find((c) => c.name === 'mod-log');
              if (modLog) {
                modLog.send(`✅ **${member.user.tag}** verified their ElevatesOS account as **${linkData.name || 'Member'}** via OTP.`);
              }

              member.send({
                content: `🎉 **ElevatesOS Connected!** Your verification was completed on Elevates OS. Your chapter roles and cluster access in **${guild.name}** are now fully active!`,
              }).catch(() => {});
            }
          } catch (err) {
            console.error('[RealtimeSync] Error processing discord_links change:', err);
          }
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log('[RealtimeSync] Subscribed to discord_links table changes.');
        }
      });

    return channel;
  } catch (err) {
    console.error('[RealtimeSync] Failed to initialize Realtime subscription:', err);
  }
}

module.exports = { initRealtimeSync };
