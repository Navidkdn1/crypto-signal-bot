/**
 * 🚀 Crypto Signal Bot v9.1 (Pro Intraday Scalper - 1H / 15m / 5m Top-Down Engine)
 * --------------------------------------------------------------------------
 * 🧭 تحلیل از بالا به پایین: 1H جهت اصلی و ساختار → 15m روند/رنج → 5m ماشه ورود
 * 🧱 سطوح کلیدی: PDH/PDL، سقف/کف‌های 1H، VWAP سشن ±1σ/±2σ، رنج 15m
 * 🔥 سه ستاپ حرفه‌ای:
 *    1) پولبک به ناحیه ارزش (VWAP/EMA21) در جهت روند 1H
 *    2) شکار نقدینگی (SFP) روی سطح کلیدی و برگشت
 *    3) شکست فشردگی نوسان (Squeeze Breakout) با حجم
 * 📊 جریان سفارشات: دلتای Taker، تغییر Open Interest، Funding
 * 🕐 فیلتر سشن (لندن/نیویورک) + تارگت روی سطوح نقدینگی + الزام فضای کافی تا مانع
 * 🛡️ ریسک بر اساس گرید (A+/A/B)، استاپ متحرک ATR، سقف ضرر روزانه و توقف بعد از ۳ ضرر متوالی
 *
 * v9.1 changelog (risk / execution hardening):
 *  - Net-of-cost accounting: fees + slippage are charged in R; break-even stop now covers costs
 *  - Min stop 0.40% (fees were 0.4R on the old 0.25% floor)
 *  - Portfolio heat cap, weekly loss cap, no-chase filter, funding-window filter, BTC-opposition penalty
 *  - Wilder ATR, drawdown / avg-win / avg-loss in stats, journaled manual closes
 *  - Security: webhook secret, chat allow-list, gated /diag, no token writes to KV
 */

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"];
const MAX_OPEN_POSITIONS = 3;          // سقف کل پوزیشن‌های همزمان (ارزها همبستگی بالایی دارند)
const MAX_SAME_DIRECTION = 2;          // حداکثر پوزیشن هم‌جهت (جلوگیری از ۴ برابر شدن ریسک روی یک حرکت BTC)
const FIXED_MIN_SCORE = 70;            // آستانه امتیاز (مقیاس جدید بدون امتیاز رایگان)
const MAX_TRADE_DURATION_MIN = 90;     // سقف عمر معامله
const STALE_TRADE_MIN = 45;            // اگر تا ۴۵ دقیقه به 0.5R نرسید، خروج زمانی
const STALE_MIN_PROGRESS_R = 0.5;
const COOLDOWN_AFTER_WIN_SEC = 600;    // ۱۰ دقیقه بعد از معامله سودده
const COOLDOWN_AFTER_LOSS_SEC = 1800;  // ۳۰ دقیقه بعد از استاپ (جلوگیری از انتقام‌گیری بازار)
const MIN_SL_PCT = 0.40;               // استاپ کوچک‌تر از این، با کارمزد بی‌ارزش است
const MAX_SL_PCT = 1.60;               // استاپ بزرگ‌تر از این برای اسکلپ نامعتبر است
const FEE_ROUND_TRIP_PCT = 0.10;       // تخمین کارمزد رفت‌وبرگشت Taker
const FUNDING_EXTREME_PCT = 0.05;      // فاندینگ افراطی (هر ۸ ساعت)
const WALLET_RISK_PCT = 1.0;           // ریسک پایه هر معامله از کل کیف پول
const RISK_PER_TIER = { "A+": 1.0, "A": 0.75, "B": 0.5 }; // ریسک بر اساس کیفیت سیگنال
const MIN_ROOM_R = 1.2;                // حداقل فضای آزاد تا اولین سطح مخالف
const TRAIL_ATR_MULT = 1.5;            // استاپ متحرک بعد از TP1 (فاصله ATR از بهترین قیمت)
const DAILY_MAX_LOSS_R = -3;           // سقف ضرر روزانه بر حسب R
const MAX_LOSS_STREAK = 3;             // توقف بعد از ۳ ضرر پشت‌سرهم
const LOSS_STREAK_PAUSE_SEC = 7200;    // مدت توقف: ۲ ساعت
const WEEKLY_MAX_LOSS_R = -6;          // [v9.1] weekly loss cap (R) - a bad week stops here, not at -3R x 5 days
const MAX_PORTFOLIO_RISK_PCT = 2.5;    // [v9.1] max combined wallet risk of open positions (positions past TP1 count as 0)
const MAX_CHASE_ATR = 0.35;            // [v9.1] don't enter if price already ran > 0.35 ATR past the trigger candle close
const STOP_SLIPPAGE_PCT = 0.03;        // [v9.1] assumed slippage on market/stop/time exits
const FUNDING_HOURS_UTC = [0, 8, 16];  // [v9.1] funding settlement times
const FUNDING_AVOID_MIN = 10;          // [v9.1] avoid entries this close to funding if we'd be the paying side...
const FUNDING_AVOID_RATE_PCT = 0.02;   // [v9.1] ...and the rate is above this
const LOW_LIQ_EXTRA_SCORE = 5;         // [v9.1] extra score required in low-liquidity hours / weekends
const PARTIALS = { tp1: 0.5, tp2: 0.3, tp3: 0.2 }; // خروج پله‌ای
const POS_TTL_SEC = 7200;
const FALLBACK_CHAT_ID = "-1003828847427";

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Accept": "application/json"
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runRealTimeSchedule(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const adminOk = !env.DIAG_KEY || url.searchParams.get("key") === env.DIAG_KEY;
    if (url.pathname === "/diag") {
      if (!adminOk) return new Response("Forbidden", { status: 403 });
      const [prices, breadth, creds] = await Promise.all([
        fetchLivePrices(),
        analyzeLiveMarketBreadth(),
        getTelegramCredentials(env)
      ]);
      return new Response(JSON.stringify({
        ok: true,
        version: "9.1 Pro Intraday Scalper (1H/15m/5m)",
        fixedMinScore: FIXED_MIN_SCORE,
        hasToken: Boolean(creds.token),
        chatId: env.DIAG_KEY ? creds.chatId : "hidden (set DIAG_KEY to reveal)",
        livePrices: prices,
        liveMarketBreadth: breadth
      }, null, 2), { headers: { "Content-Type": "application/json; charset=utf-8" } });
    }

    if (url.pathname === "/test") {
      if (!adminOk) return new Response("Forbidden", { status: 403 });
      const { chatId } = await getTelegramCredentials(env);
      const res = await sendMainMenu(env, chatId);
      return new Response(JSON.stringify(res, null, 2), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      // [v9.1] Telegram sends this header when the webhook was registered with secret_token
      if (env.WEBHOOK_SECRET && request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      try {
        const update = await request.json();

        // ۱. مدیریت دکمه‌های شیشه‌ای
        if (update.callback_query) {
          const cb = update.callback_query;
          const chatId = cb.message.chat.id;
          const data = cb.data;

          if (!(await isAuthorizedChat(env, chatId))) {
            await answerCallback(env, cb.id, "⛔ Unauthorized chat");
            return new Response("OK", { status: 200 });
          }
          await answerCallback(env, cb.id, "⏳ در حال پردازش...");

          if (data === "cmd_scan") await handleScanCommand(env, chatId);
          else if (data === "cmd_positions") await handlePositionsCommand(env, chatId);
          else if (data === "cmd_stats") await handleStatsCommand(env, chatId);
          else if (data === "cmd_history") await handleHistoryCommand(env, chatId);
          else if (data === "cmd_menu") await sendMainMenu(env, chatId);
          else if (data === "cmd_force") await runBotEngine(env, true, chatId);
          else if (data === "cmd_clear") await handleClearCommand(env, chatId);
          else if (data === "cmd_reset") await handleResetCommand(env, chatId);
          else if (data.startsWith("coin_")) {
            const sym = data.replace("coin_", "");
            await handleSingleCoinCommand(env, chatId, sym);
          } else if (data.startsWith("close_")) {
            const sym = data.replace("close_", "");
            if (SYMBOLS.includes(sym)) await manualClosePosition(env, sym, chatId);
          }
          return new Response("OK", { status: 200 });
        }

        // ۲. مدیریت دستورات متنی
        if (update.message && update.message.text) {
          const chatId = update.message.chat.id;
          if (!(await isAuthorizedChat(env, chatId))) {
            await sendTelegramRaw(env, chatId, `⛔ این چت مجاز نیست.\nشناسه: <code>${chatId}</code> (برای مجاز کردن، به TELEGRAM_ALLOWED_CHAT_IDS اضافه کنید)`);
            return new Response("OK", { status: 200 });
          }
          const text = update.message.text.trim().split("@")[0].toLowerCase();

          if (text === "/start" || text === "/menu" || text === "/help") {
            await sendMainMenu(env, chatId);
          } else if (text === "/scan") {
            await handleScanCommand(env, chatId);
          } else if (text === "/status" || text === "/positions") {
            await handlePositionsCommand(env, chatId);
          } else if (text === "/stats") {
            await handleStatsCommand(env, chatId);
          } else if (text === "/history") {
            await handleHistoryCommand(env, chatId);
          } else if (text === "/force") {
            await runBotEngine(env, true, chatId);
          } else if (text === "/clear") {
            await handleClearCommand(env, chatId);
          } else if (text === "/reset") {
            await handleResetCommand(env, chatId);
          } else if (["/btc", "/eth", "/sol", "/bnb"].includes(text)) {
            const sym = text.replace("/", "").toUpperCase() + "USDT";
            await handleSingleCoinCommand(env, chatId, sym);
          }
        }
      } catch (err) {
        console.error("Webhook Error:", err);
      }
      return new Response("OK", { status: 200 });
    }

    return new Response("🤖 Crypto Signal Bot v9.1 Pro Intraday Scalper is Running!", { status: 200 });
  }
};

/* =========================================================
   ۱. شمارنده سریال سیگنال (#SIG-ID)
========================================================= */
async function getNextSignalId(env) {
  if (!env.SIGNAL_KV) return Math.floor(1000 + Math.random() * 9000);
  const raw = await env.SIGNAL_KV.get("LAST_SIGNAL_ID");
  const currentId = raw ? parseInt(raw, 10) : 1000;
  const nextId = currentId + 1;
  await env.SIGNAL_KV.put("LAST_SIGNAL_ID", String(nextId));
  return nextId;
}

/* =========================================================
   ۲. حلقه رصد لحظه‌ای هر ۱۵ ثانیه (Sub-Minute Engine)
========================================================= */
async function runRealTimeSchedule(env) {
  await runBotEngine(env, false);

  for (let tick = 1; tick <= 3; tick++) {
    await sleep(15000);
    const hasOpen = await hasAnyOpenPosition(env);
    if (!hasOpen) break;
    await checkActivePositionsRealTime(env);
  }
}

async function hasAnyOpenPosition(env) {
  if (!env.SIGNAL_KV) return false;
  for (const sym of SYMBOLS) {
    if (await env.SIGNAL_KV.get(`POS_${sym}`)) return true;
  }
  return false;
}

/* =========================================================
   ۳. رصد لحظه‌ای TP1 / TP2 / TP3 / SL و ریسک‌فری خودکار
========================================================= */
async function checkActivePositionsRealTime(env) {
  if (!env.SIGNAL_KV) return 0;
  let activeCount = 0;

  for (const symbol of SYMBOLS) {
    const raw = await env.SIGNAL_KV.get(`POS_${symbol}`);
    if (!raw) continue;

    let pos;
    try { pos = JSON.parse(raw); } catch { await env.SIGNAL_KV.delete(`POS_${symbol}`); continue; }
    migratePosition(pos);

    // دریافت High/Low واقعی از آخرین بررسی (کندل‌های ۱ دقیقه) تا ویک‌ها از دست نروند
    const since = pos.lastCheckAt || pos.openedAt || Date.now();
    const range = await fetchPriceRangeSince(symbol, since);
    if (!range) { activeCount++; continue; }

    const { high, low, last } = range;
    const isLong = pos.direction === "LONG";
    const m = isLong ? 1 : -1;
    const dec = pos.entry > 100 ? 2 : 3;
    const sigTag = `#SIG-${pos.signalId || "1000"}`;
    const replyMsgId = pos.messageId || null;
    const durationMin = Math.max(1, Math.round((Date.now() - (pos.openedAt || Date.now())) / 60000));
    const riskDist = Math.abs(pos.entry - pos.initialSl) || (pos.entry * 0.005);
    const toR = (price) => ((price - pos.entry) * m) / riskDist;
    const favorable = isLong ? high : low;   // بهترین قیمت در بازه
    const adverse = isLong ? low : high;     // بدترین قیمت در بازه
    const reached = (level) => (isLong ? favorable >= level : favorable <= level);
    const slTouched = isLong ? adverse <= pos.sl : adverse >= pos.sl;

    pos.maxFavR = Math.max(pos.maxFavR || 0, toR(favorable));
    const prevBest = pos.bestPrice ?? pos.entry;
    pos.lastCheckAt = Date.now();

    // ۱. حد ضرر قبل از هر تارگتی بررسی می‌شود (فرض محافظه‌کارانه وقتی هر دو در یک بازه لمس شده‌اند)
    if (slTouched) {
      const slR = toR(pos.sl);
      pos.realizedR += pos.remaining * slR;
      pos.remaining = 0;
      const label = slR > 0.2 ? "Trail 🔒" : pos.tp1Hit ? "BE 🛡️" : "SL 🛑";
      const final = await closePosition(env, pos, label, durationMin, { marketExit: true });

      const title = slR > 0.2 ? "🔒 <b>خروج با استاپ متحرک (قفل سود)</b>"
        : pos.tp1Hit ? "🛡️ <b>بسته شدن در نقطه ریسک‌فری (Break-Even+)</b>"
        : "🛑 <b>برخورد با حد ضرر (Stop-Loss)</b>";
      const msg = `
${title}
<blockquote>🔖 <b>سیگنال:</b> <code>${sigTag}</code> | <b>#${symbol}</b> (${pos.direction})
├ <b>قیمت ورود:</b> <code>${pos.entry}</code>
├ <b>نقطه خروج:</b> <code>${pos.sl}</code>
├ <b>نتیجه کل معامله:</b> <b>${fmtSigned(final.netR)}R</b> | <b>${fmtSigned(final.netPct)}%</b> <i>(با اهرم ${pos.leverage}x: ${fmtSigned(final.netPct * pos.leverage, 1)}%)</i>
└ <b>مدت معامله:</b> ${durationMin} دقیقه</blockquote>
`.trim();
      await sendTelegramGlobal(env, msg, null, replyMsgId);
      continue;
    }

    // ۲. تارگت‌ها به ترتیب (ممکن است چند تارگت در یک بازه لمس شوند)
    let changed = false;

    if (!pos.tp1Hit && reached(pos.tp1)) {
      pos.tp1Hit = true;
      pos.realizedR += PARTIALS.tp1 * toR(pos.tp1);
      pos.remaining -= PARTIALS.tp1;
      // [v9.1] stop to entry + (fees + slippage in R) + 0.05R, so a break-even stop-out is a true scratch, not a hidden loss
      const beR = Math.min(0.5, (FEE_ROUND_TRIP_PCT + STOP_SLIPPAGE_PCT) / Math.max(pos.riskPct, 0.05) + 0.05);
      pos.sl = round(pos.entry + m * riskDist * beR, dec);
      changed = true;
      const msg = `
✅⚡️ <b>تارگت اول تاچ شد (TP1 Hit!)</b>
<blockquote>🔖 <b>سیگنال:</b> <code>${sigTag}</code> | <b>#${symbol}</b> (${pos.direction})
├ <b>قیمت ورود:</b> <code>${pos.entry}</code> | <b>TP1:</b> <code>${pos.tp1}</code>
├ <b>سود این پله:</b> <b>+${pctMove(pos.entry, pos.tp1)}%</b> <i>(با اهرم ${pos.leverage}x: +${(pctMove(pos.entry, pos.tp1) * pos.leverage).toFixed(1)}%)</i>
└ <b>مدت زمان:</b> ${durationMin} دقیقه</blockquote>
💵 <b>${PARTIALS.tp1 * 100}٪ حجم را سیو سود کنید</b> | 🛡️ استاپ به <code>${pos.sl}</code> (ریسک‌فری) منتقل شد.
`.trim();
      await sendTelegramGlobal(env, msg, null, replyMsgId);
    }

    if (pos.tp1Hit && !pos.tp2Hit && reached(pos.tp2)) {
      pos.tp2Hit = true;
      pos.realizedR += PARTIALS.tp2 * toR(pos.tp2);
      pos.remaining -= PARTIALS.tp2;
      pos.sl = isLong ? Math.max(pos.sl, pos.tp1) : Math.min(pos.sl, pos.tp1);
      changed = true;
      const msg = `
🎯🔥 <b>تارگت دوم تاچ شد (TP2 Hit!)</b>
<blockquote>🔖 <b>سیگنال:</b> <code>${sigTag}</code> | <b>#${symbol}</b> (${pos.direction})
├ <b>قیمت ورود:</b> <code>${pos.entry}</code> | <b>TP2:</b> <code>${pos.tp2}</code>
├ <b>سود این پله:</b> <b>+${pctMove(pos.entry, pos.tp2)}%</b> <i>(با اهرم ${pos.leverage}x: +${(pctMove(pos.entry, pos.tp2) * pos.leverage).toFixed(1)}%)</i>
└ <b>مدت زمان:</b> ${durationMin} دقیقه</blockquote>
💵 <b>${PARTIALS.tp2 * 100}٪ دیگر را ببندید</b> | 🔒 استاپ به <b>TP1 (<code>${pos.tp1}</code>)</b> منتقل شد.
`.trim();
      await sendTelegramGlobal(env, msg, null, replyMsgId);
    }

    if (pos.tp2Hit && reached(pos.tp3)) {
      pos.realizedR += pos.remaining * toR(pos.tp3);
      pos.remaining = 0;
      const final = await closePosition(env, pos, "TP3 🚀", durationMin);
      const msg = `
🚀💎 <b>فول تارگت نهایی (TP3 Hit!)</b>
<blockquote>🔖 <b>سیگنال:</b> <code>${sigTag}</code> | <b>#${symbol}</b> (${pos.direction})
├ <b>قیمت ورود:</b> <code>${pos.entry}</code> | <b>TP3:</b> <code>${pos.tp3}</code>
├ <b>نتیجه کل معامله:</b> <b>${fmtSigned(final.netR)}R</b> | <b>${fmtSigned(final.netPct)}%</b> <i>(با اهرم ${pos.leverage}x: ${fmtSigned(final.netPct * pos.leverage, 1)}%)</i>
└ <b>مدت معامله:</b> ${durationMin} دقیقه</blockquote>
🏆 <i>معامله با موفقیت کامل بسته شد!</i>
`.trim();
      await sendTelegramGlobal(env, msg, null, replyMsgId);
      continue;
    }

    // استاپ متحرک ATR بعد از TP1 (فقط سفت‌تر می‌شود، هیچ‌وقت عقب نمی‌رود)
    pos.bestPrice = isLong ? Math.max(prevBest, high) : Math.min(prevBest, low);
    if (pos.tp1Hit && pos.atr) {
      const trail = round(prevBest - m * TRAIL_ATR_MULT * pos.atr, dec);
      if (isLong ? trail > pos.sl : trail < pos.sl) { pos.sl = trail; changed = true; }
    }

    // ۳. خروج زمانی: معامله بی‌حرکت (قبل از TP1) یا اتمام سقف زمان
    const staleExit = !pos.tp1Hit && durationMin >= STALE_TRADE_MIN && pos.maxFavR < STALE_MIN_PROGRESS_R;
    if (staleExit || durationMin >= MAX_TRADE_DURATION_MIN) {
      const curR = toR(last);
      pos.realizedR += pos.remaining * curR;
      pos.remaining = 0;
      const final = await closePosition(env, pos, "Time ⏳", durationMin, { marketExit: true });
      const reason = staleExit
        ? `عدم حرکت قیمت تا ${STALE_TRADE_MIN} دقیقه (کمتر از ${STALE_MIN_PROGRESS_R}R)`
        : `گذشت ${MAX_TRADE_DURATION_MIN} دقیقه از ستاپ اسکلپ`;
      const msg = `
⏳ <b>خروج زمانی اسکلپ (Time-Stop)</b>
<blockquote>🔖 <b>سیگنال:</b> <code>${sigTag}</code> | <b>#${symbol}</b> (${pos.direction})
├ <b>ورود:</b> <code>${pos.entry}</code> | <b>فعلی:</b> <code>${last.toFixed(dec)}</code>
├ <b>نتیجه کل معامله:</b> <b>${fmtSigned(final.netR)}R</b> | <b>${fmtSigned(final.netPct)}%</b>
└ <b>علت:</b> ${reason}</blockquote>
`.trim();
      await sendTelegramGlobal(env, msg, null, replyMsgId);
      continue;
    }

    await env.SIGNAL_KV.put(`POS_${symbol}`, JSON.stringify(pos), { expirationTtl: POS_TTL_SEC });
    activeCount++;
  }
  return activeCount;
}

// سازگاری با پوزیشن‌های ذخیره‌شده نسخه قبلی
function migratePosition(pos) {
  if (pos.initialSl === undefined) pos.initialSl = pos.sl;
  if (pos.realizedR === undefined) pos.realizedR = 0;
  if (pos.remaining === undefined) pos.remaining = 1;
  if (!pos.leverage) pos.leverage = 5;
  if (pos.riskPct === undefined) pos.riskPct = Math.abs(pos.entry - pos.initialSl) / pos.entry * 100;
}

async function closePosition(env, pos, label, durationMin, opts = {}) {
  // [v9.1] Report NET results. Costs are expressed in R so tight stops are penalised correctly
  // (a 0.10% round-trip fee is 0.25R on a 0.40% stop). Stop/time/manual exits are market orders -> add slippage.
  const costPct = FEE_ROUND_TRIP_PCT + (opts.marketExit ? STOP_SLIPPAGE_PCT : 0);
  const feeR = costPct / Math.max(pos.riskPct, 0.05);
  const grossR = pos.realizedR;
  const netR = grossR - feeR;
  const netPct = netR * pos.riskPct;
  await env.SIGNAL_KV.delete(`POS_${pos.symbol}`);
  const cooldown = netPct > 0 ? COOLDOWN_AFTER_WIN_SEC : COOLDOWN_AFTER_LOSS_SEC;
  await env.SIGNAL_KV.put(`COOLDOWN_${pos.symbol}`, "1", { expirationTtl: cooldown });
  if (!pos.isForced) await updateRiskGuards(env, netR);
  await recordTradeStat(env, {
    signalId: pos.signalId, symbol: pos.symbol, direction: pos.direction,
    result: label, pct: parseFloat(netPct.toFixed(3)), r: parseFloat(netR.toFixed(2)), durationMin
  });
  return { netR, netPct, grossR, feeR };
}

// ترمز اضطراری: ثبت R روزانه و شمارش ضررهای پشت‌سرهم
async function updateRiskGuards(env, netR) {
  const day = new Date().toISOString().slice(0, 10);
  const dailyR = (parseFloat(await env.SIGNAL_KV.get(`DAILY_R_${day}`)) || 0) + netR;
  await env.SIGNAL_KV.put(`DAILY_R_${day}`, dailyR.toFixed(3), { expirationTtl: 172800 });
  const wk = weekKey();
  const weeklyR = (parseFloat(await env.SIGNAL_KV.get(`WEEKLY_R_${wk}`)) || 0) + netR;
  await env.SIGNAL_KV.put(`WEEKLY_R_${wk}`, weeklyR.toFixed(3), { expirationTtl: 864000 });

  let streak = parseInt(await env.SIGNAL_KV.get("LOSS_STREAK") || "0", 10);
  if (netR < -0.05) streak++; else if (netR > 0.05) streak = 0;

  if (streak >= MAX_LOSS_STREAK) {
    streak = 0;
    await env.SIGNAL_KV.put("PAUSE_STREAK", "1", { expirationTtl: LOSS_STREAK_PAUSE_SEC });
    await sendTelegramGlobal(env, `⏸️ <b>توقف موقت سیگنال‌دهی</b>\n└ ${MAX_LOSS_STREAK} ضرر پشت‌سرهم ثبت شد؛ بات ${LOSS_STREAK_PAUSE_SEC / 3600} ساعت سیگنال جدید نمی‌دهد تا شرایط بازار عوض شود.`);
  }
  await env.SIGNAL_KV.put("LOSS_STREAK", String(streak));

  if (weeklyR <= WEEKLY_MAX_LOSS_R && weeklyR - netR > WEEKLY_MAX_LOSS_R) {
    await sendTelegramGlobal(env, `🛑 <b>سقف ضرر هفتگی فعال شد</b>\n└ برآیند این هفته ${weeklyR.toFixed(2)}R است؛ سیگنال‌دهی تا شروع هفته بعد (دوشنبه UTC) متوقف می‌شود.`);
  }

  if (dailyR <= DAILY_MAX_LOSS_R && dailyR - netR > DAILY_MAX_LOSS_R) {
    await sendTelegramGlobal(env, `🛑 <b>سقف ضرر روزانه فعال شد</b>\n└ برآیند امروز ${dailyR.toFixed(2)}R است؛ سیگنال‌دهی تا شروع روز بعد (UTC) متوقف می‌شود.`);
  }
}

const round = (v, dec) => parseFloat(v.toFixed(dec));
const pctMove = (a, b) => parseFloat((Math.abs(b - a) / a * 100).toFixed(2));
const fmtSigned = (v, d = 2) => `${v >= 0 ? "+" : ""}${Number(v).toFixed(d)}`;

// [v9.1] Monday (UTC) of the current week, used as the weekly-R key
const weekKey = (d = new Date()) => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return t.toISOString().slice(0, 10);
};

