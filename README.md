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
- **Executive Member Role Sync**:
  - Monitors `user_roles` in Realtime for rows where `role_key = 'executive_member'`.
  - **On Insert**: Automatically creates the "Executive Member" Discord role (color: `#3B82F6`) in that chapter's server if it does not already exist, and assigns it to the user.
  - **On Removal / Handover**: When the `user_roles` row is deleted, a handover occurs, or the user is demoted, the bot immediately revokes the "Executive Member" role in Discord.
  - *Context on `is_permanent`*: In the ElevatesOS schema, `user_roles.is_permanent = true` for `executive_member` rows. This column relates strictly to internal OS term logic; removal in Discord is driven purely by whether the matching `user_roles` row currently exists.
- **Handling Chapter Transitions**: If a member's chapter assignment changes in ElevatesOS, the bot automatically strips chapter roles from the previous chapter server and grants access in the new one.
- **Resilient Sync Queue (`SyncQueue`)**:
  - Multi-worker priority queue (`maxConcurrency = 3`, `minDelayMs = 25ms`).
  - High priority for interactive role updates, webhooks, and realtime events; background low priority for startup reconciliation.
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
- **Founders Oversight in Main Server**: Upon chapter server activation, the bot establishes a dedicated **Forum channel** per chapter (`#chp-<chapter-slug>`) inside the `CHAPTER LOGS 🔒` category, permissioned exclusively for Founders and HQ Admins.
- **Auto-Created Starter Log Threads**: On forum creation, the bot automatically spins up 8 distinct starter threads:
  - `🛡️ Moderation`: Moderation actions including kicks, bans, unbans, mutes/timeouts, warnings, unlinks, and message purge (/clear).
  - `💬 Discord Activity`: Real-time Discord server events including deleted messages, message edits, voice channel join/leave/switch, and server invites.
  - `⚙️ Channel & Role Changes`: Chapter activation notices, channel/role creations, updates, and deletions.
  - `🎭 Role Changes`: ElevatesOS role assignments, promotions, demotions, and permission updates.
  - `👥 Current Roles`: Live synchronized roster of all current chapter leads, core team, and role holders.
  - `📅 Events & Meetups`: Event creation, schedule updates, attendance check-ins, and form releases.
  - `🧠 Cluster Activity`: Cluster lifecycle events, member role additions/removals, and host assignments.
  - `👤 Membership`: Member join events (verified and unverified), server leaves, account linking updates, and nickname changes.
- **Centralized Event Router**: `api.logChapterEvent` automatically maps event types and routes rich embed notifications into the appropriate chapter thread in the Main Server and to the local server's `#mod-log`.

### 5. Production-Grade Cluster Synchronization System
The bot features a complete, resilient synchronization engine between Supabase and Discord for clusters, incorporating dynamic server placement by `access_mode` and direct array-diff membership synchronization:

#### Database Schema
- **`clusters`**:
  - `access_mode` (TEXT): Determines target guild placement (`'open'` -> Main Server, `'invite'`/closed -> Chapter Server).
  - `member_ids` (UUID[]): Direct array of member UUIDs (replaces previous join-table assumption).
  - `leader_id` (UUID nullable): Cluster Host / Leader profile ID.
  - `discord_category_id` (TEXT, nullable): ID of the private Discord category.
  - `discord_role_id` (TEXT, nullable): ID of the cluster member Discord role.
- **`pending_discord_roles`** (deferred role assignment):
  - `id` (UUID PK): Unique pending role identifier.
  - `user_id` (UUID FK -> `profiles`): User awaiting role assignment.
  - `role_type` (TEXT, `'cluster_member'` | `'cluster_host'` | `'chapter_role'`): Target role type.
  - `target_id` (UUID): Cluster ID or Chapter ID.
  - `created_at` (TIMESTAMPTZ): Timestamp queued.
- **`discord_sync_log`** (audit trail):
  - `id` (UUID PK): Unique log identifier.
  - `event_type` (TEXT): Event name (e.g. `cluster_created`, `cluster_member_added`, `cluster_member_removed`, `pending_role_resolved`, `cluster_archived`, `reconciliation_drift_corrected`).
  - `user_id` (UUID nullable): Associated profile ID.
  - `cluster_id` (UUID nullable): Associated cluster ID.
  - `discord_role_id` (TEXT nullable): Role ID impacted.
  - `action` (TEXT, `'granted'` | `'revoked'` | `'created'` | `'archived'`): Action executed.
  - `success` (BOOLEAN): Whether the operation succeeded.
  - `error_message` (TEXT nullable): Error details if operation failed.
  - `created_at` (TIMESTAMPTZ): Audit timestamp.

