-- Migration: Discord bot tables for ElevatesOS integration
-- Enables account linking, guild configuration, moderation warnings, and event audit logging.

-- Ensure UUID generator is available
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Base tables: chapters and users (create if they do not exist yet)
CREATE TABLE IF NOT EXISTS chapters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    chapter_id UUID REFERENCES chapters(id) ON DELETE SET NULL,
    role TEXT,
    designation TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 1. guild_config: maps Discord guild to guild type and ElevatesOS chapter
CREATE TABLE IF NOT EXISTS guild_config (
    guild_id TEXT PRIMARY KEY,
    guild_type TEXT NOT NULL CHECK (guild_type IN ('main', 'chapter')),
    chapter_id UUID REFERENCES chapters(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. discord_links: maps Discord members to ElevatesOS users
CREATE TABLE IF NOT EXISTS discord_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    discord_user_id TEXT NOT NULL,
    discord_username TEXT,
    os_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    guild_id TEXT NOT NULL REFERENCES guild_config(guild_id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('pending', 'linked', 'unlinked')),
    linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    unlinked_at TIMESTAMPTZ,
    CONSTRAINT discord_links_user_guild_unique UNIQUE (discord_user_id, guild_id)
);

-- 3. discord_events_log: audit trail of Discord events
CREATE TABLE IF NOT EXISTS discord_events_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id TEXT NOT NULL,
    discord_user_id TEXT,
    event_type TEXT NOT NULL,
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. discord_warnings: moderation warnings issued to members
CREATE TABLE IF NOT EXISTS discord_warnings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    discord_user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    issued_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Performance & query indexes
CREATE INDEX IF NOT EXISTS idx_discord_links_guild_user ON discord_links(guild_id, discord_user_id);
CREATE INDEX IF NOT EXISTS idx_discord_links_os_user ON discord_links(os_user_id);
CREATE INDEX IF NOT EXISTS idx_discord_links_status ON discord_links(status);
CREATE INDEX IF NOT EXISTS idx_discord_events_guild_user ON discord_events_log(guild_id, discord_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_discord_warnings_guild_user ON discord_warnings(guild_id, discord_user_id, created_at DESC);

-- Enable RLS on all tables (service role key will bypass RLS)
ALTER TABLE guild_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE discord_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE discord_events_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE discord_warnings ENABLE ROW LEVEL SECURITY;