// [v9.1] Minutes until the next perpetual-swap funding settlement (00/08/16 UTC)
function minutesToNextFunding(now = new Date()) {
  const cur = now.getUTCHours() * 60 + now.getUTCMinutes();
  const next = FUNDING_HOURS_UTC.map(h => h * 60).find(m => m > cur) ?? 24 * 60;
  return next - cur;
}

/* =========================================================
   ۴. تحلیل زنده جریان کل بازار (۵ دقیقه و ۱۵ دقیقه بیت‌کوین)
========================================================= */
async function analyzeLiveMarketBreadth() {
  try {
    const [btc5m, btc15m] = await Promise.all([
      fetchKlines("BTCUSDT", "5m", 60),
      fetchKlines("BTCUSDT", "15m", 60)
    ]);

    if (btc5m.length < 50 || btc15m.length < 50) {
      return { btcTrend5m: "NEUTRAL", btcTrend15m: "NEUTRAL", btc30mChangePct: "0.00", usdtFlow: "متعادل ⚪" };
    }

    const closes5 = btc5m.slice(0, -1).map(k => k.close);
    const closes15 = btc15m.slice(0, -1).map(k => k.close);

    const ema9_5 = calcEMA(closes5, 9), ema21_5 = calcEMA(closes5, 21);
    const ema9_15 = calcEMA(closes15, 9), ema21_15 = calcEMA(closes15, 21);

    const lastBtc = closes5[closes5.length - 1];
    const prev6Btc = closes5[closes5.length - 7] || lastBtc; // تغییرات ۳۰ دقیقه اخیر
    const btc30mChangePct = ((lastBtc - prev6Btc) / prev6Btc) * 100;

    const btcTrend5m = ema9_5 >= ema21_5 ? "LONG" : "SHORT";
    const btcTrend15m = ema9_15 >= ema21_15 ? "LONG" : "SHORT";

    let usdtFlow = "متعادل ⚪";
    if (btcTrend5m === "LONG" && btc30mChangePct > 0.08) usdtFlow = "ورود پول اسکلپ 🟢";
    else if (btcTrend5m === "SHORT" && btc30mChangePct < -0.08) usdtFlow = "فشار فروش اسکلپ 🔴";

    return {
      btcTrend5m,
      btcTrend15m,
      btc30mChangePct: btc30mChangePct.toFixed(2),
      usdtFlow
    };
  } catch {
    return { btcTrend5m: "NEUTRAL", btcTrend15m: "NEUTRAL", btc30mChangePct: "0.00", usdtFlow: "متعادل ⚪" };
  }
}

