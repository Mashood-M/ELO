require('dotenv').config();

module.exports = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,

  supabase: {
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },

  roles: {
    founder: process.env.ROLE_FOUNDER || 'ELEVATES • Founder',
    admin: process.env.ROLE_ADMIN || 'ELEVATES • Admin',
    campusLead: process.env.ROLE_CAMPUS_LEAD || 'Campus Lead',
    classRep: process.env.ROLE_CLASS_REP || 'Class Rep',
    verified: process.env.ROLE_VERIFIED || 'ELEVATES • Member',
    unverified: process.env.ROLE_UNVERIFIED || 'elevates',
    adminRoles: [
      process.env.ROLE_CAMPUS_LEAD || 'Campus Lead',
      process.env.ROLE_ADMIN || 'ELEVATES • Admin',
      process.env.ROLE_FOUNDER || 'ELEVATES • Founder',
    ],
  },

  staffDmForwardChannel: process.env.STAFF_DM_FORWARD_CHANNEL || 'bot-commands',

  features: {
    welcomeCard: process.env.FEATURE_WELCOME_CARD !== 'false',
    dmForwarding: process.env.FEATURE_DM_FORWARDING !== 'false',
    unverifiedNudge: process.env.FEATURE_UNVERIFIED_NUDGE !== 'false',
    adminBroadcast: process.env.FEATURE_ADMIN_BROADCAST !== 'false',
  },

  maxVerifyAttempts: parseInt(process.env.MAX_VERIFY_ATTEMPTS || '3', 10),
};
