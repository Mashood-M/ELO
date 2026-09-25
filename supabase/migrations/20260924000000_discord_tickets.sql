-- ============================================================================
-- Migration: 20260924000000_discord_tickets.sql
-- Description:
--   Supports lane-based Discord ticketing system (Founder, Admin, Executive Team,
--   Campus Lead) with forum thread routing, chapter assignment, and status tracking.
-- ============================================================================

-- Ensure pgcrypto extension is present for UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Table for tracking lane-based support tickets
CREATE TABLE IF NOT EXISTS public.discord_tickets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    discord_user_id TEXT NOT NULL,
    lane TEXT NOT NULL CHECK (lane IN ('founder', 'admin', 'exec', 'campus_lead')),
    chapter_id UUID REFERENCES public.chapters(id) ON DELETE SET NULL,
    forum_channel_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at TIMESTAMPTZ,
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fast lookup indexes
CREATE INDEX IF NOT EXISTS idx_discord_tickets_discord_user_id
    ON public.discord_tickets(discord_user_id);

CREATE INDEX IF NOT EXISTS idx_discord_tickets_thread_id
    ON public.discord_tickets(thread_id);

CREATE INDEX IF NOT EXISTS idx_discord_tickets_status
    ON public.discord_tickets(status);

CREATE INDEX IF NOT EXISTS idx_discord_tickets_chapter_id
    ON public.discord_tickets(chapter_id);

CREATE INDEX IF NOT EXISTS idx_discord_tickets_status_last_message
    ON public.discord_tickets(status, last_message_at DESC);

-- Ensure only one open ticket per user per lane at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_discord_tickets_user_lane_open
    ON public.discord_tickets (discord_user_id, lane)
    WHERE (status = 'open');

-- Enable Row Level Security (RLS)
ALTER TABLE public.discord_tickets ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
DROP POLICY IF EXISTS "discord_tickets_service_role_policy" ON public.discord_tickets;
CREATE POLICY "discord_tickets_service_role_policy" ON public.discord_tickets
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);