/* =========================================================
   ۵. موتور اسکن اصلی نسخه v9.1 (1H / 15m / 5m)
========================================================= */
// تحلیل ۱ ساعته هر ۱۵ دقیقه یک‌بار کش می‌شود (کاهش درخواست‌ها در Cloudflare)
async function getHTF(env, symbol) {
  if (env.SIGNAL_KV) {
    const cached = await env.SIGNAL_KV.get(`HTF_${symbol}`);
    if (cached) { try { return JSON.parse(cached); } catch {} }
  }
  const kl = await fetchKlines(symbol, "1h", 220);
  const htf = analyzeHTF(kl);
  if (env.SIGNAL_KV && kl.length >= 60) await env.SIGNAL_KV.put(`HTF_${symbol}`, JSON.stringify(htf), { expirationTtl: 900 });
  return htf;
}

async function buildCandidate(env, symbol, breadth) {
  const coin = symbol.replace("USDT", "");
  const [klines5m, klines15m, futuresData, htf] = await Promise.all([
    fetchKlines(symbol, "5m", 150),
    fetchKlines(symbol, "15m", 100),
    fetchOKXFuturesData(coin),
    getHTF(env, symbol)
  ]);
  if (klines5m.length < 60 || klines15m.length < 60) return null;

  const tf5m = analyzeProScalper(klines5m);
  const tf15m = analyzeProScalper(klines15m);
  const levels = buildKeyLevels(htf, tf15m, tf5m);
  const session = getSessionInfo();
  const setups = detectSetups(tf5m, tf15m, htf, levels, session);

  const conflict = setups.LONG.length > 0 && setups.SHORT.length > 0;
  let direction;
  if (!conflict && setups.LONG.length) direction = "LONG";
  else if (!conflict && setups.SHORT.length) direction = "SHORT";
  else direction = htf.bias !== "NEUTRAL" ? htf.bias : tf5m.setupDirection;
  const active = conflict ? [] : setups[direction];

  tf5m.setupConflict = conflict;
  tf5m.hasActiveSetup = active.length > 0;
  tf5m.confluence = active.length;
  tf5m.setupKeys = active.map(s => s.key);
  tf5m.setupDirection = direction;
  tf5m.setupType = conflict ? "⚔️ تعارض ستاپ‌های خرید و فروش (عدم ورود)"
    : active.length ? active.map(s => s.label).join(" + ") : "در حال رصد کندل ۵ دقیقه";

  const targets = calculateScalpTargets(tf5m, direction, active, levels);
  const scoreData = evaluateProScalpScore({ symbol, direction, tf5m, tf15m, htf, setups: active, targets, breadth, futuresData, session });
  applySizing(targets, scoreData.riskPct);

  return { symbol, direction, entry: tf5m.close, tf5m, tf15m, htf, levels, session, breadth, futuresData, scoreData, targets };
}

async function openPosition(env, candidate, customChatId, isForced = false) {
  const { targets } = candidate;
  // [v9.1] Re-check the slot BEFORE announcing: the old order could send a signal that was never tracked.
  if (env.SIGNAL_KV && await env.SIGNAL_KV.get(`POS_${candidate.symbol}`)) return;
  const signalId = await getNextSignalId(env);
  const sentMsgId = await sendProSignalMessage(env, { ...candidate, signalId, isForced }, customChatId);
  if (!env.SIGNAL_KV) return;

  const sl = parseFloat(targets.sl);
  const posState = {
    signalId,
    messageId: sentMsgId,
    symbol: candidate.symbol,
    direction: candidate.direction,
    entry: candidate.entry,
    tp1: parseFloat(targets.tp1),
    tp2: parseFloat(targets.tp2),
    tp3: parseFloat(targets.tp3),
    sl,
    initialSl: sl,
    riskPct: parseFloat(targets.slPct),
    leverage: targets.leverage,
    walletRisk: targets.walletRisk,
    atr: candidate.tf5m.atr,
    setupKeys: candidate.tf5m.setupKeys,
    tier: candidate.scoreData.tier,
    bestPrice: candidate.entry,
    tp1Hit: false,
    tp2Hit: false,
    realizedR: 0,
    remaining: 1,
    maxFavR: 0,
    isForced,
    openedAt: Date.now(),
    lastCheckAt: Date.now()
  };
  await env.SIGNAL_KV.put(`POS_${candidate.symbol}`, JSON.stringify(posState), { expirationTtl: POS_TTL_SEC });
  await env.SIGNAL_KV.put(`LASTSETUP_${candidate.symbol}`, `${candidate.tf5m.signalCandleTs}_${candidate.direction}`, { expirationTtl: 3600 });
}

// ترمز اضطراری: سقف ضرر روزانه و توقف بعد از ضررهای پشت‌سرهم
async function getRiskState(env) {
  if (!env.SIGNAL_KV) return { blocked: false, dailyR: 0, weeklyR: 0, reason: "" };
  const day = new Date().toISOString().slice(0, 10);
  const dailyR = parseFloat(await env.SIGNAL_KV.get(`DAILY_R_${day}`)) || 0;
  const weeklyR = parseFloat(await env.SIGNAL_KV.get(`WEEKLY_R_${weekKey()}`)) || 0;
  const paused = await env.SIGNAL_KV.get("PAUSE_STREAK");
  const dailyHit = dailyR <= DAILY_MAX_LOSS_R;
  const weeklyHit = weeklyR <= WEEKLY_MAX_LOSS_R;
  const blocked = dailyHit || weeklyHit || Boolean(paused);
  const reason = dailyHit ? `سقف ضرر روزانه (${dailyR.toFixed(2)}R)`
    : weeklyHit ? `سقف ضرر هفتگی (${weeklyR.toFixed(2)}R)`
    : paused ? `${MAX_LOSS_STREAK} ضرر پشت‌سرهم` : "";
  return { blocked, dailyR, weeklyR, reason };
}

async function runBotEngine(env, forceBest = false, customChatId = null) {
  try {
    const activePositions = await checkActivePositionsRealTime(env);
    if (!forceBest && activePositions >= MAX_OPEN_POSITIONS) return;
    if (!forceBest && (await getRiskState(env)).blocked) return;

    const openDirs = { LONG: 0, SHORT: 0 };
    const openSymbols = new Set();
    let openRisk = 0;
    if (env.SIGNAL_KV) {
      for (const sym of SYMBOLS) {
        const raw = await env.SIGNAL_KV.get(`POS_${sym}`);
        if (raw) {
          try {
            const p = JSON.parse(raw);
            openDirs[p.direction]++;
            openSymbols.add(sym);
            if (!p.tp1Hit) openRisk += p.walletRisk ?? WALLET_RISK_PCT;   // risk-free positions no longer count as risk
          } catch {}
        }
      }
    }

    const breadth = await analyzeLiveMarketBreadth();
    const candidates = [];
    for (const symbol of SYMBOLS) {
      if (openSymbols.has(symbol)) continue;
      if (!forceBest && env.SIGNAL_KV && await env.SIGNAL_KV.get(`COOLDOWN_${symbol}`)) continue;
      const c = await buildCandidate(env, symbol, breadth);
      if (c) candidates.push(c);
    }
    candidates.sort((a, b) => b.scoreData.score - a.scoreData.score);

    if (forceBest) {
      const best = candidates.find(c => c.targets.valid) || candidates[0];
      if (best) await openPosition(env, best, customChatId, true);
      else if (customChatId) await sendTelegramRaw(env, customChatId, "⚠️ کاندید معتبری برای /force پیدا نشد (همه ارزها پوزیشن باز دارند یا دیتا دریافت نشد).");
      return;
    }

    let openCount = activePositions;
    for (const c of candidates) {
      if (openCount >= MAX_OPEN_POSITIONS) break;
      const minScore = FIXED_MIN_SCORE + (c.session.lowLiquidity ? LOW_LIQ_EXTRA_SCORE : 0);
      if (!c.scoreData.passed || c.scoreData.score < minScore) continue;
      if (openRisk + c.targets.walletRisk > MAX_PORTFOLIO_RISK_PCT) continue;
      if (openDirs[c.direction] >= MAX_SAME_DIRECTION) continue;
      if (env.SIGNAL_KV) {
        const last = await env.SIGNAL_KV.get(`LASTSETUP_${c.symbol}`);
        if (last === `${c.tf5m.signalCandleTs}_${c.direction}`) continue;
      }
      await openPosition(env, c, customChatId);
      openDirs[c.direction]++;
      openRisk += c.targets.walletRisk;
      openCount++;
    }
  } catch (error) {
    console.error("Bot Engine Error:", error);
  }
}

