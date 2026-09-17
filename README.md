# ElevatesOS Discord Bot

Bridges ElevatesOS chapters with Discord: verified per-chapter membership,
live cluster counts, event-based community clusters on the main server,
and moderation tools for Campus Leads / Class Reps.

## Setup

1. **Create the bot** in the [Discord Developer Portal](https://discord.com/developers/applications):
   - New Application → Bot → copy the **Token** and **Client ID**.
   - Under Bot → Privileged Gateway Intents, enable **Server Members Intent** and **Message Content Intent**.
   - Under OAuth2 → URL Generator: scopes `bot` + `applications.commands`; permissions: Kick Members, Ban Members, Moderate Members, Manage Roles, Manage Nicknames, Manage Threads, Send Messages, Read Message History.
   - *Note on Interactions:* The arcade verification flow utilizes Button and Modal interactions. These work over `GatewayIntentBits.Guilds` (already enabled) and do not require any additional intents.

2. **Install & configure:**
   ```bash
   npm install
   cp .env.example .env
   # fill in DISCORD_TOKEN, DISCORD_CLIENT_ID, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
   ```

   **Environment Variables:**
   - `DISCORD_TOKEN`: Bot token
   - `DISCORD_CLIENT_ID`: Application client ID
   - `SUPABASE_URL`: Supabase project URL
   - `SUPABASE_SERVICE_ROLE_KEY`: Supabase service role secret
   - `ROLE_FOUNDER`: Name of Founder role (default: `ELEVATES • Founder`)
   - `ROLE_ADMIN`: Name of Admin role (default: `ELEVATES • Admin`)
   - `ROLE_CAMPUS_LEAD`: Name of Campus Lead role (default: `Campus Lead`)
   - `ROLE_CLASS_REP`: Name of Class Rep role (default: `Class Rep`)
   - `ROLE_VERIFIED`: Name of Verified member role (default: `ELEVATES • Member`)
   - `ROLE_UNVERIFIED`: Name of Unverified member role (default: `elevates`)
   - `ROLE_GUEST`: Name of Guest role (default: `Guest`)
   - `MAX_VERIFY_ATTEMPTS`: Max failed attempts before notifying Campus Lead (default: `3`)

3. **Database Migration:**
   Apply the SQL migration in `supabase/migrations/20260916000000_discord_bot_tables.sql`
   to your Supabase project (via Supabase CLI or SQL Editor in Dashboard).

4. **Register slash commands:**
   ```bash
   npm run deploy-commands
   ```

5. **Run the bot:**
   ```bash
   npm start
   ```

6. **Deploy for real use:** run this as a long-lived process on Railway or
   Fly.io (not Vercel — Discord bots need a persistent connection, which
   serverless functions don't provide).

## Verification & Onboarding Flow

When a user joins a chapter server:
1. They are immediately assigned the **Unverified** role (`elevates`).
2. The bot sends an arcade-themed (orange & white) welcome embed in DM (with fallback to `#verify-here`) with two interactive buttons:
   - **`✅ Yes, I have an account`**: Opens a Discord Modal prompting for their **ElevatesOS User ID**.
     - On valid submission: Swaps Unverified → **Verified Member**, syncs their chapter designation (Campus Lead or Class Rep), updates their server nickname, and sends an arcade-themed confirmation embed.
     - On invalid submission: Returns an ephemeral error message with remaining attempts and a retry button. After maximum attempts are exceeded, flags the failure to `#mod-log` and alerts their Campus Lead.
   - **`🆕 No, I'm new here`**: Removes Unverified and assigns the **Guest** role. Guests can view general community channels (`#general-chat`, `#introductions`, `#rules`, `#announcements`) but cannot view chapter-specific tasks, clusters, or events.
3. Original prompt buttons are disabled after clicking to prevent duplicate submissions.

## Supabase Database Integration

The bot talks directly to Supabase using the service role key (bypassing RLS).
See `src/lib/api.js` for implementation details.

### Tables

- `guild_config`: `guild_id` (text, PK), `guild_type` ('main' | 'chapter'), `chapter_id` (uuid, nullable, FK -> chapters.id), `created_at`
- `discord_links`: `id` (uuid, PK), `discord_user_id` (text), `discord_username` (text), `os_user_id` (uuid, FK -> users.id), `guild_id` (text, FK -> guild_config.guild_id), `status` ('pending' | 'linked' | 'unlinked'), `linked_at` (timestamp), `unlinked_at` (timestamp, nullable)
- `discord_events_log`: `id` (uuid, PK), `guild_id` (text), `discord_user_id` (text), `event_type` (text), `detail` (jsonb), `created_at` (timestamp)
- `discord_warnings`: `id` (uuid, PK), `discord_user_id` (text), `guild_id` (text), `reason` (text), `issued_by` (text), `created_at` (timestamp)

## Onboarding a new chapter server

1. Create the server from the shared Discord **Server Template**.
2. Ensure channel permissions for the **Guest** role:
   - Deny `View Channel` on `CLUSTERS & TASKS` and `EVENTS` categories.
   - Allow `View Channel` on `GENERAL` and `WELCOME` categories.
3. Invite this bot with the OAuth2 link from setup step 1.
4. Run `/setup-chapter chapter_id:<the chapter's ElevatesOS ID>`.
5. Done — joins now trigger verification automatically.

## Commands

| Command | Server | Access |
|---|---|---|
| `/setup-chapter` | Chapter | Admin, Founder (one-time) |
| `/cluster` | Chapter | Anyone |
| `/kick` | Chapter | Founder, Campus Lead, Class Rep |
| `/ban` / `/unban` | Chapter | Founder, Campus Lead |
| `/mute` | Chapter | Founder, Campus Lead, Class Rep |
| `/warn` / `/warnings` | Chapter | Founder, Campus Lead, Class Rep |
| `/unlink` | Chapter | Founder, Campus Lead |
| `/announce` | Any | Founder, Campus Lead, Admin |
| `/reply-as-bot` | Any | Founder, Campus Lead, Admin |

## Extended Features & Modular Flags

The bot includes four modular features that can be independently toggled on or off via environment variables (in `.env` / `src/config.js`):

### 1. Welcome Card (Image Generation)
- **Flag**: `FEATURE_WELCOME_CARD` (default: `true`)
- **Behavior**: When a member completes verification, the bot dynamically renders an arcade-style 800x300 PNG welcome card using `canvas`. It features the user's avatar, display name, and verified member badge, posting it directly to `#general-chat` alongside a congratulatory message.

### 2. DM-to-Staff Forwarding
- **Flag**: `FEATURE_DM_FORWARDING` (default: `true`)
- **Channel Config**: `STAFF_DM_FORWARD_CHANNEL` (default: `bot-commands`)
- **Behavior**: If a member sends a direct message to the bot outside of an active verification flow, the bot lets the user know their message has been forwarded and builds a rich embed (with avatar, tag, user ID, content, and attachments) delivered to the designated staff channel in the primary (`main`) server.

### 3. Nudge Unverified Members
- **Flag**: `FEATURE_UNVERIFIED_NUDGE` (default: `true`)
- **Behavior**: When a member with the `Unverified` role attempts to chat in a chapter server, the bot replies with a polite nudge reminding them to verify via their DMs or by contacting a Campus Lead. A built-in in-memory rate-limiter prevents nudging the same member more than once every 10 minutes.

### 4. Admin Broadcast Commands
- **Flag**: `FEATURE_ADMIN_BROADCAST` (default: `true`)
- **Commands**:
  - `/announce channel:<#channel> message:<text>`: Broadcasts a plain bot message to any target channel in the server. Restricted to Campus Leads and Admins.
  - `/reply-as-bot message_id:<ID> text:<text>`: Replies to any target message in the current channel as the bot. Restricted to Campus Leads and Admins.

---

Full design rationale, schema, and rollout plan: see the attached PRD.


# ELO
