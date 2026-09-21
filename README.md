# ElevatesOS Discord Bot

Direct bridge between **ElevatesOS** and **Discord**: identity-based account linking (zero DMs), resilient role and chapter synchronization, self-serve chapter server provisioning, private cluster workspaces, weekly cluster task management, and role-based permissions split across main and chapter servers.

The bot communicates directly with Supabase via the service-role key (no intermediate API layer) and responds to database events using Supabase Realtime alongside a robust polling reconciliation engine.

---

## Key Architecture & Capabilities

### 1. Identity-Based Account Linking (No DMs, Ever)
- **Zero Direct Messages**: All account linking is initiated in public server channels (`#link-server` or `#welcome`) across every guild the bot serves (main and chapter servers alike).
- **Public Embed & Button**: Features an arcade-themed embed explaining account benefits with a `🔗 Connect Account` button (`customId: "link_account_start"`).
- **Private Modal Interaction**: Clicking the button opens a private Discord modal requesting the user's **Elevates OS User ID** (`elevates_id`, raw numeric digits, UUID, or registered email).
- **4-Hour OTP Verification**: Generates a 6-digit OTP stored in `discord_verification_codes` with a 4-hour expiration tied to their `discord_user_id`. The user inputs this code directly on their ElevatesOS profile page via `verify_discord_otp`.
- **Universal Identity Recognition**: Once verified, the Discord identity is recognized immediately across all guilds—no re-verification is ever required in any chapter server.
- **Strict Chapter Enforcement**: A user's active chapter is derived directly from `profiles.chapter_id`. Chapter-specific permissions and cluster access follow this single source of truth.

### 2. Role Synchronization Engine
- **Supabase as the Source of Truth**: Detects additions, modifications, and removals in `user_roles`, `roles`, and `profiles`.
- **Automatic State Recomputation**:
  - Assigns chapter roles matching the OS roles schema (Campus Lead, Class Representative, Student Member, Faculty Coordinator, etc.). Roles are generated per chapter, not shared globally.
  - Automatically updates the member's server nickname to match their OS `full_name`.
  - Grants the verified member role (`ELEVATES • Member`) and revokes unverified (`elevates`) or guest roles.
- **Handling Chapter Transitions**: If a member's chapter assignment changes in ElevatesOS, the bot automatically strips chapter roles from the previous chapter server and grants access in the new one.
- **Resilient Sync Queue (`SyncQueue`)**:
  - Changes are enqueued and rate-limited to avoid Discord API rate limits (HTTP 429).
  - Automatically handles 429 backoff with dynamic exponential wait times based on Discord's `retry_after` headers.
  - In-flight and pending task deduplication ensures smooth processing during bulk organizational changes (such as term transitions).

### 3. Automatic Chapter Server Provisioning (`/chapter` + OAuth2 Callback)
- **`/chapter` Command (Main Server)**:
  - Usable by verified **Campus Leads** in the Main Server to provision a server for their assigned chapter.
  - Verifies that the caller holds the `campus_lead` role in ElevatesOS and that the chapter has no existing server configured.
  - **One Chapter Server Per Campus Lead Rule**: Before generating a setup token, queries whether the Campus Lead already has an existing `guild_config` entry as the registered Campus Lead for a different chapter. If so, creation is refused: *"You've already set up a chapter server. Each Campus Lead can create one chapter server only."*
  - Generates a 1-hour setup token (`chp_...`) and replies with **exactly two links** (with zero mention of manual commands):
    1. **Template Clone Link**: *"Clone this template to create your server: <DISCORD_CHAPTER_TEMPLATE_URL>"* (single shared server template configured in `DISCORD_CHAPTER_TEMPLATE_URL`).
    2. **Bot Invite Link**: *"Invite the bot to your new server (this will activate it automatically): <combined_invite_url>"* (OAuth2 invite carrying the token in `state`, `redirect_uri=<DISCORD_REDIRECT_URI>`, and `response_type=code`).
- **Automatic Activation on Join via HTTP Callback**:
  - The bot runs an internal HTTP listener on `PORT` (default: `3000`).
  - When the Campus Lead authorizes the bot to join the newly created template server, Discord redirects back to `DISCORD_REDIRECT_URI` with `?guild_id=<GUILD_ID>&state=<TOKEN>`.
  - The HTTP callback server validates the token against `chapter_setup_tokens`, ensures it is unexpired, and immediately marks it as used (`used_at = now`) to prevent replay attacks.
  - Provisions the chapter guild automatically:
    - Creates Discord roles matching every active role in the OS `roles` table.
    - **Immediate Campus Lead Role Assignment**: Automatically assigns the chapter's **Campus Lead** Discord role to the Campus Lead who generated the token, equips the role with the **Administrator** permission within that chapter server only, syncs their verified role and full name nickname.
    - Sets up the `#link-server` portal with the `🔗 Connect Account` button.
    - Establishes the dedicated chapter Forum audit log channel in the Main Server under `Chapter Management`.
    - Triggers initial cluster synchronization (`clusterSync`).
  - Browser displays: *"✅ Chapter server activated! You can close this tab and return to Discord."*
