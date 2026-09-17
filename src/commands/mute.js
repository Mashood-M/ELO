const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const api = require('../lib/api');
const { isLeadOrRep } = require('../lib/roleCheck');

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };

function parseDuration(input) {
  const match = /^(\d+)([mhd])$/.exec(input.trim());
  if (!match) return null;
  const [, amount, unit] = match;
  return parseInt(amount, 10) * UNIT_MS[unit];
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mute')
    .setDescription('Timeout a member for a duration (e.g. 10m, 2h, 1d).')
    .addUserOption((opt) => opt.setName('member').setDescription('Member to mute').setRequired(true))
    .addStringOption((opt) => opt.setName('duration').setDescription('e.g. 10m, 2h, 1d').setRequired(true))
    .addStringOption((opt) => opt.setName('reason').setDescription('Reason'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  async execute(interaction) {
    if (!(await isLeadOrRep(interaction))) return;

    await interaction.deferReply();

    const target = interaction.options.getMember('member');
    const durationStr = interaction.options.getString('duration');
    const reason = interaction.options.getString('reason') || 'No reason given';

    const ms = parseDuration(durationStr);
    if (!ms || ms > 28 * 86_400_000) {
      await interaction.editReply({
        content: 'Invalid duration. Use formats like `10m`, `2h`, `1d` (max 28 days).',
      });
      return;
    }

    if (!target) {
      await interaction.editReply({ content: 'That member is not in this server.' });
      return;
    }

    if (!interaction.guild.members.me?.permissions.has(PermissionFlagsBits.ModerateMembers)) {
      await interaction.editReply({
        content: "I don't have the **Timeout Members** permission in this server. Please grant it in Server Settings > Roles.",
      });
      return;
    }

    if (!target.moderatable) {
      await interaction.editReply({
        content: "I can't timeout that member. Their highest role is equal to or higher than mine, or they are the server owner.",
      });
      return;
    }

    try {
      await target.timeout(ms, reason);
    } catch (err) {
      await interaction.editReply({ content: `Failed to mute: ${err.message}` });
      return;
    }

    await interaction.editReply(`🔇 **${target.user.tag}** muted for ${durationStr}. Reason: ${reason}`);

    const modLog = interaction.guild.channels.cache.find((c) => c.name === 'mod-log');
    if (modLog) modLog.send(`🔇 **${target.user.tag}** muted (${durationStr}) by **${interaction.user.tag}**. Reason: ${reason}`);

    api.logEvent(interaction.guild.id, target.id, 'mute', { durationStr, reason, by: interaction.user.tag }).catch(() => {});
  },
};
