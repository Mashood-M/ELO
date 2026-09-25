require('dotenv').config();

module.exports = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,

  // Single shared Discord Server Template link used for every chapter
  chapterTemplateUrl: process.env.DISCORD_CHAPTER_TEMPLATE_URL || 'https://discord.new/w44zY38vKP4h',

  // Bot invite URL for chapter servers
  botInviteUrl: process.env.DISCORD_BOT_INVITE_URL || (process.env.DISCORD_CLIENT_ID ? `https://discord.com/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&scope=bot%20applications.commands&permissions=8` : ''),

  // HTTP listener port for OAuth callback server
  port: parseInt(process.env.PORT || '3000', 10),

  // OAuth2 redirect URI registered in Discord Developer Portal (e.g. http://localhost:3000/discord/oauth-callback)
  oauthRedirectUri: process.env.DISCORD_REDIRECT_URI || '',

  supabase: {
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },

  roles: {
    founder: process.env.ROLE_FOUNDER || 'ELEVATES • Founder',
    admin: process.env.ROLE_ADMIN || 'ELEVATES • Admin',
    campusLead: process.env.ROLE_CAMPUS_LEAD || 'Campus Lead',
    executiveMember: process.env.ROLE_EXECUTIVE_MEMBER || 'Executive Member',
    classRep: process.env.ROLE_CLASS_REP || 'Class Rep',
    verified: process.env.ROLE_VERIFIED || 'ELEVATES • Member',
    unverified: process.env.ROLE_UNVERIFIED || 'elevates',
    adminRoles: [
      process.env.ROLE_CAMPUS_LEAD || 'Campus Lead',
      process.env.ROLE_ADMIN || 'ELEVATES • Admin',
      process.env.ROLE_FOUNDER || 'ELEVATES • Founder',
    ],
    // Tier B moderation roles in chapter servers (Campus Lead + Tier B)
    tierBRoles: [
      'executive_member',
      'exec_member',
      'executive',
      'class_representative',
      'class_rep',
      'moderator',
    ],
  },

  features: {
    welcomeCard: process.env.FEATURE_WELCOME_CARD !== 'false',
    unverifiedNudge: process.env.FEATURE_UNVERIFIED_NUDGE !== 'false',
    adminBroadcast: process.env.FEATURE_ADMIN_BROADCAST !== 'false',
  },

  maxVerifyAttempts: parseInt(process.env.MAX_VERIFY_ATTEMPTS || '3', 10),

  // Main Discord Server Configuration
  mainGuildId: process.env.MAIN_GUILD_ID || '1544247855173345310',

  // Fixed, manually-created role list and OS role mapping for the Main Server
  mainRoles: {
    // Fixed allowed role names in Main Server (NEVER auto-create outside this list)
    allowedRoles: [
      'Founder',
      'HQ Admin',
      'Community Manager',
      'Campus Lead',
      'Class Rep',
      'Verified Member',
      'Guest',
      'Unverified',
    ],

    // Mapping from OS role_key -> fixed main-server role name
    roleMapping: {
      founder: 'Founder',
      hq_admin: 'HQ Admin',
      admin: 'HQ Admin',
      community_manager: 'Community Manager',
      campus_lead: 'Campus Lead',
      executive_member: 'Verified Member',
      exec_member: 'Verified Member',
      executive: 'Verified Member',
      class_representative: 'Class Rep',
      class_rep: 'Class Rep',
      guest: 'Guest',
      student: 'Verified Member',
      volunteer: 'Verified Member',
      faculty_coordinator: 'Verified Member',
      alumni: 'Verified Member',
    },

    // Default/fallback role for OS roles with no granular equivalent
    defaultRole: 'Verified Member',

    /**
     * Resolves the main server role name for a given OS role_key.
     * @param {string} roleKey
     * @returns {string|null}
     */
    getMainRoleForOsRole(roleKey) {
      if (!roleKey) return this.defaultRole;
      const key = roleKey.toLowerCase().trim();
      return this.roleMapping[key] || null;
    },
  },
};