/* =========================================================
   ۶. موتور ستاپ + امتیازدهی + تارگت‌ها (v9.1)
========================================================= */
function analyzeProScalper(klines) {
  const closedKlines = klines.slice(0, -1);
  const closes = closedKlines.map(k => k.close);
  const liveCandle = klines[klines.length - 1];
  const c0 = closedKlines[closedKlines.length - 1];

  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes, 50);

  const rsiSeries = calcRSISeries(closes, 14);
  const rsi = rsiSeries[rsiSeries.length - 1];
  const prevRsi = rsiSeries[rsiSeries.length - 2];
  const stochRsi = calcStochRSI(rsiSeries, 14);
  const fastMacd = calcFastMACD(closes, 8, 21, 5);

  const atr = calcATR(closedKlines, 14);
  const adx = calcWilderADX(closedKlines, 14);
  const { vwap, sd: vwapSd } = calcSessionVWAPBands(closedKlines);
  const bb = calcBollingerBands(closes, 20, 2);
  const supertrend = calcSupertrend(closedKlines, 10, 2.2);

  const recent10 = closedKlines.slice(-10);
  const swingLow = Math.min(...recent10.map(k => k.low));
  const swingHigh = Math.max(...recent10.map(k => k.high));

  // باکس ۱۲ کندل قبل از کندل ماشه (برای شکست و شکار نقدینگی)
  const box = closedKlines.slice(-13, -1);
  const boxHigh = Math.max(...box.map(k => k.high));
  const boxLow = Math.min(...box.map(k => k.low));

  // فشردگی نوسان: پهنای بولینگر کندل‌های قبل از ماشه در ۲۵٪ پایین ۶۰ کندل اخیر
  const bw = [];
  for (let i = Math.max(20, closes.length - 60); i <= closes.length; i++) bw.push(calcBollingerBands(closes.slice(0, i), 20, 2).bandwidth);
  const preTrigger = Math.min(...bw.slice(-4, -1));
  const wasCompressed = bw.filter(v => v < preTrigger).length / bw.length <= 0.25;

  const avgVol = closedKlines.slice(-21, -1).reduce((s, k) => s + k.volume, 0) / 20;
  const volRatio = c0.volume / (avgVol || 1);

  const cRange = Math.max(c0.high - c0.low, 1e-9);
  const closePos = (c0.close - c0.low) / cRange;
  const bodyRatio = Math.abs(c0.close - c0.open) / cRange;
  const strongBull = c0.close > c0.open && closePos >= 0.6 && bodyRatio >= 0.3;
  const strongBear = c0.close < c0.open && closePos <= 0.4 && bodyRatio >= 0.3;

  const bullStack = ema9 > ema21 && ema21 > ema50;
  const bearStack = ema9 < ema21 && ema21 < ema50;
  const trendDir =
    ema9 > ema21 && c0.close > ema50 && supertrend.direction === "LONG" ? "LONG" :
    ema9 < ema21 && c0.close < ema50 && supertrend.direction === "SHORT" ? "SHORT" : "NEUTRAL";
  const regime = adx >= 20 && (bullStack || bearStack) ? "TREND" : adx < 18 ? "RANGE" : "MIXED";

  const atrPct = (atr / c0.close) * 100;
  const isFlatChop = (adx < 16 && bb.bandwidth < 0.003) || atrPct < 0.08;
  const distFromEma9Atr = Math.abs(liveCandle.close - ema9) / (atr || 1);
  const setupDirection = ema9 >= ema21 ? "LONG" : "SHORT";

  return {
    close: liveCandle.close, c0,
    signalCandleTs: c0.ts || 0,
    ema9, ema21, ema50, vwap, vwapSd,
    rsi, prevRsi, stochRsi, fastMacd,
    atr, atrPct, adx, bb, supertrend,
    swingLow, swingHigh, boxHigh, boxLow, wasCompressed,
    volRatio, closePos, strongBull, strongBear,
    trendDir, regime, isFlatChop, distFromEma9Atr,
    isOverextended: distFromEma9Atr > 1.5,
    hasActiveSetup: false, setupConflict: false, confluence: 0,
    setupType: "در حال رصد کندل ۵ دقیقه", setupDirection, setupKeys: []
  };
}

// تحلیل تایم ۱ ساعته: جهت اصلی (Bias)، ساختار بازار و سطوح کلیدی
function analyzeHTF(klines) {
  const neutral = { bias: "NEUTRAL", structure: "RANGE", pdh: null, pdl: null, swingHighs: [], swingLows: [] };
  if (!klines || klines.length < 60) return neutral;
  const closed = klines.slice(0, -1);
  const closes = closed.map(k => k.close);
  const last = closes[closes.length - 1];
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes, 50);
  const ema200 = closes.length >= 200 ? calcEMA(closes, 200) : null;

  const piv = findPivots(closed, 3);
  const h = piv.highs.slice(-2), l = piv.lows.slice(-2);
  let structure = "RANGE";
  if (h.length === 2 && l.length === 2) {
    if (h[1] > h[0] && l[1] > l[0]) structure = "BULL";
    else if (h[1] < h[0] && l[1] < l[0]) structure = "BEAR";
  }

  let bias = "NEUTRAL";
  if (last > ema50 && ema21 > ema50 && structure !== "BEAR" && (ema200 === null || last > ema200 * 0.997)) bias = "LONG";
  else if (last < ema50 && ema21 < ema50 && structure !== "BULL" && (ema200 === null || last < ema200 * 1.003)) bias = "SHORT";

  let pdh = null, pdl = null;
  const lastTs = closed[closed.length - 1].ts;
  if (lastTs) {
    const dayStart = Math.floor(lastTs / 86400000) * 86400000;
    const prev = closed.filter(k => k.ts >= dayStart - 86400000 && k.ts < dayStart);
    if (prev.length >= 12) { pdh = Math.max(...prev.map(k => k.high)); pdl = Math.min(...prev.map(k => k.low)); }
  }

  return { bias, structure, ema21, ema50, ema200, pdh, pdl, swingHighs: piv.highs.slice(-3), swingLows: piv.lows.slice(-3) };
}

function findPivots(klines, w = 3) {
  const highs = [], lows = [];
  for (let i = w; i < klines.length - w; i++) {
    const win = klines.slice(i - w, i + w + 1);
    if (klines[i].high === Math.max(...win.map(k => k.high))) highs.push(klines[i].high);
    if (klines[i].low === Math.min(...win.map(k => k.low))) lows.push(klines[i].low);
  }
  return { highs, lows };
}

function buildKeyLevels(htf, tf15m, tf5m) {
  const levels = [];
  const add = (name, price, major) => { if (price && isFinite(price)) levels.push({ name, price, major }); };
  add("PDH (سقف دیروز)", htf.pdh, true);
  add("PDL (کف دیروز)", htf.pdl, true);
  htf.swingHighs.forEach(p => add("سقف 1H", p, true));
  htf.swingLows.forEach(p => add("کف 1H", p, true));
  add("VWAP", tf5m.vwap, false);
  if (tf5m.vwapSd > 0) {
    add("VWAP+1σ", tf5m.vwap + tf5m.vwapSd, false);
    add("VWAP-1σ", tf5m.vwap - tf5m.vwapSd, false);
    add("VWAP+2σ", tf5m.vwap + 2 * tf5m.vwapSd, true);
    add("VWAP-2σ", tf5m.vwap - 2 * tf5m.vwapSd, true);
  }
  add("سقف رنج 15m", tf15m.boxHigh, false);
  add("کف رنج 15m", tf15m.boxLow, false);
  return levels;
}

function getSessionInfo(now = new Date()) {
  const h = now.getUTCHours(), d = now.getUTCDay();
  const weekend = d === 0 || d === 6;
  const name = h < 7 ? "آسیا" : h < 13 ? "لندن" : h < 21 ? "نیویورک" : "پایان روز";
  const active = !weekend && ((h >= 7 && h < 11) || (h >= 13 && h < 17));
  const lowLiquidity = weekend || h >= 21 || h < 5;
  return { name: weekend ? `${name} (آخر هفته)` : name, active, lowLiquidity };
}

// سه ستاپ پرکاربرد تریدرهای حرفه‌ای کوتاه‌مدت
function detectSetups(tf5m, tf15m, htf, levels, session) {
  const c0 = tf5m.c0, atr = tf5m.atr;
  const res = { LONG: [], SHORT: [] };

  // ۱. پولبک به ناحیه ارزش (VWAP / EMA21) در جهت روند 1H
  const valueTopL = Math.max(tf5m.vwap, tf5m.ema21);
  if (htf.bias === "LONG" && tf15m.trendDir !== "SHORT" &&
      c0.low <= valueTopL + 0.2 * atr && c0.low >= tf5m.vwap - 2 * tf5m.vwapSd - 0.2 * atr &&
      c0.close > tf5m.ema21 && tf5m.strongBull && tf5m.rsi > tf5m.prevRsi && tf5m.rsi >= 42 && tf5m.rsi <= 66)
    res.LONG.push({ key: "PULLBACK", label: "🎯 پولبک به ناحیه ارزش (VWAP/EMA21) در جهت روند 1H", stopAnchor: Math.min(c0.low, tf5m.swingLow) });
  const valueBotS = Math.min(tf5m.vwap, tf5m.ema21);
  if (htf.bias === "SHORT" && tf15m.trendDir !== "LONG" &&
      c0.high >= valueBotS - 0.2 * atr && c0.high <= tf5m.vwap + 2 * tf5m.vwapSd + 0.2 * atr &&
      c0.close < tf5m.ema21 && tf5m.strongBear && tf5m.rsi < tf5m.prevRsi && tf5m.rsi <= 58 && tf5m.rsi >= 34)
    res.SHORT.push({ key: "PULLBACK", label: "🎯 پولبک به ناحیه ارزش (VWAP/EMA21) در جهت روند 1H", stopAnchor: Math.max(c0.high, tf5m.swingHigh) });

  // ۲. شکار نقدینگی (SFP) روی سطح کلیدی و برگشت به داخل
  const local = [
    { name: "کف ۱ ساعت اخیر", price: tf5m.boxLow, major: false, side: "LOW" },
    { name: "سقف ۱ ساعت اخیر", price: tf5m.boxHigh, major: false, side: "HIGH" }
  ];
  const all = [...levels, ...local];
  const swept = all.filter(l => c0.low < l.price - 0.05 * atr && c0.close > l.price && l.side !== "HIGH")
    .sort((a, b) => (b.major - a.major) || (b.price - a.price))[0];
  if (swept && tf5m.closePos >= 0.6 && tf5m.volRatio >= 1.3 && (htf.bias !== "SHORT" || swept.major))
    res.LONG.push({ key: "SWEEP", label: `🧲 شکار نقدینگی زیر ${swept.name} و برگشت (SFP)`, stopAnchor: c0.low, major: swept.major });
  const sweptH = all.filter(l => c0.high > l.price + 0.05 * atr && c0.close < l.price && l.side !== "LOW")
    .sort((a, b) => (b.major - a.major) || (a.price - b.price))[0];
  if (sweptH && tf5m.closePos <= 0.4 && tf5m.volRatio >= 1.3 && (htf.bias !== "LONG" || sweptH.major))
    res.SHORT.push({ key: "SWEEP", label: `🧲 شکار نقدینگی بالای ${sweptH.name} و برگشت (SFP)`, stopAnchor: c0.high, major: sweptH.major });

  // ۳. شکست فشردگی نوسان (Squeeze Breakout) با حجم در جهت روند 1H
  if (!session.lowLiquidity && htf.bias === "LONG" && tf5m.wasCompressed &&
      c0.close > tf5m.boxHigh + 0.1 * atr && tf5m.strongBull && tf5m.volRatio >= 1.5)
    res.LONG.push({ key: "BREAKOUT", label: "🚀 شکست فشردگی نوسان (Squeeze) با حجم", stopAnchor: c0.low });
  if (!session.lowLiquidity && htf.bias === "SHORT" && tf5m.wasCompressed &&
      c0.close < tf5m.boxLow - 0.1 * atr && tf5m.strongBear && tf5m.volRatio >= 1.5)
    res.SHORT.push({ key: "BREAKOUT", label: "🚀 شکست فشردگی نوسان (Squeeze) با حجم", stopAnchor: c0.high });

  return res;
}

