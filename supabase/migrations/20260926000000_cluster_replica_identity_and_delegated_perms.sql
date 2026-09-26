-- ============================================================================
-- Migration: 20260926000000_cluster_replica_identity_and_delegated_perms.sql
-- Description:
--   1. Ensures access_mode and member_ids columns exist on public.clusters with GIN indexing.
--   2. Sets REPLICA IDENTITY FULL on public.clusters so Supabase Realtime UPDATE events
--      contain complete OLD and NEW row states (enabling member_ids array diffing).
--   3. Sets REPLICA IDENTITY FULL and registers public.terms and public.term_members
--      in Supabase Realtime publication for live delegated permissions invalidation.
-- ============================================================================

-- 1. Ensure columns exist on clusters
ALTER TABLE public.clusters
ADD COLUMN IF NOT EXISTS access_mode TEXT NOT NULL DEFAULT 'invite',
ADD COLUMN IF NOT EXISTS member_ids UUID[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_clusters_access_mode ON public.clusters(access_mode);
CREATE INDEX IF NOT EXISTS idx_clusters_member_ids ON public.clusters USING GIN(member_ids);

-- 2. Set REPLICA IDENTITY FULL on clusters so old record is delivered in UPDATE events
ALTER TABLE public.clusters REPLICA IDENTITY FULL;

-- 3. Set REPLICA IDENTITY FULL on terms and term_members if present
DO $$
BEGIN
    ALTER TABLE public.terms REPLICA IDENTITY FULL;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE public.term_members REPLICA IDENTITY FULL;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- 4. Add terms and term_members to Supabase Realtime publication
DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.terms;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.term_members;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
