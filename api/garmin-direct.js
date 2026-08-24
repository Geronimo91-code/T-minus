// api/garmin-direct.js
// Pushes structured workouts directly into Garmin Connect.
// Uses the unofficial garmin-connect npm package (add to package.json).
//
// POST body actions:
//   { action: "login",   username, password }
//     → { success, session, displayName }
//
//   { action: "push",    session, workouts: [ { sessId, wk, title, type, min, notes, gym, date } ] }
//     → { success, results: [ { sessId, workoutId, scheduled, success } ], session }
//
//   { action: "delete",  session, workoutId }
//     → { success }
//
// "session" is opaque JSON returned by login — store in Firestore, pass on every push.
// Never store the user's password.
//
// Setup: npm install garmin-connect (add to your package.json)

module.exports.config = { maxDuration: 30 }; // Vercel timeout override

let GarminConnect;
try {
  ({ GarminConnect } = require('garmin-connect'));
} catch (e) {
  GarminConnect = null;
}

// ── Sport type lookup ──────────────────────────────────────
const SPORT_TYPES = {
  conditioning: { sportTypeId: 1,  sportTypeKey: 'running'           },
  skills:       { sportTypeId: 4,  sportTypeKey: 'other'             },
  gym:          { sportTypeId: 5,  sportTypeKey: 'strength_training' },
  recovery:     { sportTypeId: 4,  sportTypeKey: 'other'             },
  other:        { sportTypeId: 4,  sportTypeKey: 'other'             },
};

