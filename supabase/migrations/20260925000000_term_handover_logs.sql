-- ============================================================================
-- Migration: 20260925000000_term_handover_logs.sql
-- Description:
--   Add term_handover_thread_id column to chapter_log_channels for tracking
--   per-chapter term handovers (old CL/executive team demoted, new CL/exec team assigned).
-- ============================================================================

ALTER TABLE public.chapter_log_channels
ADD COLUMN IF NOT EXISTS term_handover_thread_id TEXT;
