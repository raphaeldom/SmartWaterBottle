// api/ingest.js
// AI-driven hydration planner: uses OpenAI (gpt-4o-mini) to decide WHEN to notify
// and HOW MUCH (ml). Falls back to rule-based if AI is unavailable.
// Requires env vars (see steps below).

const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

const TG = (token, method, body) =>
  fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

// in-memory rate limit (OK for prototype)
const lastNotified = new Map();

function getConfig() {
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const CHAT_ID   = process.env.CHAT_ID;

  // --- Profile (adjust in Vercel env) ---
  const NAME      = process.env.NAME || 'friend';
  const AGE       = Number(process.env.AGE || 22);
  const WEIGHT_KG = Number(process.env.WEIGHT_KG || 70);
  const HEIGHT_CM = Number(process.env.HEIGHT_CM || 170);

  // Day-by-day activity plan (free text or Sedentary/Light/Moderate/Heavy)
  const ACT_MON = process.env.ACTIVITY_MON || 'Moderate';
  const ACT_TUE = process.env.ACTIVITY_TUE || 'Moderate';
  const ACT_WED = process.env.ACTIVITY_WED || 'Moderate';
  const ACT_THU = process.env.ACTIVITY_THU || 'Moderate';
  const ACT_FRI = process.env.ACTIVITY_FRI || 'Moderate';
  const ACT_SAT = process.env.ACTIVITY_SAT || 'Light';
  const ACT_SUN = process.env.ACTIVITY_SUN || 'Light';

  const WAKE_TIME  = process.env.WAKE_TIME  || '07:00';
  const SLEEP_TIME = process.env.SLEEP_TIME || '23:00';

  // Behavior / safety
  const QUIET_START = Number(process.env.QUIET_START_HOUR || 23); // UTC hours!
  const QUIET_END   = Number(process.env.QUIET_END_HOUR   || 7);
  const MIN_INTERVAL_MIN = Number(process.env.MIN_INTERVAL_MIN || 30);

  // Optional medical cap (if you ever need it)
  const CLINICIAN_LIMIT_ML = process.env.CLINICIAN_LIMIT_ML != null
    ? Number(process.env.CLINICIAN_LIMIT_ML)
    : null;

  return {
    BOT_TOKEN, CHAT_ID,
    NAME, AGE, WEIGHT_KG, HEIGHT_CM,
    ACT_MON, ACT_TUE, ACT_WED, ACT_THU, ACT_FRI, ACT_SAT, ACT_SUN,
    WAKE_TIME, SLEEP_TIME,
    QUIET_START, QUIET_END, MIN_INTERVAL_MIN,
    CLINICIAN_LIMIT_ML
  };
}

// ---------- Rule fallback (if AI fails) ----------
function fallbackPlan({ weight_kg, activity }, mlNow, pctNow, now) {
  // simple daily goal
  let goal = Math.round(35 * weight_kg);
  goal += { Sedentary:0, Light:400, Moderate:800, Heavy:1200 }[activity] ?? 400;
  goal = clamp(goal, 1200, 4000);

  // simple schedule: morning 35%, afternoon 45%, evening 20%
  const wake = parseHM('07:00'), sleep = parseHM('23:00');
  const dur = Math.max(1, sleep - wake);
  const t1 = new Date(wake.getTime() + dur * 0.33);
  const t2 = new Date(wake.getTime() + dur * 0.80);
  const frac = (d => {
    if (d <= wake) return 0;
    if (d >= sleep) return 1;
    if (d <= t1) { const f=(d-wake)/(t1-wake); return f*0.35; }
    if (d <= t2) { const f=(d-t1)/(t2-t1); return 0.35 + f*0.45; }
    const f=(d-t2)/(sleep-t2); return 0.35+0.45+f*0.20;
  })(now);

  const targetByNow = Math.round(goal * frac);
  const remaining = Math.max(0, goal - mlNow);
  const behind = mlNow + 50 < targetByNow;
  const veryLow = pctNow < 40;
  const shouldNotify = (behind || veryLow) && remaining > 0;

  // safe sip size
  const gap = Math.max(0, targetByNow - mlNow);
  const next_sip_ml = clamp(Math.round(gap/3), 150, 250);

  return { goal_ml: goal, target_ml_now: targetByNow, remaining_ml: remaining, next_sip_ml, should_notify: shouldNotify, reason: 'fallback' };
}

function parseHM(s, defH=7, defM=0){
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
  const now = new Date();
  if (!m) { const d=new Date(now); d.setHours(defH,defM,0,0); return d; }
  const h = clamp(Number(m[1]), 0, 23);
  const mm= clamp(Number(m[2]), 0, 59);
  const d = new Date(now); d.setHours(h, mm, 0, 0); return d;
}

