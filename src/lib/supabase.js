const { createClient } = require('@supabase/supabase-js');
const config = require('../config');

const supabaseUrl = config.supabase?.url || process.env.SUPABASE_URL || '';
const supabaseServiceRoleKey = config.supabase?.serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!supabaseUrl || !supabaseServiceRoleKey) {
  // Warn on missing credentials without throwing immediately on file require,
  // allowing module loading/mocking in tests and scripts.
  console.warn('Warning: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing from environment.');
}

const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseServiceRoleKey || 'placeholder-service-role-key',
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);

module.exports = supabase;