#### Dynamic Placement by `access_mode`
- **`access_mode = 'open'`**:
  - The private category, `<Cluster Name> Member` role, and child channels are created in the **Elevates Main Server** (confirmed via `guild_config` where `guild_type = 'main'`, fallback `MAIN_GUILD_ID`).
- **`access_mode = 'invite'` (or closed)**:
  - Created in the specific **Chapter Server** that `clusters.chapter_id` maps to.
- Both paths reuse the exact same creation sequence: role creation with immediate ID write-back, category with permission overwrites, child channels, and `discord_category_id` write-back.

#### Membership Sync via Array Diffing (`clusters.member_ids`)
There is no separate `cluster_members` join table — membership lives as `clusters.member_ids UUID[]` directly on the `clusters` row. The bot monitors `clusters` UPDATE events in Supabase Realtime (with `REPLICA IDENTITY FULL` enabled):
- **User present in `NEW.member_ids` but not in `OLD.member_ids`**: Treated as a member addition:
  - If user is linked and present in the target guild: grants the cluster role immediately.
  - If user is unlinked or not yet in the target guild: queues into `pending_discord_roles`.
- **User present in `OLD.member_ids` but not in `NEW.member_ids`**: Treated as a member removal:
  - Revokes the cluster role in the target guild.
  - Deletes any matching row in `pending_discord_roles`.
- **Host Role Diffing (`clusters.leader_id`)**: Compares `OLD.leader_id` against `NEW.leader_id` on UPDATE to assign the `<Cluster Name> Host` role to the new leader and revoke it from the former leader.

#### Event Flow & Lifecycle

```
[Supabase Event]
       │
       ├── clusters (INSERT) ──────────► handleClusterCreated
       │                                     1. Resolve target guild (Main server if access_mode='open', else Chapter server)
       │                                     2. Create '<Name> Member' role & immediately UPDATE clusters.discord_role_id
       │                                     3. Create private category with permission overwrites
       │                                     4. Create child channels (#announcements, #discussion, #resources, #challenges, #projects, Voice)
       │                                     5. UPDATE clusters.discord_category_id & log to discord_sync_log
       │                                     6. Initial role grant for any pre-populated member_ids and leader_id
       │
       ├── clusters (UPDATE: archived) ─► handleClusterArchived
       │                                     1. Rename category to '[ARCHIVED] <Name>'
       │                                     2. Reject auto-assignment for new members
       │                                     3. Preserve channels & roles for 30-day grace period
       │
       ├── clusters (UPDATE: member_ids)► Array Diffing:
       │                                     ├── User in NEW but not OLD ──► handleMemberAdded (grant role or queue pending)
       │                                     └── User in OLD but not NEW ──► handleMemberRemoved (revoke role & delete pending)
       │
       ├── clusters (UPDATE: leader_id) ─► Leader Diffing:
       │                                     ├── New leader assigned ──► Grant '<Name> Host' role
       │                                     └── Old leader removed ──► Revoke '<Name> Host' role
       │
       └── discord_links (INSERT/linked) ► handleUserLinked
                                             1. Query pending_discord_roles for user
                                             2. For each pending role (isolated try/catch):
                                                - If cluster archived/deleted: skip & delete pending row
                                                - If member in guild: grant role & delete pending row
                                                - Log outcome to discord_sync_log
```

#### Rate Limiting & Backoff (`SyncQueue`)
- Every Discord API call (role creation, assignment, category/channel provisioning, renaming) is routed through `syncQueue.enqueueAsync(...)`.
- Automatic HTTP 429 rate limit backoff uses Discord's `retry_after` headers.
- Sequential pacing (`250ms` spacing) and exponential retry backoff (up to 4 attempts) ensure zero unhandled rate-limit drops.
- Role assignments check `member.roles.cache.has(roleId)` first to skip redundant API requests.

#### Role Reconciliation & Drift Correction
A built-in reconciliation engine compares `clusters.member_ids` (and `leader_id`) in Supabase against actual Discord role holders in that cluster's role:
- **Grants missing roles**: Members linked in Supabase who do not currently hold the cluster role.
- **Revokes excess roles**: Discord members holding the cluster role who are no longer present in `clusters.member_ids`.
- **Logs all corrections**: Every drift correction is audited in `discord_sync_log` under `reconciliation_drift_corrected`.

##### Triggering Reconciliation Manually
Run the reconciliation script from the command line:
```bash
# Reconcile all active clusters across all chapters
node scripts/reconcile-clusters.js

# Reconcile a specific cluster by ID
node scripts/reconcile-clusters.js --cluster <cluster-uuid>

# Preview drift without executing changes (dry run)
node scripts/reconcile-clusters.js --dry-run
```

