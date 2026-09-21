-- ============================================================================
-- Migration: 20260919000000_cluster_tasks.sql
-- Description:
--   Supports cluster weekly tasks, member task submissions,
--   one-chapter-per-lead enforcement, and forum-based audit log threads.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Table for Cluster Weekly Tasks
CREATE TABLE IF NOT EXISTS public.cluster_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cluster_id UUID NOT NULL REFERENCES public.clusters(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    due_date TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
    forum_thread_id TEXT NOT NULL,
    created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cluster_tasks_cluster_id
    ON public.cluster_tasks(cluster_id);
CREATE INDEX IF NOT EXISTS idx_cluster_tasks_forum_thread_id
    ON public.cluster_tasks(forum_thread_id);
CREATE INDEX IF NOT EXISTS idx_cluster_tasks_status
    ON public.cluster_tasks(status);

-- 2. Table for Task Submissions
CREATE TABLE IF NOT EXISTS public.task_submissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id UUID NOT NULL REFERENCES public.cluster_tasks(id) ON DELETE CASCADE,
    os_user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    discord_message_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
    marked_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT task_submissions_task_user_unique UNIQUE (task_id, os_user_id)
);

CREATE INDEX IF NOT EXISTS idx_task_submissions_task_id
    ON public.task_submissions(task_id);
CREATE INDEX IF NOT EXISTS idx_task_submissions_os_user_id
    ON public.task_submissions(os_user_id);
CREATE INDEX IF NOT EXISTS idx_task_submissions_status
    ON public.task_submissions(status);

-- 3. Enhance guild_config to track registered campus lead
ALTER TABLE public.guild_config
    ADD COLUMN IF NOT EXISTS campus_lead_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS campus_lead_discord_id TEXT;

CREATE INDEX IF NOT EXISTS idx_guild_config_campus_lead
    ON public.guild_config(campus_lead_id, campus_lead_discord_id);

-- 4. Enhance chapter_log_channels to track forum thread references
ALTER TABLE public.chapter_log_channels
    ADD COLUMN IF NOT EXISTS moderation_thread_id TEXT,
    ADD COLUMN IF NOT EXISTS cluster_activity_thread_id TEXT,
    ADD COLUMN IF NOT EXISTS channel_role_changes_thread_id TEXT,
    ADD COLUMN IF NOT EXISTS membership_thread_id TEXT;

-- 5. Enable Row Level Security & service role policies
ALTER TABLE public.cluster_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_submissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role manage cluster tasks" ON public.cluster_tasks;
CREATE POLICY "Service role manage cluster tasks" ON public.cluster_tasks FOR ALL USING (true);

DROP POLICY IF EXISTS "Service role manage task submissions" ON public.task_submissions;
CREATE POLICY "Service role manage task submissions" ON public.task_submissions FOR ALL USING (true);

-- 6. Add cluster_tasks & task_submissions to Realtime publication
DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.cluster_tasks;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.task_submissions;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
