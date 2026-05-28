// api/garmin-auth.js
// Garmin OAuth 1.0a — two actions:
//   GET  ?action=init&callbackUrl=xxx   → { authorizeUrl, requestToken, requestTokenSecret }
//   POST ?action=exchange               → body: { requestToken, requestTokenSecret, verifier }
//                                       → { accessToken, accessTokenSecret }
//
// Required Vercel env vars: GARMIN_CONSUMER_KEY, GARMIN_CONSUMER_SECRET
// Apply for access: https://developer.garmin.com/health-api/overview/

const crypto = require('crypto');

// ── OAuth 1.0a helpers (no external deps needed) ──────────────

function pct(s) { return encodeURIComponent(String(s ?? '')); }

function oauthSign(method, url, params, consumerSecret, tokenSecret = '') {
  const paramStr = Object.keys(params).sort().map(k => `${pct(k)}=${pct(params[k])}`).join('&');
  const base     = `${pct(method.toUpperCase())}&${pct(url)}&${pct(paramStr)}`;
  const key      = `${pct(consumerSecret)}&${pct(tokenSecret)}`;
  return crypto.createHmac('sha1', key).update(base).digest('base64');
}

function oauthHeader(method, url, ck, cs, token = '', ts = '', extra = {}) {
  const p = {
    oauth_consumer_key:     ck,
    oauth_nonce:            crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
    oauth_version:          '1.0',
    ...extra,
  };
  if (token) p.oauth_token = token;
  p.oauth_signature = oauthSign(method, url, p, cs, ts);
  return 'OAuth ' + Object.keys(p).map(k => `${pct(k)}="${pct(p[k])}"`).join(', ');
}

async function garminPost(url, authHeader) {
  const res = await fetch(url, { method: 'POST', headers: { Authorization: authHeader } });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Garmin ${res.status}: ${txt.slice(0, 200)}`);
  return Object.fromEntries(new URLSearchParams(txt));
}

// ── Handler ───────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const CK = process.env.GARMIN_CONSUMER_KEY;
  const CS = process.env.GARMIN_CONSUMER_SECRET;

  if (!CK || !CS) {
    return res.status(503).json({
      error: 'GARMIN_NOT_CONFIGURED',
      message: 'Add GARMIN_CONSUMER_KEY and GARMIN_CONSUMER_SECRET to your Vercel environment variables.',
      applyUrl: 'https://developer.garmin.com/health-api/overview/',
    });
  }

  const action = req.query.action || (req.body?.action);

  // ── Step 1: Get a request token ────────────────────────────
  if (action === 'init') {
    const callbackUrl = req.query.callbackUrl || req.body?.callbackUrl;
    if (!callbackUrl) return res.status(400).json({ error: 'Missing callbackUrl' });

    const url    = 'https://connectapi.garmin.com/oauth-service/oauth/request_token';
    const header = oauthHeader('POST', url, CK, CS, '', '', { oauth_callback: callbackUrl });
    try {
      const params = await garminPost(url, header);
      return res.json({
        requestToken:       params.oauth_token,
        requestTokenSecret: params.oauth_token_secret,
        authorizeUrl:       `https://connect.garmin.com/oauthConfirm?oauth_token=${params.oauth_token}`,
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Step 2: Exchange verifier for access token ─────────────
  if (action === 'exchange') {
    const { requestToken, requestTokenSecret, verifier } = req.body || {};
    if (!requestToken || !requestTokenSecret || !verifier) {
      return res.status(400).json({ error: 'Missing requestToken, requestTokenSecret, or verifier' });
    }

    const url    = 'https://connectapi.garmin.com/oauth-service/oauth/access_token';
    const header = oauthHeader('POST', url, CK, CS, requestToken, requestTokenSecret,
                               { oauth_verifier: verifier });
    try {
      const params = await garminPost(url, header);
      return res.json({
        accessToken:       params.oauth_token,
        accessTokenSecret: params.oauth_token_secret,
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Unknown action. Use ?action=init or action=exchange.' });
};