function evaluateProScalpScore({ symbol, direction, tf5m, tf15m, htf, setups = [], targets, breadth, futuresData, session }) {
  let score = 0;
  const reasons = [];
  const blockers = [];
  const isLong = direction === "LONG";
  const keys = setups.map(s => s.key);
  const isSweep = keys.includes("SWEEP");

  // --- فیلترهای اجباری ---
  if (!setups.length) blockers.push(tf5m.setupConflict ? "تعارض ستاپ‌ها" : "ستاپ فعال نیست");
  if (tf5m.isFlatChop) blockers.push("بازار بی‌نوسان / نوسان کمتر از کارمزد");
  const overextended = tf5m.distFromEma9Atr > (isSweep ? 2.5 : 1.5) ||
    (!isSweep && ((isLong && tf5m.rsi > 70) || (!isLong && tf5m.rsi < 30)));
  tf5m.isOverextended = overextended;
  if (overextended) blockers.push("کندل کشیده یا اشباع RSI");
  if (!isSweep && ((isLong && htf.bias === "SHORT") || (!isLong && htf.bias === "LONG"))) blockers.push("خلاف روند 1H");

  const btcChange = parseFloat(breadth.btc30mChangePct) || 0;
  const extremeContraBtc = symbol !== "BTCUSDT" && ((isLong && btcChange < -0.5) || (!isLong && btcChange > 0.5));
  if (extremeContraBtc) blockers.push("حرکت شدید BTC خلاف جهت");

  const fr = futuresData.fundingRate || 0;
  if ((isLong && fr > FUNDING_EXTREME_PCT) || (!isLong && fr < -FUNDING_EXTREME_PCT)) blockers.push(`فاندینگ افراطی (${futuresData.fundingRateStr})`);

  // [v9.1] Don't chase: the signal fires on a closed candle, but entry is the live price
  const chaseAtr = ((isLong ? tf5m.close - tf5m.c0.close : tf5m.c0.close - tf5m.close)) / (tf5m.atr || 1);
  if (chaseAtr > MAX_CHASE_ATR) blockers.push(`قیمت از کندل ماشه فرار کرده (${chaseAtr.toFixed(2)} ATR)`);

  // [v9.1] Don't open right before a funding settlement if we'd be the paying side
  const minsToFunding = minutesToNextFunding();
  if (minsToFunding <= FUNDING_AVOID_MIN && ((isLong && fr > FUNDING_AVOID_RATE_PCT) || (!isLong && fr < -FUNDING_AVOID_RATE_PCT)))
    blockers.push(`نزدیک زمان فاندینگ (${minsToFunding} دقیقه)`);
  if (targets && !targets.valid) blockers.push("حد ضرر ساختاری بیش از حد بزرگ");
  if (targets && targets.roomR < MIN_ROOM_R) blockers.push(`فضای کافی تا ${targets.nearestLevel} نیست (${targets.roomR.toFixed(1)}R)`);

  // --- امتیاز ---
  if (setups.length) {
    score += Math.min(35, 25 + (setups.length - 1) * 5);
    setups.forEach(s => reasons.push(`• ${s.label}`));
  }
  if (htf.bias === direction) { score += 15; reasons.push(`• هم‌جهت با روند 1H (${htf.structure}) 🧭`); }
  else if (htf.bias === "NEUTRAL") score += 5;

  if (tf15m.trendDir === direction) { score += 10; reasons.push("• هم‌جهت با روند ۱۵ دقیقه ✅"); }
  else if (tf15m.trendDir === "NEUTRAL") score += 4;

  if (setups.some(s => s.major)) { score += 10; reasons.push("• واکنش روی سطح کلیدی اصلی 🧱"); }
  else if (isLong ? tf5m.close >= tf5m.vwap : tf5m.close <= tf5m.vwap) score += 5;

  const delta = futuresData.deltaPct || 0;
  if ((isLong && delta >= 3) || (!isLong && delta <= -3)) { score += 8; reasons.push(`• دلتای سفارشات Taker هم‌جهت (${fmtSigned(delta, 1)}%) 📊`); }
  else if (Math.abs(delta) < 3) score += 3;

  const oi = futuresData.oiChangePct || 0;
  const oiOk = isSweep ? oi <= -0.3 : oi >= 0.2;
  if (oiOk) { score += 7; reasons.push(isSweep ? `• تخلیه پوزیشن‌ها / لیکوئید (OI ${fmtSigned(oi)}%) 💥` : `• ورود پول جدید (OI ${fmtSigned(oi)}%) 💰`); }

  if (tf5m.volRatio >= 1.5) score += 5; else if (tf5m.volRatio >= 1.2) score += 3;

  const btc5 = breadth.btcTrend5m === direction, btc15 = breadth.btcTrend15m === direction;
  if (btc5 && btc15) score += 5;
  else if (btc5 || btc15) score += 2;
  // [v9.1] Alts trading against BOTH BTC timeframes: penalise (correlation risk)
  else if (symbol !== "BTCUSDT" && breadth.btcTrend5m !== "NEUTRAL" && breadth.btcTrend15m !== "NEUTRAL") score -= 6;

  if (targets && targets.roomR >= 2) score += 5;
  if (session.active) { score += 5; reasons.push(`• سشن پرنقدینگی ${session.name} 🕐`); }
  else if (session.lowLiquidity) score -= 5;

  score = Math.max(0, Math.min(100, score));
  const passed = blockers.length === 0;

  let grade = "در انتظار ماشه ⏳", tier = null;
  if (!passed && setups.length) grade = `⛔ ${blockers[0]}`;
  else if (passed && score >= 85) { grade = "VIP Scalp A+ 💎"; tier = "A+"; }
  else if (passed && score >= 77) { grade = "Strong Scalp A 🔥"; tier = "A"; }
  else if (passed && score >= FIXED_MIN_SCORE) { grade = "Active Scalp B ⚡️"; tier = "B"; }

  return { score, grade, tier, riskPct: RISK_PER_TIER[tier] || RISK_PER_TIER.B, reasons, blockers, passed, extremeContraBtc };
}

function calculateScalpTargets(tf5m, direction, setups = [], levels = []) {
  const price = tf5m.close;
  const atr = tf5m.atr;
  const dec = price > 100 ? 2 : 3;
  const m = direction === "LONG" ? 1 : -1;

  // استاپ پشت نقطه ابطال ستاپ (ویک شکار، کف پولبک یا کندل شکست) + بافر
  const anchors = setups.map(s => s.stopAnchor).filter(v => isFinite(v));
  const anchor = anchors.length ? (m === 1 ? Math.min(...anchors) : Math.max(...anchors)) : (m === 1 ? tf5m.swingLow : tf5m.swingHigh);
  let riskDist = Math.abs(price - (anchor - m * atr * 0.25));
  riskDist = Math.min(Math.max(riskDist, atr * 0.8), atr * 2.2);
  riskDist = Math.max(riskDist, price * MIN_SL_PCT / 100);
  const slPctNum = (riskDist / price) * 100;
  const valid = slPctNum <= MAX_SL_PCT;

  // تارگت‌ها روی سطوح نقدینگی بعدی (کمی جلوتر از سطح برای پر شدن)
  const buf = (atr * 0.1) / riskDist;
  const ahead = levels.map(l => ({ ...l, r: ((l.price - price) * m) / riskDist }))
    .filter(l => l.r > 0.15).sort((a, b) => a.r - b.r);
  const nearest = ahead[0];
  const roomR = nearest ? nearest.r : 99;
  const t2 = ahead.find(l => l.r >= 1.5 && l.r <= 3);
  const tp2R = t2 ? Math.max(1.5, t2.r - buf) : 2.0;
  const t3 = ahead.find(l => l.r >= tp2R + 0.7 && l.r <= 4.5);
  const tp3R = t3 ? Math.max(tp2R + 0.5, t3.r - buf) : Math.min(4, tp2R + 1.2);

  const slPrice = price - m * riskDist;
  const tp1Price = price + m * riskDist;
  const tp2Price = price + m * riskDist * tp2R;
  const tp3Price = price + m * riskDist * tp3R;
  const zoneA = price - m * atr * 0.2;
  const pct = (p) => ((Math.abs(p - price) / price) * 100).toFixed(2);

  const targets = {
    valid,
    entryZone: `${Math.min(zoneA, price).toFixed(dec)} ~ ${Math.max(zoneA, price).toFixed(dec)}`,
    sl: slPrice.toFixed(dec), tp1: tp1Price.toFixed(dec), tp2: tp2Price.toFixed(dec), tp3: tp3Price.toFixed(dec),
    slPct: slPctNum.toFixed(2), tp1Pct: pct(tp1Price), tp2Pct: pct(tp2Price), tp3Pct: pct(tp3Price),
    tp2R, tp3R, roomR, nearestLevel: nearest ? nearest.name : "-",
    tp2Level: t2 ? t2.name : "2R", tp3Level: t3 ? t3.name : `${tp3R.toFixed(1)}R`
  };
  applySizing(targets, WALLET_RISK_PCT);
  return targets;
}

// اهرم و درصد مارجین بر اساس ریسک ثابت از کیف پول
function applySizing(targets, walletRisk) {
  const slPctNum = parseFloat(targets.slPct);
  targets.walletRisk = walletRisk;
  targets.leverage = Math.min(10, Math.max(3, Math.round(4 / Math.max(0.3, slPctNum))));
  targets.marginPct = Math.min(25, Math.max(3, Math.round((walletRisk * 100) / (slPctNum * targets.leverage))));
  return targets;
}

/* =========================================================
   ۹. قالب منظم پیام سیگنال و منوها (نسخه v9.1)
========================================================= */
function buildScoreBar(score) {
  const filled = Math.min(10, Math.max(0, Math.round(score / 10)));
  return "🟩".repeat(filled) + "⬜".repeat(10 - filled);
}

async function sendProSignalMessage(env, data, customChatId = null) {
  const { signalId, symbol, direction, entry, targets, scoreData, tf5m, breadth, futuresData, isForced, htf = {}, session = {} } = data;
  const isLong = direction === "LONG";
  const sigTag = `#SIG-${signalId}`;
  const dirTitle = isLong ? "🟢 <b>LONG (اسکلپ خرید)</b>" : "🔴 <b>SHORT (اسکلپ فروش)</b>";
  const modeTag = isForced ? "⚡️ <i>سیگنال درخواستی (/force)</i>\n" : "";

  const text = `
${modeTag}${dirTitle} | <b>#${symbol}</b> • <code>1H / 15m / 5m</code>
🔖 <b>کد سیگنال:</b> <code>${sigTag}</code>
⭐️ <b>اعتبار سیگنال:</b> <b>${scoreData.score}/100</b> <i>(${scoreData.grade})</i>
<code>${buildScoreBar(scoreData.score)}</code>

🎯 <b>ستاپ ورود و مدیریت ریسک</b>
├ <b>ستاپ اسکلپ:</b> ${tf5m.setupType}
├ <b>قیمت ورود:</b> <code>${entry}</code> <i>(محدوده: ${targets.entryZone})</i>
├ <b>اهرم و حجم:</b> <code>Isolated ${targets.leverage}x</code> <i>(${targets.marginPct}% Wallet)</i>
└ <b>ریسک این معامله:</b> <b>${targets.walletRisk}%</b> کیف پول <i>(گرید ${scoreData.tier || "-"})</i>

💰 <b>تارگت‌ها و حد ضرر ساختاری</b> <i>(با لمس کپی می‌شود)</i>
├ ⚡️ <b>TP 1:</b> <code>${targets.tp1}</code> <i>(+${targets.tp1Pct}% | 1R • ${PARTIALS.tp1 * 100}٪ + ریسک‌فری)</i>
├ 🔥 <b>TP 2:</b> <code>${targets.tp2}</code> <i>(+${targets.tp2Pct}% | ${targets.tp2R.toFixed(1)}R • ${targets.tp2Level})</i>
├ 🚀 <b>TP 3:</b> <code>${targets.tp3}</code> <i>(+${targets.tp3Pct}% | ${targets.tp3R.toFixed(1)}R • ${targets.tp3Level})</i>
└ 🛡️ <b>SL:</b> <code>${targets.sl}</code> <i>(-${targets.slPct}%)</i>

<blockquote>📊 <b>داده‌های لحظه‌ای اسکلپ (v9.1):</b>
• <b>روند 1H:</b> ${htf.bias || "-"} (${htf.structure || "-"}) | <b>سشن:</b> ${session.name || "-"}
• <b>Δ Taker:</b> ${fmtSigned(futuresData.deltaPct || 0, 1)}% | <b>OI ۳۰m:</b> ${fmtSigned(futuresData.oiChangePct || 0)}% | <b>RSI:</b> ${tf5m.rsi.toFixed(0)}
${scoreData.reasons.slice(0, 4).join("\n")}</blockquote>
🔒 <i>بعد از TP1 استاپ متحرک ${TRAIL_ATR_MULT}×ATR فعال می‌شود.</i>
`.trim();

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: `📈 چارت #${symbol} در TradingView`, url: `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol}` }
      ],
      [
        { text: "🔄 بروزرسانی ارز", callback_data: `coin_${symbol}` },
        { text: `❌ بستن ${sigTag}`, callback_data: `close_${symbol}` }
      ],
      [
        { text: "📂 پوزیشن‌های باز", callback_data: "cmd_positions" },
        { text: "📜 تاریخچه", callback_data: "cmd_history" }
      ]
    ]
  };

  const { chatId: defaultChatId } = await getTelegramCredentials(env);
  const targetChat = customChatId || defaultChatId;
  const tgResp = await sendTelegramRaw(env, targetChat, text, replyMarkup);
  return tgResp?.result?.message_id || null;
}