// Format seconds as "HH:MM:SS" for Garmin step endConditionValue
function fmtHMS(sec) {
  const h = Math.floor(sec / 3600).toString().padStart(2, '0');
  const m = Math.floor((sec % 3600) / 60).toString().padStart(2, '0');
  const s = (sec % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

// Build a Garmin Connect workout payload from our session object
function buildWorkout(sess) {
  const sport   = SPORT_TYPES[sess.type] || SPORT_TYPES.other;
  const totalSec = (sess.min || 60) * 60;
  const wuSec    = Math.min(600, Math.round(totalSec * 0.15));
  const cdSec    = Math.min(600, Math.round(totalSec * 0.15));
  const mainSec  = totalSec - wuSec - cdSec;

  const step = (order, typeId, typeKey, sec, desc) => ({
    stepOrder:   order,
    stepType:    { stepTypeId: typeId, stepTypeKey: typeKey },
    endCondition: { conditionTypeId: 2, conditionTypeKey: 'time' },
    endConditionValue: fmtHMS(sec),
    targetType:  { workoutTargetTypeId: 1, workoutTargetTypeKey: 'no.target' },
    targetValueOne: null,
    targetValueTwo: null,
    description: desc || null,
  });

  return {
    workoutId:   null,
    ownerId:     null,
    workoutName: `${sess.title} — Wk${sess.wk} ${sess.d || ''}`.trim(),
    description: sess.notes
      ? `${sess.notes}\n\nT-Minus · Week ${sess.wk} · ${sess.min} min`
      : `${sess.min} min ${sess.type} · T-Minus Week ${sess.wk}`,
    sportType:          sport,
    trainingPlanId:     null,
    estimatedDurationInSecs: totalSec,
    workoutSegments: [{
      segmentOrder: 1,
      sportType:    sport,
      workoutSteps: [
        step(1, 1, 'warmup',   wuSec,   'Warm-up'),
        step(2, 3, 'interval', mainSec, sess.title),
        step(3, 2, 'cooldown', cdSec,   'Cool-down'),
      ],
    }],
  };
}

// Extract the session JSON from a GarminConnect client (version-safe)
function exportSession(gc) {
  const raw = gc.client?.sessionJson
           ?? gc.sessionJson
           ?? gc._client?.sessionJson
           ?? null;
  return raw ? JSON.stringify(raw) : null;
}

// Restore a GarminConnect client from a stored session string
function restoreSession(gc, sessionStr) {
  try {
    const parsed = typeof sessionStr === 'string' ? JSON.parse(sessionStr) : sessionStr;
    if (gc.client)         gc.client.sessionJson = parsed;
    else if (gc._client)   gc._client.sessionJson = parsed;
    else                   gc.sessionJson = parsed;
    return true;
  } catch {
    return false;
  }
}

// ── Main handler ───────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });

  if (!GarminConnect) {
    return res.status(503).json({
      error: 'PACKAGE_MISSING',
      message: 'Add "garmin-connect": "^2.0.0" to your package.json and redeploy.',
    });
  }

  const { action, username, password, session: sessionStr, workouts, workoutId } = req.body || {};

  // ── LOGIN ────────────────────────────────────────────────
  if (action === 'login') {
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password required' });
    }
    try {
      const gc = new GarminConnect({ username, password });
      await gc.login(username, password);

      let displayName = username;
      try {
        const profile = await gc.getUserProfile?.();
        displayName = profile?.displayName || profile?.fullName || username;
      } catch { /* profile fetch is optional */ }

      const session = exportSession(gc);
      return res.json({ success: true, session, displayName });
    } catch (e) {
      const msg = e.message || '';
      if (/invalid.*credential|password|username/i.test(msg)) {
        return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'Wrong username or password.' });
      }
      return res.status(401).json({ error: 'LOGIN_FAILED', message: msg });
    }
  }

  // ── PUSH WORKOUTS ────────────────────────────────────────
  if (action === 'push') {
    if (!sessionStr) return res.status(400).json({ error: 'session required — login first' });
    if (!workouts?.length) return res.status(400).json({ error: 'workouts array required' });

    const gc = new GarminConnect({});
    const restored = restoreSession(gc, sessionStr);
    if (!restored) return res.status(401).json({ error: 'SESSION_EXPIRED' });

    // Verify session is still valid with a lightweight call
    try {
      await gc.getUserProfile?.();
    } catch {
      return res.status(401).json({ error: 'SESSION_EXPIRED', message: 'Session expired — re-authenticate.' });
    }

    const results = [];
    for (const w of workouts) {
      try {
        const payload = buildWorkout(w);
        // garmin-connect 1.6.x has no createWorkout(). Post the raw payload
        // through whichever authenticated path the installed version exposes.
        let created = null;
        if (typeof gc.createWorkout === 'function') {
          created = await gc.createWorkout(payload);
        } else if (gc.client && typeof gc.client.post === 'function') {
          created = await gc.client.post('/workout-service/workout', payload);
        } else if (typeof gc.addWorkout === 'function') {
          created = await gc.addWorkout(payload);
        } else {
          throw new Error('No workout-create method in installed garmin-connect');
        }
        const workoutIdCreated = created?.workoutId ?? created?.id ?? created?.data?.workoutId ?? null;

        let scheduled = false;
        if (workoutIdCreated && w.date) {
          try {
            if (typeof gc.scheduleWorkout === 'function') {
              await gc.scheduleWorkout(workoutIdCreated, w.date);
            } else if (gc.client && typeof gc.client.post === 'function') {
              await gc.client.post(`/workout-service/schedule/${workoutIdCreated}`, { date: w.date });
            }
            scheduled = true;
          } catch { /* scheduling optional — workout still saved to library */ }
        }

        results.push({ sessId: w.sessId, workoutId: workoutIdCreated, scheduled, success: !!workoutIdCreated });
      } catch (e) {
        results.push({ sessId: w.sessId, success: false, error: e.message });
      }
    }

    const updatedSession = exportSession(gc) || sessionStr; // keep old if export fails
    return res.json({ success: true, results, session: updatedSession });
  }

  // ── DELETE WORKOUT ───────────────────────────────────────
  if (action === 'delete') {
    if (!sessionStr) return res.status(400).json({ error: 'session required' });
    if (!workoutId)  return res.status(400).json({ error: 'workoutId required' });

    const gc = new GarminConnect({});
    restoreSession(gc, sessionStr);

    try {
      await gc.deleteWorkout?.({ workoutId }) ?? await gc.deleteWorkout?.(workoutId);
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: `Unknown action: ${action}` });
};
