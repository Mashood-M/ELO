/**
 * Tracks users mid-verification (they've joined a chapter server, waiting for
 * button click and modal submission with their OS user ID).
 *
 * In-memory session tracking keyed by Discord User ID.
 */

const sessions = new Map(); // discordUserId -> { guildId, attempts }

function start(discordUserId, guildId) {
  sessions.set(discordUserId, { guildId, attempts: 0 });
}

function get(discordUserId) {
  return sessions.get(discordUserId);
}

function incrementAttempt(discordUserId, guildId = null) {
  let session = sessions.get(discordUserId);
  if (!session) {
    session = { guildId, attempts: 1 };
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

module.exports = { start, get, incrementAttempt, clear };
