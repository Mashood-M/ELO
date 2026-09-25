const { ContextMenuCommandBuilder, ApplicationCommandType, PermissionFlagsBits, MessageFlags } = require('discord.js');
const supabase = require('../lib/supabase');
const api = require('../lib/api');
const config = require('../config');

module.exports = {
  data: new ContextMenuCommandBuilder()
    .setName('Mark Task Complete')
    .setType(ApplicationCommandType.Message)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  async execute(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const message = interaction.targetMessage;
    const channel = interaction.channel;

    // 1. Only usable on messages posted inside an active task's forum thread
    if (!channel || !channel.isThread()) {
      return interaction.editReply({
        content: '⚠️ This command can only be used on messages posted inside an active cluster task forum thread.',
      });
    }

    // Lookup task from cluster_tasks by forum_thread_id
    const { data: task, error: taskErr } = await supabase
      .from('cluster_tasks')
      .select('*')
      .eq('forum_thread_id', channel.id)
      .maybeSingle();

    if (!task) {
      return interaction.editReply({
        content: '⚠️ This thread is not recognized as an active cluster task.',
      });
    }

    if (task.status !== 'active') {
      return interaction.editReply({
        content: '⚠️ This task is closed and is no longer accepting completions.',
      });
    }

    // 2. Fetch cluster info to check permissions
    const { data: cluster } = await supabase
      .from('clusters')
      .select('*')
      .eq('id', task.cluster_id)
      .maybeSingle();

    if (!cluster) {
      return interaction.editReply({
        content: '⚠️ Could not find the cluster associated with this task.',
      });
    }

    // Check caller permissions: restricted to Host/Campus Lead/Executive Member of that cluster
    const callerIdentity = await api.getIdentityByDiscordId(interaction.user.id);
    const callerProfile = callerIdentity?.profile;
    const callerUserRoles = callerIdentity?.userRoles || callerIdentity?.user_roles || [];

    const campusLeadRoleName = (config.roles.campusLead || 'Campus Lead').toLowerCase().trim();
    const execMemberRoleName = (config.roles.executiveMember || 'Executive Member').toLowerCase().trim();

    const isCampusLeadOrExecRole = interaction.member.roles.cache.some((r) => {
      const n = r.name.toLowerCase().trim();
      return (
        n === campusLeadRoleName ||
        n === execMemberRoleName ||
        ['executive member', 'executive team', 'executive'].includes(n)
      );
    });

    const isCampusLeadOrExecOs = callerUserRoles.some((r) => {
      const k = (r.role_key || r.role || r.roles?.key || r.roles?.name || '').toLowerCase().trim();
      return ['campus_lead', 'executive_member', 'exec_member', 'executive'].includes(k);
    });

    const clusterHostRoleName = `${cluster.name} Host`.toLowerCase().trim();
    const isClusterHostRole = interaction.member.roles.cache.some(
      (r) => r.name.toLowerCase().trim() === clusterHostRoleName
    );

    const isClusterLeader = callerProfile && cluster.leader_id === callerProfile.id;

    if (!isCampusLeadOrExecRole && !isCampusLeadOrExecOs && !isClusterHostRole && !isClusterLeader) {
      return interaction.editReply({
        content: `⚠️ You must be the Host of **${cluster.name}**, the Campus Lead, or an Executive Member to mark tasks complete in this cluster.`,
      });
    }

    // 3. Look up the message author's linked os_user_id (must be linked)
    const targetAuthor = message.author;
    if (targetAuthor.bot) {
      return interaction.editReply({
        content: '⚠️ Bot messages cannot be submitted for task completions.',
      });
    }

    const authorIdentity = await api.getIdentityByDiscordId(targetAuthor.id);
    if (!authorIdentity || !authorIdentity.profile || !authorIdentity.os_user_id) {
      return interaction.editReply({
        content: `⚠️ <@${targetAuthor.id}> isn't verified on ElevatesOS and cannot be tracked for task completion.`,
      });
    }

    const authorOsUserId = authorIdentity.os_user_id;

    // 4. Check existing submission for toggle/undo behavior
    const { data: existingSub } = await supabase
      .from('task_submissions')
      .select('*')
      .eq('task_id', task.id)
      .eq('os_user_id', authorOsUserId)
      .maybeSingle();

    if (existingSub && existingSub.status === 'completed') {
      // Toggle back to 'pending'
      await supabase
        .from('task_submissions')
        .update({
          status: 'pending',
          completed_at: null,
          marked_by: callerProfile?.id || null,
        })
        .eq('id', existingSub.id);

      // Remove the ✅ reaction
      try {
        const checkReaction = message.reactions.cache.get('✅');
        if (checkReaction) {
          await checkReaction.users.remove(interaction.client.user.id).catch(() => {});
        }
      } catch (_) {}

      return interaction.editReply({
        content: `↩️ Task completion undone for <@${targetAuthor.id}> (status reset to pending).`,
      });
    }

    // 5. Upsert task_submissions row: status 'completed', marked_by = moderator's os_user_id, completed_at = now()
    const { error: upsertErr } = await supabase
      .from('task_submissions')
      .upsert(
        {
          task_id: task.id,
          os_user_id: authorOsUserId,
          discord_message_id: message.id,
          status: 'completed',
          marked_by: callerProfile?.id || null,
          completed_at: new Date().toISOString(),
        },
        { onConflict: 'task_id,os_user_id' }
      );

    if (upsertErr) {
      console.warn('[mark-task-complete] Failed to upsert task_submissions (schema cache may need refresh):', upsertErr.message);
    }

    // React to the message with ✅
    await message.react('✅').catch((err) => {
      console.warn('[mark-task-complete] Could not react to message:', err.message);
    });

    const guildConfig = await api.getGuildConfig(interaction.guildId).catch(() => null);
    api.logChapterEvent(interaction.client, guildConfig?.chapterId, interaction.guildId, 'cluster_task_completed', {
      clusterName: cluster.name,
      taskTitle: task.title,
      targetUserId: targetAuthor.id,
      targetUserTag: targetAuthor.tag,
      markedBy: interaction.user.tag,
    }, 'cluster_activity').catch(() => {});

    return interaction.editReply({
      content: `✅ Successfully marked task completion for <@${targetAuthor.id}>!`,
    });
  },
};
