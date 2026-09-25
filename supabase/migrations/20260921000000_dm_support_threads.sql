-- ============================================================================
-- Migration: 20260921000000_dm_support_threads.sql
-- Description:
--   Supports two-way DM support / modmail system between users and staff
--   (Founders and HQ Admins) via private forum threads in the Main Server.
-- ============================================================================

-- Ensure pgcrypto extension is present for UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Table for tracking permanent user DM support mailbox threads
CREATE TABLE IF NOT EXISTS public.dm_threads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    discord_user_id TEXT UNIQUE NOT NULL,
    os_user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    forum_thread_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast lookup indexes
CREATE INDEX IF NOT EXISTS idx_dm_threads_discord_user_id
    ON public.dm_threads(discord_user_id);

CREATE INDEX IF NOT EXISTS idx_dm_threads_forum_thread_id
    ON public.dm_threads(forum_thread_id);

CREATE INDEX IF NOT EXISTS idx_dm_threads_status_last_message
    ON public.dm_threads(status, last_message_at DESC);

-- Enable Row Level Security (RLS)
ALTER TABLE public.dm_threads ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
CREATE POLICY dm_threads_service_role_policy ON public.dm_threads
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
