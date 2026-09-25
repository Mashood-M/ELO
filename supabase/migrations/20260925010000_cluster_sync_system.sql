-- ============================================================================
-- Migration: 20260925010000_cluster_sync_system.sql
-- Description:
--   Complete production-grade cluster synchronization system between Supabase and Discord.
--   - Adds discord_category_id and discord_role_id to clusters.
--   - Creates cluster_members table for cluster membership and roles.
--   - Creates pending_discord_roles table for deferred role assignment before account linking.
--   - Creates discord_sync_log table for full audit logging of Discord sync events.
--   - Enables RLS with service_role bypass and registers tables in Supabase Realtime.
-- ============================================================================

-- Ensure pgcrypto extension is present
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Add columns to clusters (if not already present)
ALTER TABLE public.clusters
ADD COLUMN IF NOT EXISTS discord_category_id TEXT,
ADD COLUMN IF NOT EXISTS discord_role_id TEXT;

-- 2. New table: cluster_members
CREATE TABLE IF NOT EXISTS public.cluster_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cluster_id UUID NOT NULL REFERENCES public.clusters(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    added_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    role_in_cluster TEXT NOT NULL DEFAULT 'member' CHECK (role_in_cluster IN ('member', 'host')),
    CONSTRAINT cluster_members_cluster_user_unique UNIQUE (cluster_id, user_id)
);

-- Safely ensure columns exist if cluster_members was pre-created in partial schema
ALTER TABLE public.cluster_members ADD COLUMN IF NOT EXISTS added_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.cluster_members ADD COLUMN IF NOT EXISTS added_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE public.cluster_members ADD COLUMN IF NOT EXISTS role_in_cluster TEXT NOT NULL DEFAULT 'member';

CREATE INDEX IF NOT EXISTS idx_cluster_members_cluster_user ON public.cluster_members(cluster_id, user_id);
CREATE INDEX IF NOT EXISTS idx_cluster_members_user ON public.cluster_members(user_id);
CREATE INDEX IF NOT EXISTS idx_cluster_members_cluster ON public.cluster_members(cluster_id);

-- 3. New table: pending_discord_roles
CREATE TABLE IF NOT EXISTS public.pending_discord_roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    role_type TEXT NOT NULL CHECK (role_type IN ('cluster_member', 'cluster_host', 'chapter_role')),
    target_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT pending_discord_roles_user_role_target_unique UNIQUE (user_id, role_type, target_id)
);

CREATE INDEX IF NOT EXISTS idx_pending_discord_roles_user ON public.pending_discord_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_pending_discord_roles_target ON public.pending_discord_roles(target_id);
CREATE INDEX IF NOT EXISTS idx_pending_discord_roles_role_type ON public.pending_discord_roles(role_type);

-- 4. New table: discord_sync_log
CREATE TABLE IF NOT EXISTS public.discord_sync_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type TEXT NOT NULL,
    user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    cluster_id UUID REFERENCES public.clusters(id) ON DELETE SET NULL,
    discord_role_id TEXT,
    action TEXT NOT NULL CHECK (action IN ('granted', 'revoked', 'created', 'archived')),
    success BOOLEAN NOT NULL,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_discord_sync_log_cluster ON public.discord_sync_log(cluster_id);
CREATE INDEX IF NOT EXISTS idx_discord_sync_log_user ON public.discord_sync_log(user_id);
CREATE INDEX IF NOT EXISTS idx_discord_sync_log_created_at ON public.discord_sync_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_discord_sync_log_event_action ON public.discord_sync_log(event_type, action);

-- 5. Enable Row Level Security (RLS)
ALTER TABLE public.cluster_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pending_discord_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.discord_sync_log ENABLE ROW LEVEL SECURITY;

-- 6. RLS Policies: Service role full access
DROP POLICY IF EXISTS "Service role manage cluster members" ON public.cluster_members;
CREATE POLICY "Service role manage cluster members" ON public.cluster_members
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role manage pending discord roles" ON public.pending_discord_roles;
CREATE POLICY "Service role manage pending discord roles" ON public.pending_discord_roles
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role manage discord sync log" ON public.discord_sync_log;
CREATE POLICY "Service role manage discord sync log" ON public.discord_sync_log
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 7. Add tables to Supabase Realtime publication
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

DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.discord_links;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.pending_discord_roles;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