Programmatic execution is also available via `clusterSync`:
```javascript
const { reconcileClusterMembers, reconcileAllClusters } = require('./src/lib/clusterSync');

// Reconcile single cluster
await reconcileClusterMembers(client, clusterId);

// Reconcile all active clusters
await reconcileAllClusters(client);
```

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
| **Executive Member** | None | Per-person delegated moderation subset via `term_members.permissions` (e.g. `/kick`, `/ban`, `/mute`, `/warn`, `/unlink`, `/announce`, `/reply-as-bot`) |
| **Cluster Host** | None | Scoped cluster task management: `/task-new` & `Mark Task Complete` in own cluster |
| **Class Representative** | None | Moderation: `/kick`, `/mute`, `/warn`, `/warnings` (no ban/unban/unlink) |
| **Student Member** | None | Member commands: `/cluster` |

### 8. Per-Person Delegated Permissions System
Replaces the flat "Tier B" assumption with granular, per-person permission delegation:
- **Schema Source (`term_members.permissions TEXT[]`)**:
  - Executive members (`role_key = 'executive_member'`) can be delegated an individual subset of Campus-Lead-equivalent powers in their chapter (e.g., `['kick', 'warn']` for one person, `['ban', 'unban']` for another, `['announce']` for a communications lead).
  - Permissions are retrieved by joining the chapter's currently active term (`terms.status = 'active'`) and querying `term_members.permissions` for the member's OS `user_id`.
- **Campus Lead Full Access Retained**:
  - Campus Leads retain full, unrestricted access to all chapter moderation commands regardless of any array contents. The array is solely used to delegate a subset of powers to executive members, never to restrict Campus Leads.
- **Live Command-Time Verification & Realtime Cache Invalidation**:
  - Because permissions can be modified at any moment in ElevatesOS by a Campus Lead, permissions are verified live at command execution time (`canUserExecuteCommand` calling `getUserDelegatedPermissions`).
  - Short-lived caching (`60s` TTL) is combined with instant Realtime cache invalidation listeners on `terms` and `term_members` UPDATE/INSERT/DELETE events.
- **Centralized Command-to-Permission Mapping (`src/config.js`)**:
  Moderation commands are mapped to discrete permission strings via `config.delegatedPermissions`:
  - `/ban` ➔ `'ban'`
  - `/unban` ➔ `'unban'`
  - `/unlink` ➔ `'unlink'`
  - `/kick` ➔ `'kick'`
  - `/mute` ➔ `'mute'`
  - `/warn` ➔ `'warn'`
  - `/warnings` ➔ `'warn'`
  - `/announce` ➔ `'announce'`
  - `/reply-as-bot` ➔ `'reply-as-bot'`
  - `/clear` ➔ `'clear'`

### 9. Two-Way DM Support & Modmail System
- **Private Staff Forum (`#user-dm-support`)**: Auto-created in the Main Server, visible strictly to Founders, HQ Admins, and the bot.
- **Permanent Mailbox Threads**: Direct messages sent to the bot (excluding active account verification sessions) automatically route into a dedicated, permanent forum thread titled with the member's Discord and ElevatesOS name.
- **Database Tracking (`dm_threads`)**: Maps each `discord_user_id` to their permanent `forum_thread_id` and tracks conversation status (`open` | `closed`).
- **Two-Way Relaying**:
  - Staff (Founders & HQ Admins) reply directly inside the support thread; the bot immediately relays their message (and attachments) to the user via DM prefixed as `**Elevates Support Team:**\n<message content>`.
  - Non-staff replies are rejected with `❌` and an authorization warning.
  - Delivery failures (e.g. user DMs closed or no mutual server) react with `⚠️` and post `"Couldn't deliver this to the user — they may have DMs disabled."`.
  - Successful deliveries react with `✅`.
- **Conversation Lifecycle**:
  - Staff can close a resolved ticket using the **"Close Ticket"** message context menu, `/close-ticket` slash command, or `!close` text command. This marks status as `'closed'`, archives the Discord thread, and sends a resolution note to the user.
  - Future DMs from that user automatically unarchive and reopen the existing thread with a `🔄 Conversation reopened` notice rather than creating duplicates.
- **First-Message Welcome**: Only the first message of a new or reopened conversation sends an automated acknowledgment to avoid repetitive spam.

