// api/garmin-sleep.js
// Fetches sleep data from the Garmin Health API for a connected user.
//
// POST body: { accessToken, accessTokenSecret, days? (default 14) }
// Returns:   { success: true, sleep: [ ...entries ] }
//
// Each entry matches the app's sleepLog schema:
//   { date, bed, wake, mins, quality, notes, source:'garmin',
//     garminScore, deepMins, remMins, lightMins, awakeMins }
//
// Required Vercel env vars: GARMIN_CONSUMER_KEY, GARMIN_CONSUMER_SECRET

const crypto = require('crypto');

function pct(s) { return encodeURIComponent(String(s ?? '')); }

function oauthSign(method, url, params, consumerSecret, tokenSecret = '') {
  const paramStr = Object.keys(params).sort().map(k => `${pct(k)}=${pct(params[k])}`).join('&');
  const base     = `${pct(method.toUpperCase())}&${pct(url)}&${pct(paramStr)}`;
  const key      = `${pct(consumerSecret)}&${pct(tokenSecret)}`;
  return crypto.createHmac('sha1', key).update(base).digest('base64');
}

function oauthHeader(method, url, ck, cs, token, tokenSecret) {
  const p = {
    oauth_consumer_key:     ck,
    oauth_nonce:            crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
    oauth_token:            token,
    oauth_version:          '1.0',
  };
  p.oauth_signature = oauthSign(method, url, p, cs, tokenSecret);
  return 'OAuth ' + Object.keys(p).map(k => `${pct(k)}="${pct(p[k])}"`).join(', ');
}

// Map Garmin sleep score (0-100) → 1-5 quality stars
function scoreToQuality(score) {
  if (!score) return 3;
  if (score >= 80) return 5;
  if (score >= 65) return 4;
  if (score >= 50) return 3;
  if (score >= 35) return 2;
  return 1;
}

// Extract "HH:MM" from an ISO datetime string
function isoToHHMM(iso) {
  if (!iso) return null;
  const m = iso.match(/T(\d{2}:\d{2})/);
  return m ? m[1] : null;
}

// Format seconds as "Xh Ym"
function fmtSec(s) {
  if (!s) return null;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ''}` : `${m}m`;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });

  const CK = process.env.GARMIN_CONSUMER_KEY;
  const CS = process.env.GARMIN_CONSUMER_SECRET;
  if (!CK || !CS) return res.status(503).json({ error: 'GARMIN_NOT_CONFIGURED' });

  const { accessToken, accessTokenSecret, days = 14 } = req.body || {};
  if (!accessToken || !accessTokenSecret) {
    return res.status(400).json({ error: 'Missing accessToken or accessTokenSecret' });
  }

  const clampedDays = Math.min(Math.max(Number(days) || 14, 1), 30);
  const nowSec      = Math.floor(Date.now() / 1000);
  const startSec    = nowSec - clampedDays * 86400;

  const baseUrl = 'https://healthapi.garmin.com/wellness-api/rest/sleep';
  const fullUrl = `${baseUrl}?uploadStartTimeInSeconds=${startSec}&uploadEndTimeInSeconds=${nowSec}`;

  // OAuth 1.0a signature must be over the base URL (without query params)
  const header = oauthHeader('GET', baseUrl, CK, CS, accessToken, accessTokenSecret);

  try {
    const garminRes = await fetch(fullUrl, { headers: { Authorization: header } });

    if (garminRes.status === 401) {
      return res.status(401).json({ error: 'GARMIN_UNAUTHORIZED', message: 'Token expired or revoked — reconnect Garmin.' });
    }
    if (!garminRes.ok) {
      const txt = await garminRes.text();
      throw new Error(`Garmin API ${garminRes.status}: ${txt.slice(0, 200)}`);
    }

    const data = await garminRes.json();
    const sleeps = data.sleeps || [];

    const entries = sleeps
      .filter(s => s.calendarDate && s.durationInSeconds > 0)
      .map(s => {
        const score     = s.sleepScores?.overall?.value ?? null;
        const deepS     = s.deepSleepDurationInSeconds  ?? 0;
        const lightS    = s.lightSleepDurationInSeconds ?? 0;
        const remS      = s.remSleepInSeconds           ?? 0;
        const awakeS    = s.awakeDurationInSeconds      ?? 0;
        const totalMins = Math.round(s.durationInSeconds / 60);
        const bed       = isoToHHMM(s.startTimeLocal);
        const wake      = isoToHHMM(s.endTimeLocal);

        // Build a rich notes string
        const noteParts = [];
        if (score)  noteParts.push(`Score ${score}/100`);
        if (deepS)  noteParts.push(`Deep ${fmtSec(deepS)}`);
        if (remS)   noteParts.push(`REM ${fmtSec(remS)}`);
        if (awakeS) noteParts.push(`Awake ${fmtSec(awakeS)}`);
        if (s.averageSpO2Value)     noteParts.push(`SpO₂ ${s.averageSpO2Value}%`);
        if (s.averageRespirationValue) noteParts.push(`Resp ${s.averageRespirationValue.toFixed(1)}`);

        return {
          date:        s.calendarDate,            // "YYYY-MM-DD"
          bed:         bed  ?? '22:00',
          wake:        wake ?? '06:00',
          mins:        totalMins,
          quality:     scoreToQuality(score),
          notes:       noteParts.join(' · ') || 'Synced from Garmin',
          source:      'garmin',
          garminScore: score,
          deepMins:    Math.round(deepS  / 60),
          remMins:     Math.round(remS   / 60),
          lightMins:   Math.round(lightS / 60),
          awakeMins:   Math.round(awakeS / 60),
        };
      })
      // Sort newest first
      .sort((a, b) => b.date.localeCompare(a.date));

    return res.json({ success: true, sleep: entries, synced: new Date().toISOString() });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
