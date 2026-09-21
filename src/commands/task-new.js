const { SlashCommandBuilder, ChannelType } = require('discord.js');
const supabase = require('../lib/supabase');
const api = require('../lib/api');
const config = require('../config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('task-new')
    .setDescription('Create a new weekly task in your cluster #challenges forum.')
    .addStringOption((opt) =>
      opt
        .setName('title')
        .setDescription('Title of the weekly task')
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('description')
        .setDescription('Task instructions and requirements')
        .setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('due_date')
        .setDescription('Optional deadline (e.g. 2026-09-25 or Friday 5pm)')
        .setRequired(false)
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const title = interaction.options.getString('title').trim();
    const description = interaction.options.getString('description').trim();
    const dueDateInput = interaction.options.getString('due_date')?.trim() || null;

    // 1. Verify guild is a chapter guild
    const guildConfig = await api.getGuildConfig(interaction.guildId).catch(() => null);
    if (!guildConfig || guildConfig.guildType !== 'chapter' || !guildConfig.chapterId) {
      return interaction.editReply({
        content: '⚠️ `/task-new` can only be used in an active chapter Discord server.',
      });
    }

    const chapterId = guildConfig.chapterId;
    const channel = interaction.channel;

    // 2. Identify the target cluster:
    // First, determine if the command is executed in or under a cluster's category/forum
    let cluster = null;

    // Find category ID
    let categoryId = null;
    if (channel.type === ChannelType.GuildCategory) {
      categoryId = channel.id;
    } else if (channel.parentId) {
      categoryId = channel.parentId;
    } else if (channel.isThread() && channel.parent?.parentId) {
      categoryId = channel.parent.parentId;
    }

    if (categoryId) {
      // Check cluster_discord_mappings table for this category
      const { data: mapping } = await supabase
        .from('cluster_discord_mappings')
        .select('cluster_id')
        .eq('guild_id', interaction.guildId)
        .eq('category_id', categoryId)
        .maybeSingle();

      if (mapping?.cluster_id) {
        const { data: c } = await supabase
          .from('clusters')
          .select('*')
          .eq('id', mapping.cluster_id)
          .maybeSingle();
        if (c) cluster = c;
      }

      // Fallback: match category name against chapter clusters
      if (!cluster) {
        const categoryChannel = interaction.guild.channels.cache.get(categoryId);
        if (categoryChannel) {
          const { data: chapterClusters } = await supabase
            .from('clusters')
            .select('*')
            .eq('chapter_id', chapterId);

          if (chapterClusters) {
            cluster = chapterClusters.find((c) => {
              const cleanCluster = c.name.toLowerCase().replace(/[^a-z0-9]/g, '');
              const cleanCat = categoryChannel.name.toLowerCase().replace(/[^a-z0-9]/g, '');
              return cleanCat.includes(cleanCluster) || cleanCluster.includes(cleanCat);
            });
          }
        }
      }
    }

    // If still not identified (e.g. run in general chat), check if user hosts a cluster
    const callerIdentity = await api.getIdentityByDiscordId(interaction.user.id);
    const callerProfile = callerIdentity?.profile;

    if (!cluster) {
      // Find clusters where this user is the leader
      const { data: hostedClusters } = await supabase
        .from('clusters')
        .select('*')
        .eq('chapter_id', chapterId)
        .eq('leader_id', callerProfile?.id || '00000000-0000-0000-0000-000000000000');

      if (hostedClusters && hostedClusters.length === 1) {
        cluster = hostedClusters[0];
      } else {
        return interaction.editReply({
          content: '⚠️ Please run `/task-new` inside the cluster category or `#challenges` forum channel for which you want to create a task.',
        });
      }
    }

    // 3. Permission check: Restricted to that cluster's Host role or the chapter's Campus Lead
    const campusLeadRoleName = config.roles.campusLead || 'Campus Lead';
    const isCampusLeadRole = interaction.member.roles.cache.some(
      (r) => r.name.toLowerCase().trim() === campusLeadRoleName.toLowerCase().trim()
    );

    const clusterHostRoleName = `${cluster.name} Host`.toLowerCase().trim();
    const isClusterHostRole = interaction.member.roles.cache.some(
      (r) => r.name.toLowerCase().trim() === clusterHostRoleName
    );

    const isClusterLeader = callerProfile && cluster.leader_id === callerProfile.id;

    if (!isCampusLeadRole && !isClusterHostRole && !isClusterLeader) {
      return interaction.editReply({
        content: `⚠️ You must be the Host of **${cluster.name}** or the chapter's Campus Lead to create weekly tasks for this cluster.`,
      });
    }

    // 4. Locate the cluster's #challenges forum channel
    let challengesChannel = null;

    // Check cluster_discord_mappings first
    const { data: mapping } = await supabase
      .from('cluster_discord_mappings')
      .select('challenges_channel_id, category_id')
      .eq('cluster_id', cluster.id)
      .eq('guild_id', interaction.guildId)
      .maybeSingle();

    if (mapping?.challenges_channel_id) {
      challengesChannel = interaction.guild.channels.cache.get(mapping.challenges_channel_id) ||
        (await interaction.guild.channels.fetch(mapping.challenges_channel_id).catch(() => null));
    }

    // If not found from mapping, search by name in the cluster's category
    if (!challengesChannel && mapping?.category_id) {
      challengesChannel = interaction.guild.channels.cache.find(
        (c) => c.parentId === mapping.category_id && c.name.toLowerCase() === 'challenges'
      );
    }

    // Fallback: search anywhere in the guild for a challenges channel inside a category matching cluster name
    if (!challengesChannel) {
      const cleanCluster = cluster.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      challengesChannel = interaction.guild.channels.cache.find((c) => {
        if (c.name.toLowerCase() !== 'challenges') return false;
        const parent = c.parent;
        if (!parent) return false;
        const cleanParent = parent.name.toLowerCase().replace(/[^a-z0-9]/g, '');
        return cleanParent.includes(cleanCluster);
      });
    }

    if (!challengesChannel) {
      return interaction.editReply({
        content: `⚠️ Could not find the \`#challenges\` forum channel for **${cluster.name}**. Make sure cluster sync has run.`,
      });
    }

    // 5. Build post content and create forum post/thread
    let postBody = `## 🎯 ${title}\n\n${description}`;
    let parsedDueDate = null;

    if (dueDateInput) {
      const parsedDate = new Date(dueDateInput);
      if (!isNaN(parsedDate.getTime())) {
        parsedDueDate = parsedDate.toISOString();
        const unixTimestamp = Math.floor(parsedDate.getTime() / 1000);
        postBody += `\n\n📅 **Due Date:** <t:${unixTimestamp}:F> (<t:${unixTimestamp}:R>)`;
      } else {
        postBody += `\n\n📅 **Due Date:** ${dueDateInput}`;
      }
    }

    postBody += `\n\n---\n*Reply to this thread with your work to submit. Cluster Hosts can right-click your message → Apps → **Mark Task Complete**.*`;

    let thread = null;
    try {
      if (challengesChannel.threads && typeof challengesChannel.threads.create === 'function') {
        thread = await challengesChannel.threads.create({
          name: title.slice(0, 100),
          message: {
            content: postBody,
          },
          reason: `Cluster task for ${cluster.name} created by ${interaction.user.tag}`,
        });
      }
    } catch (createThreadErr) {
      console.error('[task-new] Failed to create thread in challenges channel:', createThreadErr);
      return interaction.editReply({
        content: `❌ Failed to create task thread in ${challengesChannel}: ${createThreadErr.message}`,
      });
    }

    if (!thread) {
      return interaction.editReply({
        content: '❌ Failed to create forum thread.',
      });
    }

    // Pin if possible
    try {
      if (typeof thread.setPinned === 'function') {
        await thread.setPinned(true);
      }
    } catch (_) {
      try {
        const starter = await thread.fetchStarterMessage().catch(() => null);
        if (starter && typeof starter.pin === 'function') {
          await starter.pin().catch(() => {});
        }
      } catch (_) {}
    }

    // 6. Insert row into cluster_tasks table
    const { data: taskRow, error: taskErr } = await supabase
      .from('cluster_tasks')
      .insert({
        cluster_id: cluster.id,
        title,
        description,
        due_date: parsedDueDate,
        status: 'active',
        forum_thread_id: thread.id,
        created_by: callerProfile?.id || null,
      })
      .select()
      .maybeSingle();

    if (taskErr) {
      console.warn('[task-new] Failed to insert cluster_tasks row (schema cache may need refresh):', taskErr.message);
    }

    api.logChapterEvent(interaction.client, chapterId, interaction.guildId, 'cluster_task_created', {
      clusterName: cluster.name,
      title,
      threadId: thread.id,
      createdBy: interaction.user.tag,
    }, 'cluster_activity').catch(() => {});

    return interaction.editReply({
      content: `✅ New weekly task **${title}** created successfully for **${cluster.name}**!\nThread: ${thread}`,
    });
  },
};