// ---------- AI planner ----------
async function aiPlan(openaiKey, ctx, reading) {
  const url = 'https://api.openai.com/v1/chat/completions';
  const body = {
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
`You are a cautious hydration planner. Given a user profile, local time window (wake/sleep),
and the current reading (ml, %), decide:
1) daily_goal_ml,
2) target_ml_by_now (how much should have been consumed by the current time),
3) should_notify (boolean),
4) next_sip_ml (safe 120–300 ml),
5) short_reason (one sentence).

Constraints:
- Baseline goal ≈ 30–40 ml/kg; adjust with activity (Sedentary/Light/Moderate/Heavy ≈ +0/400/800/1200 ml).
- Respect clinician_limit_ml if provided (cap the goal).
- Absolute rails: min 1200 ml/day, max 4000 ml/day (unless clinician limit lower).
- next_sip_ml between 120 and 300 ml, never huge gulps.
- Notify only if low % (<40) or behind target-by-now, and there is remaining ml.
- Prefer even pacing between wake_time and sleep_time.
- Return ONLY JSON with keys: daily_goal_ml, target_ml_by_now, should_notify, next_sip_ml, short_reason.`
      },
      {
        role: 'user',
        content: JSON.stringify({
          profile: ctx,
          reading,
          now_iso: new Date().toISOString()
        })
      }
    ]
  };

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(r => r.json());

  const txt = r?.choices?.[0]?.message?.content;
  if (!txt) throw new Error('no_ai_output');

  const data = JSON.parse(txt);
  // sanitize
  const goal = clamp(Math.round(Number(data.daily_goal_ml || 0)), 800, 6000);
  const target = clamp(Math.round(Number(data.target_ml_by_now || 0)), 0, goal);
  const sip = clamp(Math.round(Number(data.next_sip_ml || 0)), 120, 300);
  const should = !!data.should_notify;
  const reason = String(data.short_reason || '').slice(0, 140);

  return { goal_ml: goal, target_ml_now: target, next_sip_ml: sip, should_notify: should, reason };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const cfg = getConfig();
    if (!cfg.BOT_TOKEN || !cfg.CHAT_ID) return res.status(500).json({ error: 'missing BOT_TOKEN/CHAT_ID' });

    // parse payload
    const body = typeof req.body === 'object' && req.body ? req.body
                : JSON.parse(await streamToString(req));
    const { ml, pct, cm } = body || {};
    if (ml == null || pct == null) return res.status(400).json({ error: 'missing ml/pct' });

    // quiet hours (UTC!)
    const now = new Date();
    const hour = now.getHours();
    if (hour >= cfg.QUIET_START || hour < cfg.QUIET_END) {
      return res.json({ ok: true, skipped: 'quiet_hours' });
    }

    // rate limit
    const last = lastNotified.get(cfg.CHAT_ID) || 0;
    if (Date.now() - last < (cfg.MIN_INTERVAL_MIN * 60 * 1000)) {
      return res.json({ ok: true, skipped: 'interval' });
    }

    // Build AI context
    const dow = new Date().getDay(); // 0=Sun..6=Sat
    const dayActivity = {
      1: cfg.ACT_MON, 2: cfg.ACT_TUE, 3: cfg.ACT_WED, 4: cfg.ACT_THU, 5: cfg.ACT_FRI, 6: cfg.ACT_SAT, 0: cfg.ACT_SUN
    }[dow] || 'Light';

    const ctx = {
      name: cfg.NAME,
      age: cfg.AGE,
      weight_kg: cfg.WEIGHT_KG,
      height_cm: cfg.HEIGHT_CM,
      wake_time: cfg.WAKE_TIME,
      sleep_time: cfg.SLEEP_TIME,
      today_activity: dayActivity,
      clinician_limit_ml: cfg.CLINICIAN_LIMIT_ML
    };

    const reading = { ml_now: ml, pct_now: pct, cm_now: cm };

    // AI planner (fallback if fails or no key)
    let plan;
    if (process.env.OPENAI_API_KEY) {
      try {
        plan = await aiPlan(process.env.OPENAI_API_KEY, ctx, reading);
      } catch (e) {
        // console.error('AI error, using fallback:', e);
        plan = fallbackPlan({ weight_kg: cfg.WEIGHT_KG, activity: normalizeActivity(dayActivity) }, ml, pct, now);
      }
    } else {
      plan = fallbackPlan({ weight_kg: cfg.WEIGHT_KG, activity: normalizeActivity(dayActivity) }, ml, pct, now);
    }

    const remaining_ml = Math.max(0, plan.goal_ml - ml);

    if (!plan.should_notify || remaining_ml <= 0) {
      return res.json({ ok: true, skipped: 'on_track_or_done', plan });
    }

    // Build message
    const behind = Math.max(0, plan.target_ml_now - ml);
    let text = `💧 Hey ${cfg.NAME}! ${plan.reason || 'Hydration check'} Behind ${behind} ml (pace ${ml}/${plan.goal_ml} ml). Drink ~${plan.next_sip_ml} ml now. Remaining: ${remaining_ml} ml.`;

    // Send Telegram
    await TG(cfg.BOT_TOKEN, 'sendMessage', { chat_id: cfg.CHAT_ID, text });

    lastNotified.set(cfg.CHAT_ID, Date.now());
    res.json({ ok: true, notified: true, plan });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error', detail: String(e) });
  }
}

function normalizeActivity(s=''){
  const t = String(s).toLowerCase();
  if (t.includes('heavy')) return 'Heavy';
  if (t.includes('moderate')) return 'Moderate';
  if (t.includes('sedentary')) return 'Sedentary';
  if (t.includes('light')) return 'Light';
  if (/run|gym|match|intense|cycle/.test(t)) return 'Heavy';
  if (/walk|jog|yoga|swim/.test(t)) return 'Moderate';
  return 'Light';
}

async function streamToString(req){
  return await new Promise((res, rej) => {
    let d=''; req.on('data', c => d += c);
    req.on('end', () => res(d));
    req.on('error', rej);
  });
}