async function sendMainMenu(env, chatId) {
  const lastId = env.SIGNAL_KV ? (await env.SIGNAL_KV.get("LAST_SIGNAL_ID") || "1000") : "1000";

  const text = `
🤖 <b>پنل اسکلپر حرفه‌ای کریپتو</b> • <code>v9.1 Pro Intraday</code>

<blockquote>🧭 <b>موتور حرفه‌ای v9.1 (1H / 15m / 5m):</b>
├ <b>۱. پولبک:</b> بازگشت به VWAP/EMA21 در جهت روند 1H ✅
├ <b>۲. شکار نقدینگی:</b> SFP روی PDH/PDL، سقف/کف 1H، VWAP ±2σ ✅
├ <b>۳. شکست:</b> Squeeze Breakout با حجم در سشن فعال ✅
├ <b>۴. جریان سفارشات:</b> Δ Taker + Open Interest + Funding ✅
├ <b>۵. ریسک:</b> گرید A+/A/B، استاپ متحرک، سقف ضرر روزانه ✅
└ <b>حد نصاب امتیاز:</b> <b>${FIXED_MIN_SCORE}/100</b> (آخرین کد: <code>#SIG-${lastId}</code>)</blockquote>

👇 <b>عملیات مورد نظر را انتخاب کنید:</b>
`.trim();

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "🔎 اسکن بازار (/scan)", callback_data: "cmd_scan" },
        { text: "📂 پوزیشن‌های باز (/positions)", callback_data: "cmd_positions" }
      ],
      [
        { text: "🟡 BTC", callback_data: "coin_BTCUSDT" },
        { text: "🔵 ETH", callback_data: "coin_ETHUSDT" },
        { text: "🟣 SOL", callback_data: "coin_SOLUSDT" },
        { text: "🟠 BNB", callback_data: "coin_BNBUSDT" }
      ],
      [
        { text: "📜 تاریخچه (/history)", callback_data: "cmd_history" },
        { text: "📈 آمار وین‌ریت (/stats)", callback_data: "cmd_stats" }
      ],
      [
        { text: "🔄 ریست آمار (/reset)", callback_data: "cmd_reset" },
        { text: "⚡️ سیگنال فوری (/force)", callback_data: "cmd_force" }
      ]
    ]
  };

  return await sendTelegramRaw(env, chatId, text, replyMarkup);
}

async function handleScanCommand(env, chatId) {
  try {
    const [breadth, risk] = await Promise.all([analyzeLiveMarketBreadth(), getRiskState(env)]);
    const session = getSessionInfo();
    const blocks = [];

    for (const symbol of SYMBOLS) {
      const c = await buildCandidate(env, symbol, breadth);
      if (!c) { blocks.push(`🔸 <b>#${symbol}</b>: ⚠️ خطا در دریافت کندل`); continue; }
      const { tf5m, htf, scoreData, futuresData, direction } = c;
      const dirIcon = direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
      let stateText = tf5m.hasActiveSetup ? `🔥 <b>${tf5m.setupType}</b>` : "⏳ منتظر تشکیل ستاپ";
      if (tf5m.hasActiveSetup && !scoreData.passed) stateText += `\n   ⛔ ${scoreData.blockers.join(" • ")}`;
      else if (!tf5m.hasActiveSetup && tf5m.isFlatChop) stateText = "⚠️ بازار بدون نوسان (Flat)";

      blocks.push(
        `🪙 <b>#${symbol}</b> • <code>${tf5m.close}</code>\n` +
        `├ <b>جهت و امتیاز:</b> ${dirIcon} | <b>${scoreData.score}/100</b> <i>(${scoreData.grade})</i>\n` +
        `├ <b>روند 1H:</b> ${htf.bias} (${htf.structure}) | <b>15m:</b> ${c.tf15m.trendDir}\n` +
        `├ <b>جریان سفارشات:</b> Δ <code>${fmtSigned(futuresData.deltaPct, 1)}%</code> | OI <code>${fmtSigned(futuresData.oiChangePct)}%</code> | RSI <code>${tf5m.rsi.toFixed(0)}</code>\n` +
        `└ <b>وضعیت:</b> ${stateText}`
      );
    }

    const msg = `
🔎 <b>اسکن زنده اسکلپ (v9.1 • 1H/15m/5m)</b>
<blockquote>🌐 <b>روند BTC:</b> 5m: <b>${breadth.btcTrend5m}</b> | 15m: <b>${breadth.btcTrend15m}</b>
💧 <b>جریان ۳۰ دقیقه اخیر:</b> ${breadth.usdtFlow} (${breadth.btc30mChangePct}%)
🕐 <b>سشن:</b> ${session.name}${session.active ? " (پرنقدینگی ✅)" : session.lowLiquidity ? " (کم‌نقدینگی ⚠️)" : ""}
🛡️ <b>ریسک امروز:</b> ${fmtSigned(risk.dailyR)}R | هفته: ${fmtSigned(risk.weeklyR)}R${risk.blocked ? ` — ⛔ توقف: ${risk.reason}` : ""}</blockquote>

${blocks.join("\n\n")}
`.trim();

    const replyMarkup = {
      inline_keyboard: [
        [
          { text: "🟡 BTC", callback_data: "coin_BTCUSDT" },
          { text: "🔵 ETH", callback_data: "coin_ETHUSDT" },
          { text: "🟣 SOL", callback_data: "coin_SOLUSDT" },
          { text: "🟠 BNB", callback_data: "coin_BNBUSDT" }
        ],
        [
          { text: "🔄 رفرش اسکن", callback_data: "cmd_scan" },
          { text: "🏠 منوی اصلی", callback_data: "cmd_menu" }
        ]
      ]
    };
    await sendTelegramRaw(env, chatId, msg, replyMarkup);
  } catch (e) {
    await sendTelegramRaw(env, chatId, `❌ خطا در اسکن بازار: ${e.message}`);
  }
}

async function handlePositionsCommand(env, chatId) {
  const [breadth, livePrices] = await Promise.all([analyzeLiveMarketBreadth(), fetchLivePrices()]);
  let activeCards = [];

  if (env.SIGNAL_KV) {
    for (const symbol of SYMBOLS) {
      const raw = await env.SIGNAL_KV.get(`POS_${symbol}`);
      if (raw) {
        const p = JSON.parse(raw);
        const cur = livePrices[symbol] || p.entry;
        const isLong = p.direction === "LONG";
        const pnlPct = (((isLong ? cur - p.entry : p.entry - cur) / p.entry) * 100).toFixed(2);
        const levPnl = (pnlPct * (p.leverage || 5)).toFixed(1);
        const pnlEmoji = pnlPct >= 0 ? "🟢" : "🔴";
        const sigTag = `#SIG-${p.signalId || "1000"}`;
        const ageMin = Math.max(1, Math.round((Date.now() - (p.openedAt || Date.now())) / 60000));

        activeCards.push(
          `<blockquote>🔖 <b>${sigTag}</b> | <b>#${symbol}</b> • ${isLong ? "🟢 LONG" : "🔴 SHORT"} (${p.leverage || 5}x)\n` +
          `├ <b>ورود:</b> <code>${p.entry}</code> ➔ <b>فعلی:</b> <code>${cur}</code>\n` +
          `├ <b>سود/ضرر:</b> ${pnlEmoji} <b>${pnlPct >= 0 ? "+" : ""}${pnlPct}%</b> <i>(با اهرم: ${levPnl >= 0 ? "+" : ""}${levPnl}%)</i>\n` +
          `├ <b>اهداف:</b> TP1: <code>${p.tp1}</code> ${p.tp1Hit ? "✅" : "⏳"} | SL: <code>${p.sl}</code>\n` +
          `└ <b>زمان سپری‌شده:</b> ${ageMin} دقیقه</blockquote>`
        );
      }
    }
  }

  const posText = activeCards.length > 0
    ? activeCards.join("\n")
    : "<blockquote>🟢 هیچ پوزیشن بازی در حال حاضر وجود ندارد.</blockquote>";

  const report = `
📂 <b>پوزیشن‌های فعال اسکلپ (v9.1)</b>
💧 <b>جریان نقدینگی:</b> ${breadth.usdtFlow}

${posText}
`.trim();

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "🔄 رفرش لحظه‌ای سود/ضرر", callback_data: "cmd_positions" },
        { text: "📜 تاریخچه", callback_data: "cmd_history" }
      ],
      [
        { text: "🗑️ بستن همه پوزیشن‌ها (/clear)", callback_data: "cmd_clear" },
        { text: "🏠 منوی اصلی", callback_data: "cmd_menu" }
      ]
    ]
  };

  await sendTelegramRaw(env, chatId, report, replyMarkup);
}

async function handleSingleCoinCommand(env, chatId, symbol) {
  const breadth = await analyzeLiveMarketBreadth();
  const c = await buildCandidate(env, symbol, breadth);
  if (!c) {
    await sendTelegramRaw(env, chatId, `❌ خطا در دریافت دیتای کندل برای #${symbol}`);
    return;
  }
  const { tf5m, tf15m, htf, scoreData, targets, futuresData, direction, session, levels } = c;
  const dec = tf5m.close > 100 ? 2 : 3;
  const near = levels
    .map(l => ({ ...l, d: Math.abs(l.price - tf5m.close) }))
    .sort((a, b) => a.d - b.d).slice(0, 4)
    .map(l => `${l.name}: <code>${l.price.toFixed(dec)}</code>`).join(" | ");

  const text = `
🔬 <b>کالبدشکافی اسکلپ (v9.1 • 1H/15m/5m)</b> | <b>#${symbol}</b>
💰 <b>قیمت لحظه‌ای:</b> <code>${tf5m.close}</code>
⭐️ <b>امتیاز فعلی:</b> <b>${scoreData.score}/100</b> <i>(حد نصاب: ${FIXED_MIN_SCORE})</i>
<code>${buildScoreBar(scoreData.score)}</code>

🧭 <b>تحلیل از بالا به پایین</b>
├ <b>روند 1H:</b> ${htf.bias} | <b>ساختار:</b> ${htf.structure}
├ <b>روند 15m:</b> ${tf15m.trendDir} | <b>رژیم 5m:</b> ${tf5m.regime} (ADX ${tf5m.adx.toFixed(0)})
├ <b>ستاپ فعال:</b> ${tf5m.setupType}
├ <b>موانع ورود:</b> ${scoreData.blockers.length ? scoreData.blockers.join(" • ") : "ندارد ✅"}
├ <b>VWAP سشن:</b> <code>${tf5m.vwap.toFixed(dec)}</code> (${tf5m.close >= tf5m.vwap ? "🟢 بالای VWAP" : "🔴 زیر VWAP"})
├ <b>جریان سفارشات:</b> Δ ${fmtSigned(futuresData.deltaPct, 1)}% | OI ${fmtSigned(futuresData.oiChangePct)}% | Funding ${futuresData.fundingRateStr}
└ <b>سشن:</b> ${session.name}

🧱 <b>نزدیک‌ترین سطوح:</b> ${near || "-"}

<blockquote>🎯 <b>سطوح در صورت ورود (${direction}):</b>
⚡️ <b>TP1:</b> <code>${targets.tp1}</code> | 🔥 <b>TP2:</b> <code>${targets.tp2}</code> (${targets.tp2Level}) | 🛡️ <b>SL:</b> <code>${targets.sl}</code>
📏 <b>فضا تا اولین مانع:</b> ${targets.roomR >= 99 ? "آزاد" : targets.roomR.toFixed(1) + "R"} (${targets.nearestLevel})</blockquote>
`.trim();

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "🔄 رفرش تحلیل", callback_data: `coin_${symbol}` },
        { text: "📈 چارت TradingView", url: `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol}` }
      ],
      [
        { text: "🔎 بازگشت به اسکن کل بازار", callback_data: "cmd_scan" }
      ]
    ]
  };
  await sendTelegramRaw(env, chatId, text, replyMarkup);
}

