// Minimal, single-user "AI brain" for your smart bottle.
// Receives {ml, pct, cm} from ESP32/Blynk, and if you're behind schedule,
// sends a Telegram message saying WHEN and HOW MUCH (ml) to drink.
//
// Configure everything via Vercel Environment Variables (see step 3).

// ---------- Helpers ----------
const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
const TG = (token, method, body) =>
  fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

// In-memory rate limiter (resets on cold start; OK for prototype)
const lastNotified = new Map();

// ---------- Config (from env) ----------
function getConfig() {
  // REQUIRED
  const BOT_TOKEN = process.env.BOT_TOKEN;    // Telegram bot token
  const CHAT_ID   = process.env.CHAT_ID;      // Your chat id
  const NAME      = process.env.NAME || 'friend';
  const WEIGHT_KG = Number(process.env.WEIGHT_KG || 70);

  // Optional profile
  const ACTIVITY_LEVEL = (process.env.ACTIVITY_LEVEL || 'Moderate'); // Sedentary/Light/Moderate/Heavy
  const DAILY_ACTIVITY_MINUTES = Number(process.env.DAILY_ACTIVITY_MINUTES || 60);
  const WAKE_TIME  = process.env.WAKE_TIME  || '07:00';
  const SLEEP_TIME = process.env.SLEEP_TIME || '23:00';

  // Behavior
  const QUIET_START = Number(process.env.QUIET_START_HOUR || 23); // 0-23
  const QUIET_END   = Number(process.env.QUIET_END_HOUR   || 7);  // 0-23
  const MIN_INTERVAL_MIN = Number(process.env.MIN_INTERVAL_MIN || 30); // rate limit

  return {
    BOT_TOKEN, CHAT_ID, NAME, WEIGHT_KG, ACTIVITY_LEVEL, DAILY_ACTIVITY_MINUTES,
    WAKE_TIME, SLEEP_TIME, QUIET_START, QUIET_END, MIN_INTERVAL_MIN
  };
}

// ---------- Core logic ----------
function parseHM(s, defH=7, defM=0) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
  const now = new Date();
  if (!m) { const d=new Date(now); d.setHours(defH,defM,0,0); return d; }
  const h = clamp(Number(m[1]), 0, 23);
  const mm = clamp(Number(m[2]), 0, 59);
  const d = new Date(now); d.setHours(h, mm, 0, 0); return d;
}

function computeGoalMl(weight_kg, activity_level, daily_minutes) {
  // Baseline
  let goal = Math.round(35 * weight_kg);
  // Activity add-on per 30 min
  const blocks = Math.max(0, Math.round(daily_minutes / 30));
  const addPer = { Sedentary: 0, Light: 200, Moderate: 400, Heavy: 600 }[activity_level] ?? 200;
  goal += blocks * addPer;
  // Safe general rails
  goal = clamp(goal, 1200, 4000);
  return goal;
}

