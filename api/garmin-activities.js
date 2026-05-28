// api/garmin-activities.js
// Pulls completed activity summaries from the Garmin Health API.
//
// POST body: { accessToken, accessTokenSecret, days? (default 14) }
// Returns:   { success: true, activities: [ ...entries ] }
//
// Each activity entry:
//   { activityId, name, sport, date, startTime, durationSec, durationMin,
//     distanceKm, avgHR, maxHR, paceMinKm, paceStr, calories, elevationM }
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

// Normalise the Garmin sport typeKey into our app's session type vocabulary
function mapSport(typeKey) {
  const k = (typeKey || '').toLowerCase();
  if (/running|treadmill|trail/.test(k))                   return 'conditioning';
  if (/cycling|bike|indoor_cycling/.test(k))               return 'conditioning';
  if (/swim/.test(k))                                      return 'conditioning';
  if (/strength|weight|crossfit|pilates|fitness_equip/.test(k)) return 'gym';
  if (/yoga|walk|hike|recovery/.test(k))                   return 'recovery';
  if (/team|basketball|football|soccer|rugby|frisbee/.test(k)) return 'skills';
  return 'other';
}

// Format pace as "M:SS /km"
function fmtPace(minPerKm) {
  if (!minPerKm || minPerKm <= 0) return null;
  const m = Math.floor(minPerKm);
  const s = Math.round((minPerKm - m) * 60);
  return `${m}:${s.toString().padStart(2, '0')} /km`;
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

  const baseUrl = 'https://healthapi.garmin.com/wellness-api/rest/activities';
  const fullUrl = `${baseUrl}?uploadStartTimeInSeconds=${startSec}&uploadEndTimeInSeconds=${nowSec}`;
  const header  = oauthHeader('GET', baseUrl, CK, CS, accessToken, accessTokenSecret);

  try {
    const garminRes = await fetch(fullUrl, { headers: { Authorization: header } });

    if (garminRes.status === 401) {
      return res.status(401).json({ error: 'GARMIN_UNAUTHORIZED', message: 'Token expired — reconnect Garmin.' });
    }
    if (!garminRes.ok) {
      const txt = await garminRes.text();
      throw new Error(`Garmin API ${garminRes.status}: ${txt.slice(0, 200)}`);
    }

    const data       = await garminRes.json();
    const rawActs    = data.activitySummaries || data.activities || [];

    const activities = rawActs.map(a => {
      const summary  = a.summary || a;
      const typeKey  = summary.activityType?.typeKey || summary.activityTypeKey || 'other';
      const sport    = mapSport(typeKey);
      const distM    = summary.distanceInMeters || 0;
      const distKm   = distM > 0 ? Math.round(distM / 100) / 10 : null;
      const durationSec = summary.durationInSeconds || 0;
      const pace     = summary.averagePaceInMinutesPerKilometer;

      // Extract YYYY-MM-DD from the local start time
      const startLocal = summary.startTimeLocal || summary.startTimeGmt || '';
      const date = startLocal.slice(0, 10) || new Date((summary.startTimeInSeconds || 0) * 1000)
                     .toISOString().slice(0, 10);

      return {
        activityId:  String(a.activityId || summary.activityId || ''),
        name:        summary.activityName || summary.name || typeKey,
        sport,
        garminSport: typeKey,
        date,                                          // "YYYY-MM-DD"
        startTime:   startLocal.slice(11, 16) || '',   // "HH:MM"
        durationSec,
        durationMin: Math.round(durationSec / 60),
        distanceKm,
        avgHR:       summary.averageHRInBeatsPerMinute  || null,
        maxHR:       summary.maxHRInBeatsPerMinute       || null,
        paceMinKm:   pace || null,
        paceStr:     fmtPace(pace),
        calories:    summary.activeKiloCalories || summary.calories || null,
        elevationM:  summary.totalElevationGainInMeters
                       ? Math.round(summary.totalElevationGainInMeters) : null,
      };
    }).filter(a => a.durationMin >= 5)  // filter out <5 min noise
      .sort((a, b) => b.date.localeCompare(a.date));

    return res.json({ success: true, activities, synced: new Date().toISOString() });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