async function handleHistoryCommand(env, chatId) {
  let history = [];
  if (env.SIGNAL_KV) {
    const raw = await env.SIGNAL_KV.get("SIGNAL_HISTORY");
    if (raw) { try { history = JSON.parse(raw); } catch {} }
  }

  const lines = history.length > 0
    ? history.slice(0, 10).map(item =>
        `├ <code>#SIG-${item.signalId || "1000"}</code> • <b>#${item.symbol}</b> (${item.direction}) ➔ ${item.result} (<b>${item.pct >= 0 ? "+" : ""}${item.pct.toFixed(2)}%</b>)`
      ).join("\n")
    : "└ هنوز سیگنالی در این دوره ثبت نشده است.";

  const text = `
📜 <b>تاریخچه ۱۰ سیگنال آخر بات</b>
<blockquote>${lines}</blockquote>
`.trim();

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "📈 آمار وین‌ریت (/stats)", callback_data: "cmd_stats" },
        { text: "🔄 ریست تاریخچه (/reset)", callback_data: "cmd_reset" }
      ],
      [
        { text: "🏠 بازگشت به منوی اصلی", callback_data: "cmd_menu" }
      ]
    ]
  };

  await sendTelegramRaw(env, chatId, text, replyMarkup);
}

async function handleStatsCommand(env, chatId) {
  let stats = { wins: 0, losses: 0, breakeven: 0, netPct: 0, netR: 0, grossWinR: 0, grossLossR: 0 };
  if (env.SIGNAL_KV) {
    const raw = await env.SIGNAL_KV.get("BOT_STATS");
    if (raw) { try { stats = { ...stats, ...JSON.parse(raw) }; } catch {} }
  }
  const total = stats.wins + stats.losses + stats.breakeven;
  const winRate = total > 0 ? ((stats.wins / total) * 100).toFixed(1) : "0.0";
  const avgR = total > 0 ? (stats.netR / total) : 0;
  const avgWin = stats.wins > 0 ? (stats.grossWinR / stats.wins).toFixed(2) : "0.00";
  const avgLoss = stats.losses > 0 ? (stats.grossLossR / stats.losses).toFixed(2) : "0.00";
  const pf = stats.grossLossR > 0 ? (stats.grossWinR / stats.grossLossR).toFixed(2) : (stats.grossWinR > 0 ? "∞" : "0.00");

  const text = `
📈 <b>کارنامه و آمار عملکرد بات (v9.1)</b>
<blockquote>├ ✅ <b>معاملات سودده:</b> ${stats.wins}
├ 🛑 <b>معاملات زیان‌ده:</b> ${stats.losses}
├ ⚪ <b>سربه‌سر:</b> ${stats.breakeven}
├ 🏆 <b>نرخ برد (Win-Rate):</b> <b>${winRate}%</b>
├ ⚖️ <b>Profit Factor:</b> <b>${pf}</b> | <b>میانگین هر معامله:</b> ${fmtSigned(avgR)}R
├ 📐 <b>برآیند بر حسب R:</b> <b>${fmtSigned(stats.netR)}R</b>
├ 💰 <b>برآیند خالص (بدون اهرم، پس از کارمزد):</b> <b>${fmtSigned(stats.netPct)}%</b>
├ 📉 <b>حداکثر دراودان:</b> <b>${(stats.maxDDR || 0).toFixed(2)}R</b>
└ 🧮 <b>میانگین برد / باخت:</b> +${avgWin}R / -${avgLoss}R</blockquote>
<i>هر معامله فقط یک‌بار و پس از بسته شدن کامل (با خروج پله‌ای ${PARTIALS.tp1 * 100}/${PARTIALS.tp2 * 100}/${PARTIALS.tp3 * 100}) ثبت می‌شود.</i>
`.trim();

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "📜 تاریخچه سیگنال‌ها (/history)", callback_data: "cmd_history" },
        { text: "🔄 صفر کردن آمار (/reset)", callback_data: "cmd_reset" }
      ],
      [
        { text: "🏠 بازگشت به منوی اصلی", callback_data: "cmd_menu" }
      ]
    ]
  };

  await sendTelegramRaw(env, chatId, text, replyMarkup);
}

async function recordTradeStat(env, tradeInfo) {
  if (!env.SIGNAL_KV) return;
  const { signalId, symbol, direction, result, pct, r = 0, durationMin = 0 } = tradeInfo;

  let stats = { wins: 0, losses: 0, breakeven: 0, netPct: 0, netR: 0, grossWinR: 0, grossLossR: 0 };
  const rawStats = await env.SIGNAL_KV.get("BOT_STATS");
  if (rawStats) { try { stats = { ...stats, ...JSON.parse(rawStats) }; } catch {} }
  if (Math.abs(r) < 0.05) stats.breakeven += 1;
  else if (r > 0) { stats.wins += 1; stats.grossWinR += r; }
  else { stats.losses += 1; stats.grossLossR += Math.abs(r); }
  stats.netPct += pct;
  stats.netR += r;
  stats.peakR = Math.max(stats.peakR || 0, stats.netR);                       // [v9.1] equity peak (R)
  stats.maxDDR = Math.max(stats.maxDDR || 0, stats.peakR - stats.netR);       // [v9.1] max drawdown (R)
  await env.SIGNAL_KV.put("BOT_STATS", JSON.stringify(stats));

  let history = [];
  const rawHist = await env.SIGNAL_KV.get("SIGNAL_HISTORY");
  if (rawHist) { try { history = JSON.parse(rawHist); } catch {} }
  history.unshift({ signalId: signalId || 1000, symbol, direction, result, pct, r, durationMin, closedAt: Date.now() });
  await env.SIGNAL_KV.put("SIGNAL_HISTORY", JSON.stringify(history.slice(0, 20)));
}

// [v9.1] A manual close is journaled at the live price (R, costs, streak and daily/weekly guards) instead of
// silently deleting the position, so the stats can't be flattered by discretionary exits.
async function manualClosePosition(env, symbol, chatId) {
  if (!env.SIGNAL_KV) return null;
  const raw = await env.SIGNAL_KV.get(`POS_${symbol}`);
  if (!raw) {
    if (chatId) await sendTelegramRaw(env, chatId, `ℹ️ پوزیشن بازی برای <b>#${symbol}</b> وجود ندارد.`);
    return null;
  }
  let pos;
  try { pos = JSON.parse(raw); } catch { await env.SIGNAL_KV.delete(`POS_${symbol}`); return null; }
  migratePosition(pos);
  const prices = await fetchLivePrices();
  const last = prices[symbol] || pos.entry;
  const m = pos.direction === "LONG" ? 1 : -1;
  const riskDist = Math.abs(pos.entry - pos.initialSl) || (pos.entry * 0.005);
  pos.realizedR += pos.remaining * (((last - pos.entry) * m) / riskDist);
  pos.remaining = 0;
  const durationMin = Math.max(1, Math.round((Date.now() - (pos.openedAt || Date.now())) / 60000));
  const final = await closePosition(env, pos, "Manual ✋", durationMin, { marketExit: true });
  if (chatId) {
    const sigTag = pos.signalId ? `<code>#SIG-${pos.signalId}</code> ` : "";
    await sendTelegramRaw(env, chatId, `🗑️ <b>بستن دستی پوزیشن</b>\n├ <b>سیگنال:</b> ${sigTag}(<b>#${symbol}</b>)\n├ <b>نتیجه (پس از کارمزد):</b> <b>${fmtSigned(final.netR)}R</b> | <b>${fmtSigned(final.netPct)}%</b>\n└ <b>وضعیت:</b> در کارنامه ثبت و از لیست رصد خارج شد ✅`);
  }
  return final;
}

async function handleClearCommand(env, chatId) {
  if (env.SIGNAL_KV) {
    for (const sym of SYMBOLS) {
      await manualClosePosition(env, sym, null);
      await env.SIGNAL_KV.delete(`COOLDOWN_${sym}`);
    }
  }
  await sendTelegramRaw(env, chatId, "🗑️ <b>پاکسازی پوزیشن‌ها انجام شد</b>\n└ تمام پوزیشن‌های فعال با قیمت لحظه‌ای در کارنامه ثبت و بسته شدند؛ قفل‌های زمانی نیز پاک شد.");
}

async function handleResetCommand(env, chatId) {
  if (env.SIGNAL_KV) {
    await Promise.all([
      env.SIGNAL_KV.put("BOT_STATS", JSON.stringify({ wins: 0, losses: 0, netPct: 0 })),
      env.SIGNAL_KV.put("SIGNAL_HISTORY", JSON.stringify([])),
      env.SIGNAL_KV.put("LAST_SIGNAL_ID", "1000"),
      ...SYMBOLS.map(sym => env.SIGNAL_KV.delete(`POS_${sym}`)),
      ...SYMBOLS.map(sym => env.SIGNAL_KV.delete(`COOLDOWN_${sym}`)),
      env.SIGNAL_KV.delete("LOSS_STREAK"),
      env.SIGNAL_KV.delete("PAUSE_STREAK"),
      env.SIGNAL_KV.delete(`DAILY_R_${new Date().toISOString().slice(0, 10)}`),
      env.SIGNAL_KV.delete(`WEEKLY_R_${weekKey()}`)
    ]);
  }

  const msg = `
🔄 <b>ریست کامل کارنامه و حافظه بات انجام شد!</b>
<blockquote>├ 📊 <b>آمار برد و باخت (/stats):</b> صفر شد (0 Win / 0 Loss)
├ 📜 <b>تاریخچه معاملات (/history):</b> پاکسازی شد
├ 📂 <b>پوزیشن‌های باز و قفل‌ها:</b> پاکسازی شد
└ 🔢 <b>شمارنده سیگنال‌ها:</b> بازنشانی به <code>#SIG-1000</code></blockquote>
✅ <i>از این لحظه فقط عملکرد نسخه سریع <b>v9.1 (5m/15m)</b> ثبت خواهد شد.</i>
`.trim();

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "🔎 اسکن بازار (/scan)", callback_data: "cmd_scan" },
        { text: "🏠 منوی اصلی", callback_data: "cmd_menu" }
      ]
    ]
  };

  await sendTelegramRaw(env, chatId, msg, replyMarkup);
}

/* =========================================================
   ۱۰. توابع دریافت دیتا و محاسبات ریاضی (Fast MACD 8,21,5 + StochRSI)
========================================================= */
async function fetchOKXFuturesData(coin) {
  let fundingRate = 0.0001, takerBuyRatio = 50.0, deltaPct = 0, oiChangePct = 0, flowBias = "NEUTRAL";
  try {
    const [fundRes, takerRes, oiRes] = await Promise.all([
      fetch(`https://www.okx.com/api/v5/public/funding-rate?instId=${coin}-USDT-SWAP`, { headers: BROWSER_HEADERS }),
      fetch(`https://www.okx.com/api/v5/rubik/stat/taker-volume?ccy=${coin}&instType=CONTRACTS&period=5m`, { headers: BROWSER_HEADERS }),
      fetch(`https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=${coin}&period=5m`, { headers: BROWSER_HEADERS })
    ]);
    if (fundRes.ok) {
      const fJson = await fundRes.json();
      if (fJson.data?.[0]) fundingRate = parseFloat(fJson.data[0].fundingRate) * 100;
    }
    if (takerRes.ok) {
      const tJson = await takerRes.json();
      const rows = tJson.data || [];   // [ts, sellVol, buyVol] — جدیدترین اول
      if (rows.length > 0) {
        const s0 = parseFloat(rows[0][1]) || 0, b0 = parseFloat(rows[0][2]) || 0;
        takerBuyRatio = (b0 / ((b0 + s0) || 1)) * 100;
        // دلتای تجمعی ۱۵ دقیقه اخیر (۳ باکت)
        let buy = 0, sell = 0;
        for (const r of rows.slice(0, 3)) { sell += parseFloat(r[1]) || 0; buy += parseFloat(r[2]) || 0; }
        deltaPct = ((buy - sell) / ((buy + sell) || 1)) * 100;
      }
    }
    if (oiRes.ok) {
      const oJson = await oiRes.json();
      const rows = oJson.data || [];   // [ts, oi, vol] — جدیدترین اول
      if (rows.length >= 7) {
        const now = parseFloat(rows[0][1]), before = parseFloat(rows[6][1]);
        if (before > 0) oiChangePct = ((now - before) / before) * 100;   // تغییر ۳۰ دقیقه
      }
    }
    if (deltaPct >= 3) flowBias = "LONG";
    else if (deltaPct <= -3) flowBias = "SHORT";
  } catch (e) {}
  return {
    fundingRateStr: `${fundingRate >= 0 ? "+" : ""}${fundingRate.toFixed(4)}%`,
    fundingRate,
    takerBuyRatio: parseFloat(takerBuyRatio.toFixed(1)),
    deltaPct: parseFloat(deltaPct.toFixed(1)),
    oiChangePct: parseFloat(oiChangePct.toFixed(2)),
    flowBias
  };
}

