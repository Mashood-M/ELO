# ElevatesOS Discord Bot

Direct bridge between **ElevatesOS** and **Discord**: identity-based account linking (zero DMs), resilient role and chapter synchronization, self-serve chapter server provisioning, private cluster workspaces, and role-based permissions split across main and chapter servers.

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

### 3. Chapter Server Provisioning (`/chapter` & `/activate-chapter`)
- **`/chapter` Command (Main Server)**:
  - Usable by verified **Campus Leads** in the Main Server to provision a server for their assigned chapter.
  - Verifies that the caller holds the `campus_lead` role in ElevatesOS and that the chapter has no existing server configured.
  - Generates a 1-hour setup token (`chp_...`) and provides the Discord Server Template link and bot invite link.
- **`/activate-chapter <token>` Command (New Chapter Server)**:
  - Executed by the Campus Lead inside the new chapter server once the bot joins.
  - Automatically maps the guild to the chapter in `guild_config`.
  - Creates Discord roles matching every active role in the OS `roles` table.
  - Grants the Campus Lead their role and equips the role with the **Administrator** permission within that chapter server only.
  - Automatically sets up the `#link-server` portal with the `🔗 Connect Account` button.
  - **Founders Oversight in Main Server**: Creates a dedicated channel under the `Chapter Management` category in the Main Server (`#chp-<chapter-slug>`), permissioned exclusively for Founders/HQ Admins. Logs activation and streams real-time chapter events (joins, leaves, moderation actions) to this channel.

### 4. Permission Split by Server Type
Permissions are enforced using an OS-driven permission matrix (`src/lib/permissions.js`), bypassing static role-name dependencies:

| Role | Main Server Permissions | Chapter Server Permissions |
|---|---|---|
| **Founder / HQ Admin** | Full access (`*`) | Full access (`*`) oversight |
| **Campus Lead** | `/chapter` | Full moderation: `/kick`, `/ban`, `/unban`, `/mute`, `/warn`, `/warnings`, `/unlink`, `/announce`, `/reply-as-bot` |
| **Class Representative** | None | Moderation: `/kick`, `/mute`, `/warn`, `/warnings` (no ban/unban/unlink) |
| **Student Member** | None | Member commands: `/cluster` |

### 5. Private Chapter Clusters
- Detects cluster entries in `clusters` and `cluster_members` scoped to a chapter.
- Automatically creates a **Private Category** named after the cluster (denying `@everyone`), containing:
  1. `#discussion-and-doubts`: Text channel for doubt clearing and community questions.
  2. `#resources`: Curated resources, documentation, and references.
  3. `#challenges-and-tasks`: Weekly milestones, challenges, and roadmaps.
  4. `#projects`: Project collaboration and showcase threads.
  5. `🔊 Live Sessions`: Voice room for live calls and workshops.
- Automatically creates roles:
  - `<Cluster Name> Member`: Grants viewing, messaging, file attachments, and voice access to the cluster category.
  - `<Cluster Name> Host`: Granted if `cluster.leader_id` is set. Permissions are scoped strictly to the cluster's category (manage messages, pin messages, voice moderation; no server-wide kick/ban).
- Continuous membership synchronization: adding or removing a student in the OS cluster automatically grants or revokes their member role; leader changes reassign the host role.

### 6. Preserved Features
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
   - `SUPABASE_URL`: Supabase Project URL
   - `SUPABASE_SERVICE_ROLE_KEY`: Supabase Service Role Secret

3. **Apply Database Migrations:**
   Ensure migrations in `supabase/migrations/` are applied to your Supabase project:
   - `20260916000000_discord_bot_tables.sql`
   - `20260917000000_discord_verification_codes.sql`
   - `20260918000000_restructure_sync_and_provisioning.sql`

4. **Register Slash Commands:**
   ```bash
   npm run deploy-commands
   ```

5. **Start Bot:**
   ```bash
   npm start
   ```

---

## Slash Commands Reference

| Command | Usage Context | Required OS Role | Description |
|---|---|---|---|
| `/chapter` | Main Server | Campus Lead | Generates setup token & template link to provision a chapter server |
| `/activate-chapter <token>` | Chapter Server | Campus Lead / Admin | Activates and configures a newly created chapter server |
| `/connect [id]` | Any Server | Any User | Connects Discord identity with ElevatesOS |
| `/cluster` | Chapter Server | Any Member | Displays verified member roster for the chapter |
| `/create-cluster` | Main Server | Staff / Lead | Starts an open community discussion thread in `#doubts-and-help` |
| `/kick <member> [reason]` | Chapter Server | Campus Lead, Class Rep, Founder | Kicks a member from the server |
| `/ban <member> [reason] [days]` | Chapter Server | Campus Lead, Founder | Bans a member from the server |
| `/unban <user_id>` | Chapter Server | Campus Lead, Founder | Unbans a user by their Discord User ID |
| `/mute <member> <duration> [reason]` | Chapter Server | Campus Lead, Class Rep, Founder | Times out a member (e.g. `10m`, `2h`, `1d`) |
| `/warn <member> <reason>` | Chapter Server | Campus Lead, Class Rep, Founder | Logs an official moderation warning |
| `/warnings <member>` | Chapter Server | Campus Lead, Class Rep, Founder | Views a member's warning history |
| `/unlink <member>` | Chapter Server | Campus Lead, Founder | Force-unlinks an account from ElevatesOS |
| `/announce <channel> <message>` | Chapter / Main | Campus Lead (chapter), Founder | Broadcasts an announcement |
| `/reply-as-bot <msg_id> <text>` | Chapter / Main | Campus Lead (chapter), Founder | Replies to a channel message as the bot |
