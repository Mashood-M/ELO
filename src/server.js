const http = require('http');
const { URL } = require('url');
const config = require('./config');
const api = require('./lib/api');

/**
 * Escapes HTML characters to prevent XSS in error/status messages.
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Generates an HTML response page for the user's browser.
 */
function renderHtml(title, message, isSuccess = true) {
  const icon = isSuccess ? '✅' : '❌';
  const headerColor = isSuccess ? '#22c55e' : '#ef4444';
  const bgColor = '#0f172a';
  const cardBg = '#1e293b';
  const textColor = '#f8fafc';
  const subTextColor = '#94a3b8';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background-color: ${bgColor};
      color: ${textColor};
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 24px;
    }
    .card {
      background-color: ${cardBg};
      border-radius: 16px;
      padding: 40px 32px;
      max-width: 520px;
      width: 100%;
      text-align: center;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.4), 0 8px 10px -6px rgba(0, 0, 0, 0.4);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    .icon {
      font-size: 56px;
      margin-bottom: 20px;
      line-height: 1;
    }
    h1 {
      font-size: 22px;
      font-weight: 700;
      color: ${headerColor};
      margin-bottom: 16px;
      line-height: 1.3;
    }
    .message {
      font-size: 15px;
      line-height: 1.6;
      color: ${subTextColor};
      margin-bottom: 28px;
      word-break: break-word;
    }
    .footer {
      font-size: 12px;
      color: #64748b;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
      padding-top: 18px;
      letter-spacing: 0.02em;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${escapeHtml(title)}</h1>
    <div class="message">${message}</div>
    <div class="footer">ElevatesOS Chapter Provisioning Engine</div>
  </div>
</body>
</html>`;
}

/**
 * Starts the HTTP server listening for Discord OAuth2 callbacks.
 *
 * @param {import('discord.js').Client} client Discord Client instance
 * @returns {http.Server}
 */
function startServer(client) {
  const port = config.port || process.env.PORT || 3000;

  // Determine expected OAuth callback pathname from config or default to /discord/oauth-callback
  let callbackPath = '/discord/oauth-callback';
  if (config.oauthRedirectUri) {
    try {
      const parsed = new URL(config.oauthRedirectUri);
      if (parsed.pathname) callbackPath = parsed.pathname;
    } catch (_) {}
  }

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || `localhost:${port}`;
      const parsedUrl = new URL(req.url, `http://${host}`);
      const pathname = parsedUrl.pathname;

      // Handle OAuth callback
      if (req.method === 'GET' && (pathname === callbackPath || pathname === '/discord/oauth-callback')) {
        const guildId = parsedUrl.searchParams.get('guild_id');
        const stateToken = parsedUrl.searchParams.get('state');
        const errorCode = parsedUrl.searchParams.get('error');
        const errorDesc = parsedUrl.searchParams.get('error_description');

        if (errorCode) {
          console.warn(`[OAuthCallback] Discord returned error: ${errorCode} - ${errorDesc}`);
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(renderHtml(
            'Authorization Cancelled',
            'Discord authorization was cancelled or denied. Please run <code>/chapter</code> again in the Elevates Main Server.',
            false
          ));
        }

        if (!guildId || !stateToken) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(renderHtml(
            'Invalid or Expired Link',
            'Invalid or expired setup token. Please run /chapter again in the main server.',
            false
          ));
        }

        console.log(`[OAuthCallback] Received activation callback for guild ${guildId} with token prefix ${stateToken.slice(0, 8)}...`);

        // Execute activation
        const result = await api.activateChapter(client, guildId, stateToken);

        if (!result.ok) {
          console.warn(`[OAuthCallback] Activation failed for guild ${guildId}: ${result.message}`);
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(renderHtml(
            'Activation Failed',
            escapeHtml(result.message || 'Invalid or expired setup token. Please run /chapter again in the main server.'),
            false
          ));
        }

        console.log(`[OAuthCallback] Successfully activated chapter "${result.chapterName}" on guild ${guildId}.`);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(renderHtml(
          'Chapter Server Activated!',
          '✅ Chapter server activated! You can close this tab and return to Discord.',
          true
        ));
      }

      // Health probe
      if (req.method === 'GET' && (pathname === '/health' || pathname === '/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          status: 'ok',
          service: 'elevates-discord-bot',
          bot: client?.user ? client.user.tag : 'ready',
        }));
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    } catch (err) {
      console.error('[HTTPServer] Unhandled error during request processing:', err);
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderHtml(
        'Internal Server Error',
        'An unexpected error occurred during server activation. Please try again or contact support.',
        false
      ));
    }
  });

  server.listen(port, () => {
    console.log(`[HTTPServer] Listening on port ${port} (OAuth callback: ${callbackPath})`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[HTTPServer] Port ${port} is already in use by another process. Ensure only one instance of the bot is running.`);
    } else {
      console.error('[HTTPServer] Server error:', err);
    }
  });

  return server;
}

module.exports = {
  startServer,
};