async function fetchLivePrices() {
  const prices = {};
  try {
    const res = await fetch("https://www.okx.com/api/v5/market/tickers?instType=SPOT", { headers: BROWSER_HEADERS });
    if (res.ok) {
      const json = await res.json();
      if (json.data) {
        for (const item of json.data) {
          const sym = item.instId.replace("-", "");
          if (SYMBOLS.includes(sym)) prices[sym] = parseFloat(item.last);
        }
        if (Object.keys(prices).length === SYMBOLS.length) return prices;
      }
    }
  } catch (e) {}

  for (const sym of SYMBOLS) {
    if (!prices[sym]) {
      const kl = await fetchKlines(sym, "5m", 55);
      if (kl.length) prices[sym] = kl[kl.length - 1].close;
    }
  }
  return prices;
}

async function fetchKlines(symbol, interval, limit = 100) {
  const coin = symbol.replace("USDT", "");
  const okxBar = interval === "1h" ? "1H" : interval;                     // 1m / 5m / 15m
  const kcType = interval === "1h" ? "1hour" : interval.replace("m", "min");
  const minLen = Math.min(50, limit);

  try {
    const res = await fetch(`https://www.okx.com/api/v5/market/candles?instId=${coin}-USDT&bar=${okxBar}&limit=${limit}`, { headers: BROWSER_HEADERS });
    if (res.ok) {
      const json = await res.json();
      if (json.data && json.data.length >= minLen) {
        return json.data.reverse().map(d => ({
          ts: parseInt(d[0], 10), open: parseFloat(d[1]), high: parseFloat(d[2]), low: parseFloat(d[3]), close: parseFloat(d[4]), volume: parseFloat(d[5])
        }));
      }
    }
  } catch (e) {}

  try {
    const res = await fetch(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${coin}_USDT&interval=${interval}&limit=${limit}`, { headers: BROWSER_HEADERS });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length >= minLen) {
        return data.map(d => ({
          ts: parseInt(d[0], 10) * 1000, open: parseFloat(d[5]), high: parseFloat(d[3]), low: parseFloat(d[4]), close: parseFloat(d[2]), volume: parseFloat(d[6])
        }));
      }
    }
  } catch (e) {}

  try {
    const res = await fetch(`https://api.kucoin.com/api/v1/market/candles?type=${kcType}&symbol=${coin}-USDT`, { headers: BROWSER_HEADERS });
    if (res.ok) {
      const json = await res.json();
      if (json.data && json.data.length >= minLen) {
        return json.data.slice(0, limit).reverse().map(d => ({
          ts: parseInt(d[0], 10) * 1000, open: parseFloat(d[1]), close: parseFloat(d[2]), high: parseFloat(d[3]), low: parseFloat(d[4]), volume: parseFloat(d[5])
        }));
      }
    }
  } catch (e) {}
  return [];
}

// بالاترین/پایین‌ترین قیمت از زمان آخرین بررسی (کندل‌های ۱ دقیقه)
async function fetchPriceRangeSince(symbol, sinceMs) {
  const minutes = Math.ceil((Date.now() - sinceMs) / 60000) + 2;
  const limit = Math.min(100, Math.max(3, minutes));
  const kl = await fetchKlines(symbol, "1m", limit);
  if (kl.length) {
    const relevant = kl.filter(k => k.ts + 60000 > sinceMs);
    const set = relevant.length ? relevant : kl.slice(-1);
    return {
      high: Math.max(...set.map(k => k.high)),
      low: Math.min(...set.map(k => k.low)),
      last: kl[kl.length - 1].close
    };
  }
  const prices = await fetchLivePrices();
  const p = prices[symbol];
  return p ? { high: p, low: p, last: p } : null;
}

// VWAP لنگرشده به شروع سشن روزانه UTC (در صورت کمبود کندل، VWAP غلتان ۴ ساعته)
function calcSessionVWAPBands(klines) {
  const lastTs = klines[klines.length - 1]?.ts;
  let set = klines.slice(-48);
  if (lastTs) {
    const dayStart = Math.floor(lastTs / 86400000) * 86400000;
    const session = klines.filter(k => k.ts >= dayStart);
    if (session.length >= 12) set = session;
  }
  const vwap = calcVWAPBands(set).vwap;
  let vol = 0, varSum = 0;
  for (const k of set) { const tp = (k.high + k.low + k.close) / 3; varSum += k.volume * (tp - vwap) ** 2; vol += k.volume; }
  return { vwap, sd: vol > 0 ? Math.sqrt(varSum / vol) : 0 };
}

function calcSessionVWAP(klines) {
  const lastTs = klines[klines.length - 1]?.ts;
  let set = klines.slice(-48);
  if (lastTs) {
    const dayStart = Math.floor(lastTs / 86400000) * 86400000;
    const session = klines.filter(k => k.ts >= dayStart);
    if (session.length >= 12) set = session;
  }
  return calcVWAPBands(set).vwap;
}

// محاسبه مکدی سریع مخصوص اسکلپ کریپتو: Fast MACD (8, 21, 5)
function calcFastMACD(closes, fast = 8, slow = 21, sig = 5) {
  const eFast = calcEMASeries(closes, fast);
  const eSlow = calcEMASeries(closes, slow);
  const macdLine = eFast.map((v, i) => v - eSlow[i]);
  const sigLine = calcEMASeries(macdLine, sig);
  const hist = macdLine.map((v, i) => v - sigLine[i]);
  const len = closes.length;
  // تعداد کندل از آخرین تغییر علامت هیستوگرام (تشخیص شتاب تازه در برابر شتاب خسته)
  let barsSinceCross = 0;
  for (let i = len - 1; i > 0 && Math.sign(hist[i]) === Math.sign(hist[i - 1]); i--) barsSinceCross++;
  return {
    macd: macdLine[len - 1],
    signal: sigLine[len - 1],
    histogram: hist[len - 1],
    prevHistogram: hist[len - 2],
    barsSinceCross
  };
}

function calcStochRSI(rsiSeries, period = 14) {
  const s = rsiSeries.slice(-period);
  const min = Math.min(...s), max = Math.max(...s);
  return max === min ? 50 : ((rsiSeries[rsiSeries.length - 1] - min) / (max - min)) * 100;
}

function calcBollingerBands(closes, period = 20, mult = 2) {
  const slice = closes.slice(-period), mean = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period);
  return { upper: mean + mult * std, middle: mean, lower: mean - mult * std, bandwidth: ((mean + mult * std) - (mean - mult * std)) / mean };
}

function calcWilderADX(klines, period = 14) {
  if (klines.length < period * 2) return 20;
  let tr = [], pdm = [], mdm = [];
  for (let i = 1; i < klines.length; i++) {
    const up = klines[i].high - klines[i - 1].high;
    const down = klines[i - 1].low - klines[i].low;
    pdm.push(up > down && up > 0 ? up : 0);
    mdm.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(klines[i].high - klines[i].low, Math.abs(klines[i].high - klines[i - 1].close), Math.abs(klines[i].low - klines[i - 1].close)));
  }
  let sTR = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let sPDM = pdm.slice(0, period).reduce((a, b) => a + b, 0);
  let sMDM = mdm.slice(0, period).reduce((a, b) => a + b, 0);
  let dxList = [];
  for (let i = period; i < tr.length; i++) {
    sTR = sTR - (sTR / period) + tr[i];
    sPDM = sPDM - (sPDM / period) + pdm[i];
    sMDM = sMDM - (sMDM / period) + mdm[i];
    const pDI = sTR === 0 ? 0 : (sPDM / sTR) * 100;
    const mDI = sTR === 0 ? 0 : (sMDM / sTR) * 100;
    const sum = pDI + mDI;
    dxList.push(sum === 0 ? 0 : (Math.abs(pDI - mDI) / sum) * 100);
  }
  if (dxList.length < period) return dxList[dxList.length - 1] || 20;
  let adx = dxList.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxList.length; i++) adx = ((adx * (period - 1)) + dxList[i]) / period;
  return adx;
}

function calcVWAPBands(klines) {
  let pv = 0, vol = 0;
  for (const k of klines) {
    const tp = (k.high + k.low + k.close) / 3;
    pv += tp * k.volume;
    vol += k.volume;
  }
  const vwap = vol === 0 ? klines[klines.length - 1].close : pv / vol;
  return { vwap };
}

function calcRSISeries(closes, period = 14) {
  const rsiArr = new Array(closes.length).fill(50);
  if (closes.length <= period) return rsiArr;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  rsiArr[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    rsiArr[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return rsiArr;
}

function calcSupertrend(klines, period = 10, multiplier = 2.2) {
  let trs = [0];
  for (let i = 1; i < klines.length; i++) trs.push(Math.max(klines[i].high - klines[i].low, Math.abs(klines[i].high - klines[i - 1].close), Math.abs(klines[i].low - klines[i - 1].close)));
  let up = 0, low = 0, dir = "LONG", prevDir = "LONG";
  for (let i = period; i < klines.length; i++) {
    const atr = trs.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
    const hl2 = (klines[i].high + klines[i].low) / 2, bUp = hl2 + multiplier * atr, bLow = hl2 - multiplier * atr;
    up = (bUp < up || klines[i - 1].close > up) ? bUp : up;
    low = (bLow > low || klines[i - 1].close < low) ? bLow : low;
    prevDir = dir;
    if (klines[i].close > up) dir = "LONG"; else if (klines[i].close < low) dir = "SHORT";
  }
  return { direction: dir, justFlipped: dir !== prevDir };
}

function calcEMA(values, period) {
  const k = 2 / (period + 1);
  return values.reduce((ema, val, i) => (i === 0 ? val : val * k + ema * (1 - k)), values[0]);
}

function calcEMASeries(values, period) {
  const k = 2 / (period + 1);
  let res = [values[0]];
  for (let i = 1; i < values.length; i++) res.push(values[i] * k + res[i - 1] * (1 - k));
  return res;
}

function calcATR(klines, period = 14) {
  // [v9.1] Wilder's smoothed ATR (the standard definition) instead of a plain 14-bar average
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    trs.push(Math.max(klines[i].high - klines[i].low, Math.abs(klines[i].high - klines[i - 1].close), Math.abs(klines[i].low - klines[i - 1].close)));
  }
  if (trs.length < period) return trs.reduce((a, b) => a + b, 0) / (trs.length || 1);
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}

async function getTelegramCredentials(env) {
  // [v9.1] The old version wrote the token and chat id to KV on EVERY call (every message, every price check),
  // which burns the KV write quota and stores the bot token in plain KV. Now: read-only fallback for legacy values.
  let token = env.TELEGRAM_BOT_TOKEN;
  let chatId = env.TELEGRAM_CHAT_ID || FALLBACK_CHAT_ID;
  if (env.SIGNAL_KV) {
    if (!token) token = await env.SIGNAL_KV.get("SAVED_BOT_TOKEN");
    if (!env.TELEGRAM_CHAT_ID) {
      const savedChat = await env.SIGNAL_KV.get("SAVED_CHAT_ID");
      if (savedChat) chatId = savedChat;
    }
  }
  return { token, chatId };
}

// [v9.1] Only the main chat (+ optional TELEGRAM_ALLOWED_CHAT_IDS, comma separated) may run commands.
// Without this, anyone who finds the bot could run /reset, /clear or /force.
async function isAuthorizedChat(env, chatId) {
  const { chatId: main } = await getTelegramCredentials(env);
  const extra = String(env.TELEGRAM_ALLOWED_CHAT_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
  return [String(main), ...extra].includes(String(chatId));
}

async function answerCallback(env, callbackQueryId, text) {
  const { token } = await getTelegramCredentials(env);
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text })
  });
}

async function sendTelegramGlobal(env, text, replyMarkup = null, replyToMessageId = null) {
  const { token, chatId } = await getTelegramCredentials(env);
  if (!token || !chatId) return { ok: false };
  return await sendTelegramRaw(env, chatId, text, replyMarkup, replyToMessageId);
}

async function sendTelegramRaw(env, chatId, text, replyMarkup = null, replyToMessageId = null) {
  const { token, chatId: defaultChatId } = await getTelegramCredentials(env);
  if (!token) return { ok: false, error: "Missing Bot Token" };

  const payload = {
    chat_id: chatId || defaultChatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  if (replyToMessageId) {
    payload.reply_parameters = {
      message_id: replyToMessageId,
      allow_sending_without_reply: true
    };
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return await res.json();
}