### 10. Preserved Features
- **`/cluster`**: Displays member count and directory of linked chapter members.
- **`/create-cluster`**: Opens public discussion forum threads in the Main Server.
- **Welcome Card Generation**: 800x300 canvas image generated and posted to `#general-chat` upon account verification.
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
   - `20260920000000_chapter_log_threads.sql`
   - `20260921000000_dm_support_threads.sql`
   - `20260924000000_discord_tickets.sql`
   - `20260925000000_term_handover_logs.sql`
   - `20260925010000_cluster_sync_system.sql`
   - `20260926000000_cluster_replica_identity_and_delegated_perms.sql`

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
| `/kick <member> [reason]` | Slash | Chapter Server | Campus Lead, Executive Member (delegated `'kick'`), Class Rep, Founder | Kicks a member from the server |
| `/ban <member> [reason] [days]` | Slash | Chapter Server | Campus Lead, Executive Member (delegated `'ban'`), Founder | Bans a member from the server |
| `/unban <user_id>` | Slash | Chapter Server | Campus Lead, Executive Member (delegated `'unban'`), Founder | Unbans a user by their Discord User ID |
| `/mute <member> <duration> [reason]` | Slash | Chapter Server | Campus Lead, Executive Member (delegated `'mute'`), Class Rep, Founder | Times out a member (e.g. `10m`, `2h`, `1d`) |
| `/warn <member> <reason>` | Slash | Chapter Server | Campus Lead, Executive Member (delegated `'warn'`), Class Rep, Founder | Logs an official moderation warning |
| `/warnings <member>` | Slash | Chapter Server | Campus Lead, Executive Member (delegated `'warn'`), Class Rep, Founder | Views a member's warning history |
| `/unlink <member>` | Slash | Chapter Server | Campus Lead, Executive Member (delegated `'unlink'`), Founder | Force-unlinks an account from ElevatesOS |
| `/announce <channel> <message>` | Slash | Chapter / Main | Campus Lead (chapter), Executive Member (delegated `'announce'`), Founder | Broadcasts an announcement |
| `/reply-as-bot <msg_id> <text>` | Slash | Chapter / Main | Campus Lead (chapter), Executive Member (delegated `'reply-as-bot'`), Founder | Replies to a channel message as the bot |
| `/clear <password> [amount] [user]` | Slash | Any Server | Password Authorized (`mashood`), Executive Member (delegated `'clear'`) | Bulk deletes messages in the current channel |
| **Close Ticket** | Message App | Support Thread | Lane Authorized Staff | Closes and archives the user support ticket |
| `/close-ticket` | Slash | Support Thread | Lane Authorized Staff | Closes and archives the user support ticket |

---

## Utility Scripts

These stand-alone utility scripts are manual administrative tools designed for maintenance and configuration; they are **not** part of the bot's regular startup or runtime.

### 1. Main Server Channel Visibility Permissions (`scripts/apply-main-server-permissions.js`)

Enforces category-level channel visibility permissions across the Elevates Main Server per the agreed architectural structure:
- **`@everyone`**: `ViewChannel` allowed **only** on the `"01 • Start Here"` category (and denied on all other categories server-wide).
- **`Verified Member`**: `ViewChannel` allowed on all public categories (`02 • Elevates Community`, `03 • Discover Elevates`, `04 • Open Events`, `05 • Open Clusters`, `06 • Global Projects`, `07 • Global Opportunities`, `08 • Elevates Network`, `09 • ELO`, and `Community Voice`).
- **Locked Categories**: (`10 • Founders HQ`, `11 • HQ Operations`, `12 • Community Management`, `13 • Chapter Management`, `14 • Cluster Management`, `15 • Private Projects`, `Chapter Logs`, `Founder Tickets`, `Admin Tickets`): Restricted to `Founder` and `HQ Admin` only; denied to all others (including `Verified Member`).
- **`Unverified`**: Status-tracking role only; receives no special permission overwrites anywhere.
- **Child Channel Inheritance**: Checks all child channels under each category and resets any explicit, desynced overwrites (`lockPermissions()`) so channels inherit cleanly from their parent category without unexpected overrides.
- **Resilient Role Resolution**: Looks up roles by exact name (`@everyone`, `Verified Member`, `Founder`, `HQ Admin`) and gracefully warns and skips any missing roles without crashing.

#### Commands:

- **Dry-run mode** (scans categories, roles, and child channels, printing planned changes without modifying Discord):
  ```bash
  node scripts/apply-main-server-permissions.js
  ```

- **Confirm mode** (applies category permission overwrites and locks desynced child channels):
  ```bash
  node scripts/apply-main-server-permissions.js --confirm
  ```

- Optional `--guild-id` flag to target a specific server:
  ```bash
  node scripts/apply-main-server-permissions.js --confirm --guild-id <MAIN_GUILD_ID>
  ```

### 2. Main Server Role Cleanup (`scripts/cleanup-main-server-roles.js`)

Cleans up extraneous and obsolete roles from the Elevates Main Server, preserving only allowed operational roles (`Founder`, `HQ Admin`, `Community Manager`, `Campus Lead`, `Class Rep`, `Verified Member`, `Guest`, `Unverified`), Discord base `@everyone`, and bot integration roles.

#### Commands:

- **Dry-run mode**:
  ```bash
  node scripts/cleanup-main-server-roles.js
  ```

- **Confirm mode**:
  ```bash
  node scripts/cleanup-main-server-roles.js --confirm
  ```