function makeSchedule(activity_level, wakeStr, sleepStr) {
  // Distribute goal by day part (heavier midday for more active days)
  const morning  = (activity_level==='Heavy') ? 0.25 : (activity_level==='Moderate') ? 0.30 : 0.35;
  const afternoon= (activity_level==='Heavy') ? 0.55 : (activity_level==='Moderate') ? 0.50 : 0.45;
  const evening  = 1 - (morning + afternoon);

  const wake  = parseHM(wakeStr, 7, 0);
  const sleep = parseHM(sleepStr, 23, 0);
  const durMs = Math.max(1, sleep - wake);
  const tMorningEnd   = new Date(wake.getTime() + durMs * 0.33);
  const tAfternoonEnd = new Date(wake.getTime() + durMs * 0.80);

  function fractionAt(now = new Date()) {
    if (now <= wake) return 0;
    if (now >= sleep) return 1;
    if (now <= tMorningEnd) {
      const f = (now - wake) / (tMorningEnd - wake);
      return f * morning;
    }
    if (now <= tAfternoonEnd) {
      const f = (now - tMorningEnd) / (tAfternoonEnd - tMorningEnd);
      return morning + f * afternoon;
    }
    const f = (now - tAfternoonEnd) / (sleep - tAfternoonEnd);
    return morning + afternoon + f * evening;
  }

  return { fractionAt };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const cfg = getConfig();
    if (!cfg.BOT_TOKEN || !cfg.CHAT_ID) {
      return res.status(500).json({ error: 'Missing BOT_TOKEN or CHAT_ID env vars' });
    }

    // Read payload from ESP32
    const body = typeof req.body === 'object' && req.body ? req.body
                 : JSON.parse(await streamToString(req));
    const { ml, pct, cm } = body || {};
    if (ml == null || pct == null) {
      return res.status(400).json({ error: 'missing ml/pct in JSON body' });
    }

    // Quiet hours
    const now = new Date();
    const hour = now.getHours();
    if (hour >= cfg.QUIET_START || hour < cfg.QUIET_END) {
      return res.json({ ok: true, skipped: 'quiet_hours' });
    }

    // Compute goal and target-by-now
    const goal_ml = computeGoalMl(cfg.WEIGHT_KG, cfg.ACTIVITY_LEVEL, cfg.DAILY_ACTIVITY_MINUTES);
    const sched = makeSchedule(cfg.ACTIVITY_LEVEL, cfg.WAKE_TIME, cfg.SLEEP_TIME);
    const target_ml_now = Math.round(goal_ml * sched.fractionAt(now));
    const remaining_ml  = Math.max(0, goal_ml - ml);

    // Rate limit (per chat)
    const last = lastNotified.get(cfg.CHAT_ID) || 0;
    if (Date.now() - last < cfg.MIN_INTERVAL_MIN * 60 * 1000) {
      return res.json({ ok: true, skipped: 'interval' });
    }

    // Decide whether to notify
    const behind = ml + 50 < target_ml_now;  // some tolerance
    const veryLow = pct < 40;

    if (!(behind || veryLow) || remaining_ml <= 0) {
      return res.json({ ok: true, skipped: 'on_track_or_done', goal_ml, target_ml_now });
    }

    // Suggest a safe next sip (ml), scaled by activity/gap
    const gap = Math.max(0, target_ml_now - ml);
    const baseMin = (cfg.ACTIVITY_LEVEL === 'Heavy') ? 200 : (cfg.ACTIVITY_LEVEL === 'Moderate') ? 180 : 150;
    const baseMax = (cfg.ACTIVITY_LEVEL === 'Heavy') ? 300 : (cfg.ACTIVITY_LEVEL === 'Moderate') ? 250 : 220;
    const next_sip_ml = clamp(Math.round(gap / 3), baseMin, baseMax);

    // Build message
    let text = `💧 Hey ${cfg.NAME}! You’re behind ${target_ml_now - ml} ml (pace ${ml}/${goal_ml} ml). Drink ~${next_sip_ml} ml now. Remaining: ${remaining_ml} ml.`;

    // Optional AI rephrase
    if (process.env.OPENAI_API_KEY) {
      try {
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
              { role: 'system', content: 'Write short, friendly hydration nudges under 160 characters.' },
              { role: 'user', content: text }
            ]
          })
        }).then(r => r.json());
        const ai = r?.choices?.[0]?.message?.content?.trim();
        if (ai) text = ai;
      } catch (_) {}
    }

    // Send Telegram
    await TG(cfg.BOT_TOKEN, 'sendMessage', { chat_id: cfg.CHAT_ID, text });

    lastNotified.set(cfg.CHAT_ID, Date.now());
    res.json({ ok: true, notified: true, goal_ml, target_ml_now, next_sip_ml });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error', detail: String(e) });
  }
}

// Read request body if not auto-parsed
async function streamToString(req) {
  return await new Promise((resolve, reject) => {
    let d = ''; req.on('data', c => d += c);
    req.on('end', () => resolve(d)); req.on('error', reject);
  });
}