- **Fallback Safety Net (`guildCreate` Event)**:
  - If the bot joins a server where automatic activation was not triggered or completed (e.g. invited via a raw link or network interruption), the bot pauses for 4 seconds to resolve any HTTP race conditions.
  - If no `guild_config` exists for the guild, it posts a message in the server's system/welcome channel:
    *"⚠️ This chapter server has not been activated yet. Your Campus Lead must generate an activation link using `/chapter` in the Elevates Main Server."*

### 4. Forum-Based Audit Logging Structure
- **Founders Oversight in Main Server**: Upon chapter server activation, the bot establishes a dedicated **Forum channel** per chapter (`#chp-<chapter-slug>`) inside the `Chapter Management` category, permissioned exclusively for Founders and HQ Admins.
- **Auto-Created Starter Log Threads**: On forum creation, the bot automatically spins up 4 distinct starter threads and persists their thread IDs in `chapter_log_channels`:
  - `🛡️ Moderation`: Moderation actions including kicks, bans, unbans, mutes, warnings, and unlinks.
  - `🧠 Cluster Activity`: Cluster lifecycle events, member role additions/removals, and host assignments.
  - `⚙️ Channel & Role Changes`: Chapter activation notices, channel/role creations and updates, broadcasts.
  - `👤 Membership`: Member join events (verified and unverified), server leaves, and account linking updates.
- **Centralized Event Router**: `api.logChapterEvent` automatically maps event types and routes embeds into the appropriate category thread.

### 5. Private Chapter Clusters & Corrected Channel Types
- Scoped to chapters via `clusters` and `cluster_members` tables.
- **Deterministic Category Naming**: Formatted as `<emoji>・<CLUSTER NAME IN UPPERCASE>` (e.g. `🛡️・CYBERSECURITY`). Deterministically hashes the cluster's unique ID/name against a fixed emoji array (`🧠`, `📦`, `🔧`, `🎯`, `📡`, `🛡️`, `🚀`, `💡`), guaranteeing consistency across resyncs without modifying the OS schema.
- **Automatic Campus Lead Access**: Whenever a cluster is created or synced, the chapter's **Campus Lead** role is explicitly granted `View Channel` and `Send Messages` overwrites on the cluster category, providing seamless oversight without per-user manual grants.
- **Exact Discord Channel Types**:
  1. `#announcements` → **Announcement channel** (`ChannelType.GuildAnnouncement`)
  2. `#discussion` → **Forum channel** (`ChannelType.GuildForum`)
  3. `#resources` → **Forum channel** (`ChannelType.GuildForum`)
  4. `#challenges` → **Forum channel** (`ChannelType.GuildForum`)
  5. `#projects` → **Forum channel** (`ChannelType.GuildForum`)
  6. `#cluster-room` → **Voice channel** (`ChannelType.GuildVoice`)
- **Role Scoping**:
  - `<Cluster Name> Member`: Grants access to the cluster's category and channels.
  - `<Cluster Name> Host`: Scoped strictly to the cluster's category (manage messages, manage tasks; zero server-wide moderation power).
- **Persistent Channel Mappings**: Stored in `cluster_discord_mappings` table for rapid lookups by the task engine.

### 6. Cluster Weekly Tasks Engine
- **Supabase Tables (`20260919000000_cluster_tasks.sql`)**:
  - `cluster_tasks`: Tracks tasks per cluster (`id`, `cluster_id`, `title`, `description`, `due_date`, `status`, `forum_thread_id`, `created_by`, `created_at`).
  - `task_submissions`: Tracks member completions (`id`, `task_id`, `os_user_id`, `discord_message_id`, `status`, `marked_by`, `completed_at`, `created_at`, `UNIQUE(task_id, os_user_id)`).
- **`/task-new` Slash Command**:
  - Scoped to that cluster's Host role or the chapter's Campus Lead.
  - Options: `title` (required), `description` (required), `due_date` (optional).
  - Automatically creates a new forum post/thread in that cluster's `#challenges` forum channel, pins it, and stores the task in `cluster_tasks`.
- **"Mark Task Complete" Message Context Menu Command**:
  - Right-click a submission message in Discord → **Apps** → **Mark Task Complete**.
  - Usable only on messages inside an active task's forum thread by that cluster's Host or chapter Campus Lead.
  - Verifies that the author is linked to an ElevatesOS profile; if unverified, warns the moderator.
  - Upserts `task_submissions` with status `'completed'`, records `marked_by` and `completed_at`, and reacts with `✅`.
  - **Undo Capability**: Running "Mark Task Complete" on an already completed submission toggles it back to `'pending'` and removes the `✅` reaction.
  - Operates completely independently of server-wide moderation permissions.

### 7. Permission Split by Server Type
Permissions are enforced using an OS-driven permission matrix (`src/lib/permissions.js`), bypassing static role-name dependencies:

| Role | Main Server Permissions | Chapter Server Permissions |
|---|---|---|
| **Founder / HQ Admin** | Full access (`*`) | Full access (`*`) oversight |
| **Campus Lead** | `/chapter` | Full server moderation + `/task-new` + `Mark Task Complete` across all chapter clusters |
| **Cluster Host** | None | Scoped cluster task management: `/task-new` & `Mark Task Complete` in own cluster |
| **Class Representative** | None | Moderation: `/kick`, `/mute`, `/warn`, `/warnings` (no ban/unban/unlink) |
| **Student Member** | None | Member commands: `/cluster` |

### 8. Preserved Features
- **`/cluster`**: Displays member count and directory of linked chapter members.
- **`/create-cluster`**: Opens public discussion forum threads in the Main Server.
- **Welcome Card Generation**: 800x300 canvas image generated and posted to `#general-chat` upon account verification.
- **DM-to-Staff Forwarding**: Inquiries sent to the bot via DM are forwarded to `#bot-commands` in the Main Server.
- **Unverified Member Nudges**: Alerts unverified members who post in public channels, directing them to `#link-server`.
- **Admin Broadcasts**: `/announce` and `/reply-as-bot` with OS role-based permission checks.

---

## Installation & Setup

1. **Clone repository & install dependencies:**
   ```bash
   npm install
   ```

2. **Configure Environment (`.env`):**
   ```bash
   cp .env.example .env
   ```
   Provide:
   - `DISCORD_TOKEN`: Discord Bot Token
   - `DISCORD_CLIENT_ID`: Discord Application Client ID
   - `DISCORD_CHAPTER_TEMPLATE_URL`: Shared Discord Server Template link used for all chapters (e.g. `https://discord.new/...`)
   - `DISCORD_REDIRECT_URI`: OAuth2 redirect callback URI (e.g. `http://localhost:3000/discord/oauth-callback` or production domain). **Must be added to OAuth2 Redirects in the Discord Developer Portal.**
   - `PORT`: HTTP listener port for the auto-activation OAuth callback server (default: `3000`)
   - `SUPABASE_URL`: Supabase Project URL
   - `SUPABASE_SERVICE_ROLE_KEY`: Supabase Service Role Secret

3. **Apply Database Migrations:**
   Ensure migrations in `supabase/migrations/` are applied to your Supabase project:
   - `20260916000000_discord_bot_tables.sql`
   - `20260917000000_discord_verification_codes.sql`
   - `20260918000000_restructure_sync_and_provisioning.sql`
   - `20260919000000_cluster_tasks.sql`

4. **Register Commands & Context Menus:**
   ```bash
   npm run deploy-commands
   ```

5. **Start Bot:**
   ```bash
   npm start
   ```

---

## Commands & Context Menu Reference

| Command / Action | Type | Usage Context | Required OS / Discord Role | Description |
|---|---|---|---|---|
| `/chapter` | Slash | Main Server | Campus Lead | Generates template clone link & auto-activation bot invite URL (1 server per lead rule) |
| `/connect [id]` | Slash | Any Server | Any User | Connects Discord identity with ElevatesOS |
| `/cluster` | Slash | Chapter Server | Any Member | Displays verified member roster for the chapter |
| `/task-new` | Slash | Chapter Server | Cluster Host / Campus Lead | Creates a weekly task in the cluster's `#challenges` forum |
| **Mark Task Complete** | Message App | Task Thread | Cluster Host / Campus Lead | Toggles task completion for message author with ✅ reaction |
| `/create-cluster` | Slash | Main Server | Staff / Lead | Starts an open community discussion thread in `#doubts-and-help` |
| `/kick <member> [reason]` | Slash | Chapter Server | Campus Lead, Class Rep, Founder | Kicks a member from the server |
| `/ban <member> [reason] [days]` | Slash | Chapter Server | Campus Lead, Founder | Bans a member from the server |
| `/unban <user_id>` | Slash | Chapter Server | Campus Lead, Founder | Unbans a user by their Discord User ID |
| `/mute <member> <duration> [reason]` | Slash | Chapter Server | Campus Lead, Class Rep, Founder | Times out a member (e.g. `10m`, `2h`, `1d`) |
| `/warn <member> <reason>` | Slash | Chapter Server | Campus Lead, Class Rep, Founder | Logs an official moderation warning |
| `/warnings <member>` | Slash | Chapter Server | Campus Lead, Class Rep, Founder | Views a member's warning history |
| `/unlink <member>` | Slash | Chapter Server | Campus Lead, Founder | Force-unlinks an account from ElevatesOS |
| `/announce <channel> <message>` | Slash | Chapter / Main | Campus Lead (chapter), Founder | Broadcasts an announcement |
| `/reply-as-bot <msg_id> <text>` | Slash | Chapter / Main | Campus Lead (chapter), Founder | Replies to a channel message as the bot |
