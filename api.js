// Serverless AI brain: receives {pct, ml, cm, profile}, computes goal & schedule,
// and sends Telegram reminders with a recommended sip volume (ml).

const QUIET_START = 23;  // 23:00 local
const QUIET_END   = 7;   // 07:00 local
const MIN_INTERVAL_MIN = 30; // don't spam

const lastNotified = new Map(); // by chat_id

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const body = typeof req.body === 'object' && req.body ? req.body
                 : JSON.parse(await streamToString(req));
    const { pct, ml, cm, ts, profile } = body || {};
    if (pct == null || ml == null) return res.status(400).json({ error: 'missing pct/ml' });

    const chatId = process.env.CHAT_ID;
    const botToken = process.env.BOT_TOKEN;
    if (!chatId || !botToken) return res.status(500).json({ error: 'missing env vars' });

    // Quiet hours
    const now = new Date();
    const hour = now.getHours();
    if (hour >= QUIET_START || hour < QUIET_END) {
      return res.json({ ok: true, skipped: 'quiet_hours' });
    }

    // Build context
    const ctx = computeContext(profile, now);
    const goal_ml = computeGoalMl(ctx);
    const sched   = computeSchedule(ctx); // weight the day (morning/afternoon/evening by activity)
    const target_ml_now = Math.round(goal_ml * sched.fractionAt(now));
    const remaining_ml  = Math.max(0, goal_ml - ml);

    // rate limit
    const last = lastNotified.get(chatId) || 0;
    if (Date.now() - last < MIN_INTERVAL_MIN * 60 * 1000) {
      return res.json({ ok: true, skipped: 'interval' });
    }

    // Are we behind schedule or very low percent?
    const behind = ml + 50 < target_ml_now; // a little tolerance
    const veryLow = pct < 40;

    if (!(behind || veryLow) || remaining_ml <= 0) {
      return res.json({ ok: true, skipped: 'on_track_or_done' });
    }

    // Decide sip size (ml)
    const gap = Math.max(0, target_ml_now - ml);
    // Heavier activity gets larger catch-up sips; keep it gentle & safe
    const act = ctx.activity_level;
    const baseMin = (act === 'Heavy') ? 200 : (act === 'Moderate') ? 180 : 150;
    const baseMax = (act === 'Heavy') ? 300 : (act === 'Moderate') ? 250 : 220;
    const next_sip_ml = clamp(Math.round(gap / 3), baseMin, baseMax);

    // Build human message
    let text = buildRuleMessage(ctx, goal_ml, ml, remaining_ml, target_ml_now, next_sip_ml);

    // Optional: AI rephrase via OpenAI (uncomment + add OPENAI_API_KEY in Vercel)
    /*
    if (process.env.OPENAI_API_KEY) {
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
      text = r?.choices?.[0]?.message?.content?.trim() || text;
    }
    */

    await telegramSend(botToken, chatId, text);
    lastNotified.set(chatId, Date.now());
    res.json({ ok: true, notified: true, goal_ml, next_sip_ml, target_ml_now });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error', detail: String(e) });
  }
}

function computeContext(p={}, now=new Date()){
  const parseHM = s => /^\d{2}:\d{2}$/.test(s||'') ? (()=>{const[a,b]=s.split(':').map(Number);const d=new Date(now);d.setHours(a,b,0,0);return d;})() : null;
  const wake  = parseHM(p.wake_time)  || new Date(now.setHours(7,0,0,0));
  const sleep = parseHM(p.sleep_time) || new Date((new Date()).setHours(23,0,0,0));
  return {
    name: p.name || 'friend',
    age: Number(p.age) || null,
    weight_kg: Number(p.weight_kg) || 60,
    activity_level: p.activity_level || 'Light', // Sedentary / Light / Moderate / Heavy
    daily_activity_minutes: Number(p.daily_activity_minutes) || 30,
    medical_conditions: Array.isArray(p.medical_conditions) ? p.medical_conditions : [],
    clinician_limit_ml: p.clinician_limit_ml != null ? Number(p.clinician_limit_ml) : null,
    temp_c: p.temp_c != null ? Number(p.temp_c) : null,
    humidity_pct: p.humidity_pct != null ? Number(p.humidity_pct) : null,
    wake, sleep
  };
}

function computeGoalMl(ctx){
  let goal = Math.round(35 * ctx.weight_kg); // baseline
  const blocks = Math.max(0, Math.round(ctx.daily_activity_minutes / 30));
  const addPer = {Sedentary:0, Light:200, Moderate:400, Heavy:600}[ctx.activity_level] ?? 200;
  goal += blocks * addPer;
  if ((ctx.temp_c!=null && ctx.temp_c>=30) || (ctx.humidity_pct!=null && ctx.humidity_pct>=70)) goal += 300;

  const hasCKD = ctx.medical_conditions.includes('ckd');
  const hasHF  = ctx.medical_conditions.includes('hf');
  if (ctx.clinician_limit_ml!=null) goal = Math.min(goal, ctx.clinician_limit_ml);
  if ((hasCKD||hasHF) && ctx.clinician_limit_ml==null) goal = Math.min(goal, 2000); // soft cap without doctor advice
  goal = clamp(goal, 1200, 4000);
  return goal;
}

function computeSchedule(ctx){
  // Distribute goal across day based on activity level.
  // Fractions must sum to 1. We bias midday for Moderate/Heavy.
  const morning  = (ctx.activity_level==='Heavy') ? 0.25 : (ctx.activity_level==='Moderate') ? 0.30 : 0.35;
  const afternoon= (ctx.activity_level==='Heavy') ? 0.55 : (ctx.activity_level==='Moderate') ? 0.50 : 0.45;
  const evening  = 1 - (morning + afternoon); // remainder

  const {wake, sleep} = ctx;
  const durMs = Math.max(1, sleep - wake);
  const tMorningEnd   = new Date(wake.getTime() + durMs * 0.33);
  const tAfternoonEnd = new Date(wake.getTime() + durMs * 0.80);

  function fractionAt(now){
    if (now <= wake) return 0;
    if (now >= sleep) return 1;
    if (now <= tMorningEnd){
      const f = (now - wake) / (tMorningEnd - wake);
      return f * morning;
    }
    if (now <= tAfternoonEnd){
      const f = (now - tMorningEnd) / (tAfternoonEnd - tMorningEnd);
      return morning + f * afternoon;
    }
    const f = (now - tAfternoonEnd) / (sleep - tAfternoonEnd);
    return morning + afternoon + f * evening;
  }
  return { fractionAt };
}

function buildRuleMessage(ctx, goal_ml, current_ml, remaining_ml, target_ml_now, next_sip_ml){
  const pace = `${current_ml}/${goal_ml} ml`;
  const name = ctx.name;
  return `💧 Hey ${name}! You’re behind ${target_ml_now - current_ml} ml (pace ${pace}). Drink ~${next_sip_ml} ml now. Remaining today: ${remaining_ml} ml.`;
}

async function telegramSend(botToken, chatId, text){
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ chat_id: chatId, text }) });
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
async function streamToString(req){ return await new Promise((res,rej)=>{let d='';req.on('data',c=>d+=c);req.on('end',()=>res(d));req.on('error',rej);});}
