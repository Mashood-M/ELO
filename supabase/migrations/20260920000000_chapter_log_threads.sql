-- ============================================================================
-- Migration: 20260920000000_chapter_log_threads.sql
-- Description:
--   Add starter thread tracking columns to chapter_log_channels for all
--   function-specific topics (roles, current roles, events, moderation, etc.).
-- ============================================================================

ALTER TABLE public.chapter_log_channels
ADD COLUMN IF NOT EXISTS role_changes_thread_id TEXT,
ADD COLUMN IF NOT EXISTS current_roles_thread_id TEXT,
ADD COLUMN IF NOT EXISTS events_thread_id TEXT,
ADD COLUMN IF NOT EXISTS moderation_thread_id TEXT,
ADD COLUMN IF NOT EXISTS cluster_activity_thread_id TEXT,
ADD COLUMN IF NOT EXISTS channel_role_changes_thread_id TEXT,
ADD COLUMN IF NOT EXISTS membership_thread_id TEXT;
