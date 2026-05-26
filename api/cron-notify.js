// api/cron-notify.js — T-Minus background notification cron
// Runs every minute via Vercel cron (set in vercel.json)
//
// Vercel environment variables needed:
//   FCM_SERVER_KEY   — Firebase Console → Project Settings → Cloud Messaging → Server key
//   FIREBASE_API_KEY — Firebase Console → Project Settings → General → Web API Key

const DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

function getField(fields, name) {
  const f = fields?.[name];
  if (!f) return null;
  if (f._json?.booleanValue === true && f.v?.stringValue) {
    try { return JSON.parse(f.v.stringValue); } catch {}
  }
  if (f.v?.booleanValue  !== undefined) return f.v.booleanValue;
  if (f.v?.stringValue   !== undefined) return f.v.stringValue;
  if (f.v?.integerValue  !== undefined) return parseInt(f.v.integerValue);
  if (f.v?.doubleValue   !== undefined) return f.v.doubleValue;
  // Direct fields (non-nested)
  if (f.booleanValue  !== undefined) return f.booleanValue;
  if (f.stringValue   !== undefined) return f.stringValue;
  if (f.integerValue  !== undefined) return parseInt(f.integerValue);
  return null;
}

async function sendFCM(fcmKey, token, title, body, tag) {
  const resp = await fetch('https://fcm.googleapis.com/fcm/send', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': 'key=' + fcmKey,
    },
    body: JSON.stringify({
      to: token,
      data: { title, body, tag },
      android: { priority: 'high' },
      webpush: {
        headers: { Urgency: 'high' },
        notification: {
          title, body, tag,
          icon:     '/favicon.ico',
          badge:    '/favicon.ico',
          renotify: true,
        },
      },
    }),
  });
  return resp.ok;
}

export default async function handler(req, res) {
  const FCM_KEY = process.env.FCM_SERVER_KEY;
  const API_KEY = process.env.FIREBASE_API_KEY;
  if (!FCM_KEY || !API_KEY) {
    return res.status(500).json({ error: 'Missing env vars: FCM_SERVER_KEY and/or FIREBASE_API_KEY' });
  }

  const BASE = `https://firestore.googleapis.com/v1/projects/t-minus-29098/databases/(default)/documents`;
  const now  = new Date();
  const utcMins = now.getUTCHours() * 60 + now.getUTCMinutes();

  let sent = 0, skipped = 0;

  try {
    // List all users
    const usersRes = await fetch(`${BASE}/users?key=${API_KEY}`);
    if (!usersRes.ok) return res.status(500).json({ error: 'Firestore list users failed: ' + usersRes.status });
    const { documents = [] } = await usersRes.json();

    for (const userDoc of documents) {
      try {
        const userId = userDoc.name.split('/').pop();

        // Batch-fetch the keys we need
        const fields = {};
        const keys = ['fcmToken','tzOffset','bedOn','bedTime','wakeOn','wakeTime','wOn','wInt','vitSched','prog'];
        await Promise.all(keys.map(async k => {
          const r = await fetch(`${BASE}/users/${userId}/data/${k}?key=${API_KEY}`);
          if (r.ok) {
            const d = await r.json();
            fields[k] = d.fields;
          }
        }));

        const fcmToken = getField(fields.fcmToken, 'v') || (fields.fcmToken?.v?.stringValue);
        if (!fcmToken) { skipped++; continue; }

        // Get user's timezone offset (minutes from UTC, e.g. +180 for UTC+3)
        const tzOffset = getField(fields.tzOffset, 'v') ?? 0;
        const localMins = ((utcMins + tzOffset) % 1440 + 1440) % 1440;
        const lh = Math.floor(localMins / 60).toString().padStart(2,'0');
        const lm = (localMins % 60).toString().padStart(2,'0');
        const localHM  = `${lh}:${lm}`;
        const localDay = DAYS[new Date(now.getTime() + tzOffset * 60000).getUTCDay()];

        const notifs = [];

        // Bedtime
        if (getField(fields.bedOn,'v') === true && getField(fields.bedTime,'v') === localHM)
          notifs.push({ title:'😴 Bedtime', body:'Wind down — sleep is your best recovery.', tag:'bed' });

        // Wake-up
        if (getField(fields.wakeOn,'v') === true && getField(fields.wakeTime,'v') === localHM)
          notifs.push({ title:'☀️ Good morning', body:'Drink a big glass of water first!', tag:'wake' });

        // Water reminder
        const wOn  = getField(fields.wOn, 'v') === true;
        const wInt = getField(fields.wInt,'v') || 45;
        if (wOn) {
          const anchor = 7 * 60; // 07:00 local
          if (localMins >= anchor && (localMins - anchor) % wInt === 0)
            notifs.push({ title:'💧 Drink water', body:'Stay hydrated — have a glass now!', tag:'water' });
        }

        // Vitamin reminders
        const vitSched = getField(fields.vitSched,'v');
        if (vitSched?.items) {
          vitSched.items.forEach((v,i) => {
            if (v.time === localHM)
              notifs.push({ title:'💊 '+v.name, body:v.why||v.lbl||'Time for your supplement', tag:'vit'+i });
          });
        }

        // Training sessions
        const prog = getField(fields.prog,'v');
        if (prog && typeof prog === 'object') {
          Object.values(prog).flat().forEach(s => {
            if (!s?.done && s?.d === localDay && s?.time === localHM)
              notifs.push({ title:'🏃 '+s.title, body:s.min+'min session', tag:'s'+s.id });
          });
        }

        // Send
        for (const n of notifs) {
          const ok = await sendFCM(FCM_KEY, fcmToken, n.title, n.body, n.tag);
          if (ok) sent++; else skipped++;
        }
      } catch(e) {
        console.error('User error:', e.message);
        skipped++;
      }
    }

    return res.status(200).json({
      ok: true,
      utcTime: `${now.getUTCHours().toString().padStart(2,'0')}:${now.getUTCMinutes().toString().padStart(2,'0')}`,
      users: documents.length, sent, skipped
    });
  } catch(e) {
    console.error('Cron error:', e);
    return res.status(500).json({ error: e.message });
  }
}
