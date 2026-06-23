// api/garmin-calendar.js
// Serves a user's T-Minus training plan as an iCal (.ics) feed.
//
// GET  ?uid=USER_KEY  → Content-Type: text/calendar (.ics)
//
// The user subscribes to this URL ONCE in Garmin Connect:
//   Garmin Connect → Calendar → My Calendars → Subscribe → paste URL
//
// Training sessions appear as calendar events and auto-sync to the watch.
// No API credentials needed — just a unique URL per user.
//
// Data source: Firestore document  tminus_data/{uid}/prog  (the training plan)

const admin = require('firebase-admin');

// Lazy-init Firebase Admin SDK
let db;
function getDB() {
  if (db) return db;
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:    process.env.FIREBASE_PROJECT_ID,
        clientEmail:  process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:   (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      }),
    });
  }
  db = admin.firestore();
  return db;
}

// Escape iCal text (RFC 5545)
function icsEsc(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

// Fold long iCal lines at 75 chars
function fold(line) {
  const chunks = [];
  while (line.length > 75) {
    chunks.push(line.slice(0, 75));
    line = ' ' + line.slice(75);
  }
  chunks.push(line);
  return chunks.join('\r\n');
}

// Format a Date as iCal DATE: YYYYMMDD
function icsDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// Format a Date as iCal DATETIME: YYYYMMDDTHHmmss
function icsDateTime(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// Stable UID for an event: based on user key + session id
function eventUID(uid, sessId) {
  return `tminus-${uid}-${sessId}@t-minus.app`;
}

const DAYS_IDX = { Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6, Sun:0 };

const TYPE_LABEL = {
  conditioning: 'Conditioning',
  skills:       'Skills',
  gym:          'Strength',
  recovery:     'Recovery',
  rest:         'Rest',
};

module.exports = async (req, res) => {
  const uid = req.query.uid;
  if (!uid) {
    return res.status(400).send('Missing ?uid= parameter');
  }

  // Fetch the training plan from Firestore
  let prog = {};
  let eventName = 'T-Minus Training';
  let eventDate = null;
  let programStart = null;
  let totalWk = 13;

  try {
    const firestore = getDB();
    const snap = await firestore
      .collection('tminus_data')
      .doc(uid)
      .collection('kv')
      .get();

    snap.forEach(doc => {
      const { key, value } = doc.data();
      try {
        if (key === 'prog')         prog         = JSON.parse(value);
        if (key === 'eventName')    eventName    = JSON.parse(value);
        if (key === 'eventDate')    eventDate    = JSON.parse(value);
        if (key === 'programStart') programStart = JSON.parse(value);
        if (key === 'totalWk')      totalWk      = JSON.parse(value);
      } catch { /* skip malformed values */ }
    });
  } catch (e) {
    // If Firestore fails, return empty but valid calendar
    console.error('Calendar Firestore error:', e.message);
  }

  // Compute the date of a session (day within a specific week)
  const startDate = programStart ? new Date(programStart) : (() => {
    if (eventDate) {
      const d = new Date(eventDate);
      d.setDate(d.getDate() - totalWk * 7);
      return d;
    }
    return new Date();
  })();

  const events = [];
  const now = new Date();

  for (const [wkStr, sessions] of Object.entries(prog)) {
    const wk = parseInt(wkStr, 10);
    if (!Array.isArray(sessions)) continue;

    for (const s of sessions) {
      if (!s || s.type === 'rest') continue;

      // Compute the actual date of this session
      const dayIdx = DAYS_IDX[s.d];
      if (dayIdx === undefined) continue;

      const wkStart = new Date(startDate);
      wkStart.setDate(wkStart.getDate() + (wk - 1) * 7);
      // Align to Monday of this week
      const monday = new Date(wkStart);
      monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
      // Add days to reach the target day
      const sessionDate = new Date(monday);
      sessionDate.setDate(monday.getDate() + dayIdx);

      // Start time: parse s.time (HH:MM) or default to 07:00
      const [sh, sm] = (s.time && /^\d{2}:\d{2}$/.test(s.time))
        ? s.time.split(':').map(Number)
        : [7, 0];
      const dtStart = new Date(sessionDate);
      dtStart.setHours(sh, sm, 0, 0);
      const dtEnd = new Date(dtStart);
      dtEnd.setMinutes(dtEnd.getMinutes() + (s.min || 60));

      const typeLabel = TYPE_LABEL[s.type] || s.type || '';
      const summary   = `${s.title || typeLabel} — Wk${wk} T-Minus`;
      const desc      = [
        s.notes     ? s.notes                     : null,
        s.intensity ? `Intensity: ${s.intensity}` : null,
        `Duration: ${s.min || 60} min`,
        `Type: ${typeLabel}`,
        s.gym       ? 'Gym required'              : null,
        `Week ${wk} of ${totalWk} · ${eventName}`,
      ].filter(Boolean).join('\\n');

      events.push([
        'BEGIN:VEVENT',
        fold(`UID:${eventUID(uid, s.id || `${wk}-${s.d}-${s.title}`)}`),
        fold(`DTSTAMP:${icsDateTime(now)}`),
        fold(`DTSTART:${icsDateTime(dtStart)}`),
        fold(`DTEND:${icsDateTime(dtEnd)}`),
        fold(`SUMMARY:${icsEsc(summary)}`),
        fold(`DESCRIPTION:${icsEsc(desc)}`),
        fold(`CATEGORIES:${icsEsc(typeLabel)}`),
        s.done ? 'STATUS:COMPLETED' : 'STATUS:CONFIRMED',
        // Reminder: notify 30 minutes before the session
        ...(s.done ? [] : [
          'BEGIN:VALARM',
          'ACTION:DISPLAY',
          fold(`DESCRIPTION:${icsEsc(summary)}`),
          'TRIGGER:-PT30M',
          'END:VALARM',
        ]),
        'END:VEVENT',
      ].join('\r\n'));
    }
  }

  // Assemble the .ics file
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//T-Minus//Training Plan//EN`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    fold(`X-WR-CALNAME:${icsEsc(eventName)} · T-Minus`),
    `X-WR-TIMEZONE:UTC`,
    `REFRESH-INTERVAL;VALUE=DURATION:PT6H`,
    `X-PUBLISHED-TTL:PT6H`,
    ...events,
    'END:VCALENDAR',
  ].join('\r\n');

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="tminus-training.ics"`);
  res.setHeader('Cache-Control', 'no-cache, no-store');
  return res.status(200).send(ics);
};
