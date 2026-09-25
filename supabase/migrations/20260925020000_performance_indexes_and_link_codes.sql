-- ============================================================================
-- Migration: 20260925020000_performance_indexes_and_link_codes.sql
-- Description:
--   Supports OS-generated code-paste account verification and comprehensive
--   performance indexes across high-traffic lookup columns.
-- ============================================================================

-- Ensure pgcrypto extension is present
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Table for OS-generated verification codes
CREATE TABLE IF NOT EXISTS public.discord_link_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'used', 'expired')),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    used_at TIMESTAMPTZ
);

-- Fast lookup indexes for verification codes
CREATE INDEX IF NOT EXISTS idx_discord_link_codes_lookup 
    ON public.discord_link_codes(code, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_discord_link_codes_user 
    ON public.discord_link_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_discord_link_codes_status 
    ON public.discord_link_codes(status);

-- Enable Row Level Security (RLS)
ALTER TABLE public.discord_link_codes ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
DROP POLICY IF EXISTS "Service role manage link codes" ON public.discord_link_codes;
CREATE POLICY "Service role manage link codes" ON public.discord_link_codes
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 2. Performance Indexes on frequent lookup columns
-- discord_links: discord_user_id and os_user_id
CREATE INDEX IF NOT EXISTS idx_discord_links_discord_user_id
    ON public.discord_links(discord_user_id);
CREATE INDEX IF NOT EXISTS idx_discord_links_os_user_id
    ON public.discord_links(os_user_id);

-- guild_config: lookup by guild_id, chapter_id, and guild_type
CREATE INDEX IF NOT EXISTS idx_guild_config_guild_id
    ON public.guild_config(guild_id);
CREATE INDEX IF NOT EXISTS idx_guild_config_chapter_lookup
    ON public.guild_config(chapter_id, guild_type);

-- cluster_members: lookup by user_id and cluster_id
CREATE INDEX IF NOT EXISTS idx_cluster_members_user_id
    ON public.cluster_members(user_id);
CREATE INDEX IF NOT EXISTS idx_cluster_members_cluster_id
    ON public.cluster_members(cluster_id);
CREATE INDEX IF NOT EXISTS idx_cluster_members_composite
    ON public.cluster_members(cluster_id, user_id);

-- dm_threads: lookup by discord_user_id
CREATE INDEX IF NOT EXISTS idx_dm_threads_discord_user
    ON public.dm_threads(discord_user_id);

-- profiles: lookup by discord_user_id and chapter_id
CREATE INDEX IF NOT EXISTS idx_profiles_discord_user_active
    ON public.profiles(discord_user_id)
    WHERE discord_connected = true;
CREATE INDEX IF NOT EXISTS idx_profiles_chapter_active
    ON public.profiles(chapter_id);

-- Add discord_link_codes to Supabase Realtime publication
DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.discord_link_codes;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
