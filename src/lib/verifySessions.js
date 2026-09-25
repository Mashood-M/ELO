/**
 * Tracks users mid-verification.
 *
 * In-memory session tracking keyed by Discord User ID with automatic TTL eviction (Section 5.6).
 */

const sessions = new Map(); // discordUserId -> { guildId, attempts, createdAt }
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour TTL

// Periodic eviction to prevent memory leaks in long-running bot process
setInterval(() => {
  const now = Date.now();
  for (const [userId, session] of sessions.entries()) {
    if (session.createdAt && now - session.createdAt > SESSION_TTL_MS) {
      sessions.delete(userId);
    }
  }
}, 15 * 60 * 1000).unref();

function start(discordUserId, guildId) {
  sessions.set(discordUserId, { guildId, attempts: 0, createdAt: Date.now() });
}

function get(discordUserId) {
  const session = sessions.get(discordUserId);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(discordUserId);
    return null;
  }
  return session;
}

function incrementAttempt(discordUserId, guildId = null) {
  let session = sessions.get(discordUserId);
  const now = Date.now();
  if (!session || (session.createdAt && now - session.createdAt > SESSION_TTL_MS)) {
    session = { guildId, attempts: 1, createdAt: now };
    sessions.set(discordUserId, session);
  } else {
    session.attempts += 1;
    if (guildId && !session.guildId) {
      session.guildId = guildId;
    }
  }
  return session;
}

function clear(discordUserId) {
  sessions.delete(discordUserId);
}

module.exports = { start, get, incrementAttempt, clear, sessions };
