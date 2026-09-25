const { Events } = require('discord.js');
const api = require('../lib/api');

module.exports = {
  name: Events.GuildRoleUpdate,
  async execute(oldRole, newRole) {
    try {
      if (!newRole.guild) return;

      const guildConfig = await api.getGuildConfig(newRole.guild.id).catch(() => null);
      if (!guildConfig || guildConfig.guildType !== 'chapter' || !guildConfig.chapterId) return;

      const nameChanged = oldRole.name !== newRole.name;
      const colorChanged = oldRole.hexColor !== newRole.hexColor;
      const permsChanged = oldRole.permissions.bitfield !== newRole.permissions.bitfield;

      if (!nameChanged && !colorChanged && !permsChanged) return;

      const details = {
        role: newRole.name,
      };

      if (nameChanged) {
        details.name_change = `\`${oldRole.name}\` ➔ \`${newRole.name}\``;
      }
      if (colorChanged) {
        details.color_change = `${oldRole.hexColor} ➔ ${newRole.hexColor}`;
      }
      if (permsChanged) {
        const addedPerms = newRole.permissions.toArray().filter((p) => !oldRole.permissions.has(p));
        const removedPerms = oldRole.permissions.toArray().filter((p) => !newRole.permissions.has(p));
        if (addedPerms.length > 0) details.granted_permissions = addedPerms.join(', ');
        if (removedPerms.length > 0) details.revoked_permissions = removedPerms.join(', ');
      }

      await api.logChapterEvent(
        newRole.client,
        guildConfig.chapterId,
        newRole.guild.id,
        'role_updated',
        details,
        'channel_role_changes'
      );
    } catch (err) {
      console.error('[roleUpdate] Error logging role update:', err.message);
    }
  },
};
