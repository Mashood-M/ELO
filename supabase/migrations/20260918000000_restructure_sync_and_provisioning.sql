-- ============================================================================
-- Migration: 20260918000000_restructure_sync_and_provisioning.sql
-- Description:
--   Supports identity-based account linking, chapter provisioning setup tokens,
--   cluster category/role tracking, and full Supabase Realtime synchronization.
-- ============================================================================

-- Ensure pgcrypto extension is present
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Table for Chapter Provisioning Setup Tokens
CREATE TABLE IF NOT EXISTS public.chapter_setup_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chapter_id UUID NOT NULL REFERENCES public.chapters(id) ON DELETE CASCADE,
    campus_lead_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    campus_lead_discord_id TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chapter_setup_token_lookup
    ON public.chapter_setup_tokens(token, used_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_chapter_setup_lead
    ON public.chapter_setup_tokens(campus_lead_discord_id);

-- 2. Table for Cluster Discord Category and Role Mappings
CREATE TABLE IF NOT EXISTS public.cluster_discord_mappings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cluster_id UUID NOT NULL REFERENCES public.clusters(id) ON DELETE CASCADE,
    guild_id TEXT NOT NULL REFERENCES public.guild_config(guild_id) ON DELETE CASCADE,
    category_id TEXT NOT NULL,
    member_role_id TEXT NOT NULL,
    host_role_id TEXT,
    discussion_channel_id TEXT,
    resources_channel_id TEXT,
    challenges_channel_id TEXT,
    projects_channel_id TEXT,
    voice_channel_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cluster_guild_unique UNIQUE (cluster_id, guild_id)
);

CREATE INDEX IF NOT EXISTS idx_cluster_discord_lookup
    ON public.cluster_discord_mappings(cluster_id, guild_id);

-- 3. Table for Chapter Management Log Channels in Main Guild
CREATE TABLE IF NOT EXISTS public.chapter_log_channels (
    chapter_id UUID PRIMARY KEY REFERENCES public.chapters(id) ON DELETE CASCADE,
    main_guild_id TEXT NOT NULL REFERENCES public.guild_config(guild_id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. Enable Row Level Security
ALTER TABLE public.chapter_setup_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cluster_discord_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chapter_log_channels ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
DROP POLICY IF EXISTS "Service role manage setup tokens" ON public.chapter_setup_tokens;
CREATE POLICY "Service role manage setup tokens" ON public.chapter_setup_tokens FOR ALL USING (true);

DROP POLICY IF EXISTS "Service role manage cluster mappings" ON public.cluster_discord_mappings;
CREATE POLICY "Service role manage cluster mappings" ON public.cluster_discord_mappings FOR ALL USING (true);

DROP POLICY IF EXISTS "Service role manage chapter log channels" ON public.chapter_log_channels;
CREATE POLICY "Service role manage chapter log channels" ON public.chapter_log_channels FOR ALL USING (true);

-- 5. Add tables to Supabase Realtime publication
DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.profiles;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.user_roles;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.roles;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.clusters;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.cluster_members;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
