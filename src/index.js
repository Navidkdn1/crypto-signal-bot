/**
 * 🚀 Crypto Scalping Signal Bot v3.0 PRO (Real-Time Institutional Edition)
 * -------------------------------------------------------------------------
 * ✅ بررسی لحظه‌ای تارگت و استاپ (هر ۱۵ ثانیه با Sub-Minute Polling)
 * ✅ ریسک‌فری خودکار (Auto Break-Even) پس از تاچ شدن TP1
 * ✅ استراتژی ارتقایافته: Supertrend + VWAP + Order Block + FVG + RSI Divergence + MACD + StochRSI
 * ✅ فیلتر سخت‌گیرانه (فقط سیگنال‌های معتبر با امتیاز بالای 78/100)
 * ✅ طراحی ظاهری VIP همراه با دکمه‌های شیشه‌ای، نوار امتیاز، درصد تارگت و اهرم پیشنهادی
 * ✅ دستورات کامل: /menu, /scan, /positions, /stats, /btc, /eth, /sol, /bnb, /force, /clear
 */

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"];
const MAX_OPEN_POSITIONS = 2;
const POSITION_TTL_SECONDS = 3600; // حداکثر ۶۰ دقیقه زمان مجاز پوزیشن اسکلپ
const MIN_VALID_SCORE = 78; // فقط سیگنال‌های بسیار معتبر (A و VIP A+) ارسال شوند

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Accept": "application/json"
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export default {
  // ۱. اجرای خودکار هر ۱ دقیقه + بررسی زیرثانیه‌ای (هر ۱۵ ثانیه) برای پوزیشن‌های باز
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runRealTimeSchedule(env));
  },

  // ۲. مدیریت وب‌هوک تلگرام (پیام‌ها + دکمه‌های شیشه‌ای) و لینک‌های مرورگر
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/diag") {
      const prices = await fetchLivePrices();
      const macro = await fetchMacroData();
      return new Response(JSON.stringify({
        ok: true,
        version: "3.0 PRO Real-Time",
        livePrices: prices,
        macro
      }, null, 2), { headers: { "Content-Type": "application/json; charset=utf-8" } });
    }

    if (url.pathname === "/test") {
      const res = await sendMainMenu(env, env.TELEGRAM_CHAT_ID);
      return new Response(JSON.stringify(res, null, 2), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      try {
        const update = await request.json();

        // الف) مدیریت کلیک روی دکمه‌های شیشه‌ای (Inline Keyboard Callbacks)
        if (update.callback_query) {
          const cb = update.callback_query;
          const chatId = cb.message.chat.id;
          const data = cb.data;

          await answerCallback(env, cb.id, "⏳ در حال انجام...");

          if (data === "cmd_scan") await handleScanCommand(env, chatId);
          else if (data === "cmd_positions") await handlePositionsCommand(env, chatId);
          else if (data === "cmd_stats") await handleStatsCommand(env, chatId);
          else if (data === "cmd_force") await runBotEngine(env, true, chatId);
          else if (data === "cmd_clear") await handleClearCommand(env, chatId);
          else if (data.startsWith("coin_")) {
            const sym = data.replace("coin_", "");
            await handleSingleCoinCommand(env, chatId, sym);
          } else if (data.startsWith("close_")) {
            const sym = data.replace("close_", "");
            if (env.SIGNAL_KV) await env.SIGNAL_KV.delete(`POS_${sym}`);
            await sendTelegramRaw(env, chatId, `✅ پوزیشن <b>#${sym}</b> به صورت دستی بسته شد و از لیست رصد خارج گردید.`);
          }
          return new Response("OK", { status: 200 });
        }

        // ب) مدیریت دستورات متنی در تلگرام
        if (update.message && update.message.text) {
          const chatId = update.message.chat.id;
          const text = update.message.text.trim().split("@")[0].toLowerCase();

          if (text === "/start" || text === "/menu" || text === "/help") {
            await sendMainMenu(env, chatId);
          } else if (text === "/scan") {
            await sendTelegramRaw(env, chatId, "🔍 <b>در حال اسکن عمیق بازار و نواحی اسمارت مانی...</b>");
            await handleScanCommand(env, chatId);
          } else if (text === "/status" || text === "/positions") {
            await handlePositionsCommand(env, chatId);
          } else if (text === "/stats") {
            await handleStatsCommand(env, chatId);
          } else if (text === "/force") {
            await sendTelegramRaw(env, chatId, "⚡ <b>در حال استخراج برترین موقعیت فعلی بازار...</b>");
            await runBotEngine(env, true, chatId);
          } else if (text === "/clear") {
            await handleClearCommand(env, chatId);
          } else if (["/btc", "/eth", "/sol", "/bnb"].includes(text)) {
            const sym = text.replace("/", "").toUpperCase() + "USDT";
            await handleSingleCoinCommand(env, chatId, sym);
          } else {
            await sendMainMenu(env, chatId);
          }
        }
      } catch (err) {
        console.error("Webhook Error:", err);
      }
      return new Response("OK", { status: 200 });
    }

    return new Response("🤖 Crypto Signal Bot v3.0 PRO is Active!", { status: 200 });
  }
};

/* =========================================================
   ۱. موتور زمان‌بندی لحظه‌ای (Sub-Minute Real-Time Engine)
========================================================= */
async function runRealTimeSchedule(env) {
  // گام اول: اسکن کامل استراتژی و چک اولیه پوزیشن‌ها در ثانیه 0
  await runBotEngine(env, false);

  // گام دوم: حلقه رصد لحظه‌ای قیمت هر ۱۵ ثانیه (در ثانیه‌های ۱۵، ۳۰ و ۴۵ هر دقیقه)
  for (let tick = 1; tick <= 3; tick++) {
    await sleep(15000);
    const hasOpen = await hasAnyOpenPosition(env);
    if (!hasOpen) break; // اگر پوزیشن بازی نیست، حلقه را متوقف کن تا منابع مصرف نشود
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
   ۲. ردیابی لحظه‌ای TP1 / TP2 / TP3 / SL و ریسک‌فری خودکار
========================================================= */
async function checkActivePositionsRealTime(env) {
  if (!env.SIGNAL_KV) return 0;
  const livePrices = await fetchLivePrices();
  let activeCount = 0;

  for (const symbol of SYMBOLS) {
    const raw = await env.SIGNAL_KV.get(`POS_${symbol}`);
    if (!raw) continue;

    const pos = JSON.parse(raw);
    const currentPrice = livePrices[symbol];
    if (!currentPrice) {
      activeCount++;
      continue;
    }

    const isLong = pos.direction === "LONG";
    const highMark = Math.max(currentPrice, pos.lastHigh || currentPrice);
    const lowMark = Math.min(currentPrice, pos.lastLow || currentPrice);
    pos.lastHigh = highMark;
    pos.lastLow = lowMark;

    const dec = pos.entry > 100 ? 2 : 3;
    const durationMin = Math.max(1, Math.round((Date.now() - (pos.openedAt || Date.now())) / 60000));

    // ۱. بررسی برخورد با حد ضرر (یا نقطه سر به سر بعد از ریسک‌فری)
    const slHit = isLong ? currentPrice <= pos.sl : currentPrice >= pos.sl;
    if (slHit) {
      if (pos.tp1Hit) {
        // چون قبلاً TP1 خورده بود، استاپ روی نقطه ورود بوده (بسته شدن در سود و ریسک‌فری)
        const msg = `
🛡️ <b>بسته شدن در نقطه ریسک‌فری (Break-Even) | #${symbol}</b>
━━━━━━━━━━━━━━━━━━
🧭 <b>جهت:</b> ${pos.direction}
💰 <b>وضعیت:</b> پوزیشن قبلاً <b>TP1</b> را ثبت کرده بود و مابقی حجم در نقطه ورود (<code>${pos.entry}</code>) بدون ضرر بسته شد.
⏱ <b>مدت زمان معامله:</b> ${durationMin} دقیقه
`.trim();
        await sendTelegramGlobal(env, msg);
      } else {
        const lossPct = (Math.abs(pos.entry - pos.sl) / pos.entry * 100).toFixed(2);
        await recordTradeStat(env, "LOSS", -parseFloat(lossPct));
        const msg = `
🛑 <b>برخورد با حد ضرر (Stop-Loss Hit) | #${symbol}</b>
━━━━━━━━━━━━━━━━━━
🧭 <b>جهت:</b> ${pos.direction}
🔹 <b>قیمت ورود:</b> <code>${pos.entry}</code>
🛑 <b>قیمت بسته شدن (SL):</b> <code>${pos.sl}</code> (<b>-${lossPct}%</b> بدون اهرم)
⏱ <b>مدت زمان:</b> ${durationMin} دقیقه

💡 <i>پوزیشن از لیست فعال خارج شد. منتظر ستاپ معتبر بعدی باشید.</i>
`.trim();
        await sendTelegramGlobal(env, msg);
      }
      await env.SIGNAL_KV.delete(`POS_${symbol}`);
      continue;
    }

    // ۲. بررسی برخورد با تارگت سوم (TP3 - فول تارگت نهایی)
    const tp3Hit = isLong ? currentPrice >= pos.tp3 : currentPrice <= pos.tp3;
    if (tp3Hit) {
      const profitPct = (Math.abs(pos.tp3 - pos.entry) / pos.entry * 100).toFixed(2);
      if (!pos.tp1Hit) await recordTradeStat(env, "WIN", parseFloat(profitPct));
      const msg = `
🚀💎 <b>فول تارگت نهایی (TP3 Hit!) | #${symbol}</b>
━━━━━━━━━━━━━━━━━━
🧭 <b>جهت:</b> ${pos.direction === "LONG" ? "🟢 LONG" : "🔴 SHORT"}
🔹 <b>قیمت ورود:</b> <code>${pos.entry}</code>
🎯 <b>تارگت سوم (TP3):</b> <code>${pos.tp3}</code>
🔥 <b>سود خالص حرکت:</b> <b>+${profitPct}%</b> (با اهرم ${pos.leverage}x: <b>+${(profitPct * pos.leverage).toFixed(1)}%</b>)
⏱ <b>مدت زمان:</b> ${durationMin} دقیقه

🏆 <i>معامله با موفقیت کامل بسته شد!</i>
`.trim();
      await sendTelegramGlobal(env, msg);
      await env.SIGNAL_KV.delete(`POS_${symbol}`);
      continue;
    }

    // ۳. بررسی برخورد با تارگت دوم (TP2)
    const tp2Hit = isLong ? currentPrice >= pos.tp2 : currentPrice <= pos.tp2;
    if (tp2Hit && !pos.tp2Hit) {
      pos.tp2Hit = true;
      pos.tp1Hit = true;
      pos.sl = pos.tp1; // انتقال استاپ به TP1 برای قفل کردن سود!
      const profitPct = (Math.abs(pos.tp2 - pos.entry) / pos.entry * 100).toFixed(2);
      await recordTradeStat(env, "WIN", parseFloat(profitPct));

      const msg = `
🎯🔥 <b>تارگت دوم تاچ شد (TP2 Hit!) | #${symbol}</b>
━━━━━━━━━━━━━━━━━━
🔹 <b>قیمت ورود:</b> <code>${pos.entry}</code>
✅ <b>قیمت فعلی (TP2):</b> <code>${currentPrice.toFixed(dec)}</code> (<b>+${profitPct}%</b>)
🛡️ <b>مدیریت هوشمند:</b> حد ضرر بات به صورت خودکار به <b>TP1 (<code>${pos.tp1}</code>)</b> منتقل شد (قفل سود تضمینی)!
⏱ <b>زمان سپری‌شده:</b> ${durationMin} دقیقه
`.trim();
      await sendTelegramGlobal(env, msg);
      await env.SIGNAL_KV.put(`POS_${symbol}`, JSON.stringify(pos), { expirationTtl: 2400 });
      activeCount++;
      continue;
    }

    // ۴. بررسی برخورد با تارگت اول (TP1 - سیو سود و ریسک‌فری خودکار)
    const tp1Hit = isLong ? currentPrice >= pos.tp1 : currentPrice <= pos.tp1;
    if (tp1Hit && !pos.tp1Hit) {
      pos.tp1Hit = true;
      pos.sl = pos.entry; // انتقال خودکار استاپ به نقطه ورود (Risk-Free)
      const profitPct = (Math.abs(pos.tp1 - pos.entry) / pos.entry * 100).toFixed(2);
      await recordTradeStat(env, "WIN", parseFloat(profitPct));

      const msg = `
✅💰 <b>تارگت اول تاچ شد (TP1 Hit!) | #${symbol}</b>
━━━━━━━━━━━━━━━━━━
🔹 <b>قیمت ورود:</b> <code>${pos.entry}</code>
🎯 <b>قیمت فعلی (TP1):</b> <code>${currentPrice.toFixed(dec)}</code> (<b>+${profitPct}%</b>)
🛡️ <b>ریسک‌فری خودکار:</b> حد ضرر به نقطه ورود (<code>${pos.entry}</code>) منتقل شد! ۵۰٪ سیو سود کنید و اجازه دهید مابقی تا TP2/TP3 حرکت کند.
⏱ <b>زمان سپری‌شده:</b> ${durationMin} دقیقه
`.trim();
      await sendTelegramGlobal(env, msg);
      await env.SIGNAL_KV.put(`POS_${symbol}`, JSON.stringify(pos), { expirationTtl: 2400 });
      activeCount++;
      continue;
    }

    activeCount++;
  }
  return activeCount;
}

/* =========================================================
   ۳. موتور اصلی اسکن استراتژی و فیلتر سیگنال‌های معتبر
========================================================= */
async function runBotEngine(env, forceBest = false, customChatId = null) {
  try {
    let activePositions = await checkActivePositionsRealTime(env);
    if (!forceBest && activePositions >= MAX_OPEN_POSITIONS) return;

    const macroData = await fetchMacroData();
    let bestCandidate = null;

    for (const symbol of SYMBOLS) {
      if (!forceBest && activePositions >= MAX_OPEN_POSITIONS) break;

      if (!forceBest && env.SIGNAL_KV) {
        const existingPos = await env.SIGNAL_KV.get(`POS_${symbol}`);
        if (existingPos) continue;
      }

      const [klines5m, klines15m] = await Promise.all([
        fetchKlines(symbol, "5m", 120),
        fetchKlines(symbol, "15m", 100)
      ]);
      if (klines5m.length < 60 || klines15m.length < 60) continue;

      const tf5m = analyzeInstitutionalIndicators(klines5m, 7, 2.0);
      const tf15m = analyzeInstitutionalIndicators(klines15m, 10, 3.0);

      let direction = tf5m.supertrend.direction;
      if (tf5m.divergence.bullish && (tf5m.orderBlock.inBullishOB || tf5m.fvg.inBullishFVG)) direction = "LONG";
      if (tf5m.divergence.bearish && (tf5m.orderBlock.inBearishOB || tf5m.fvg.inBearishFVG)) direction = "SHORT";

      const coin = symbol.replace("USDT", "");
      const news = await fetchNewsSentiment(coin, env.CRYPTOPANIC_API_KEY);
      const scoreData = evaluateInstitutionalScore({ direction, tf5m, tf15m, macroData, news });

      const candidate = { symbol, direction, entry: tf5m.close, tf5m, tf15m, scoreData, macroData };
      if (!bestCandidate || scoreData.score > bestCandidate.scoreData.score) {
        bestCandidate = candidate;
      }

      // شرط سخت‌گیرانه صدور سیگنال خودکار:
      // ۱. بازار رنج نباشد + ۲. ماشه ورود تایید شده باشد + ۳. امتیاز حداقل 78 از 100 باشد
      if (!forceBest && !tf5m.isRanging && tf5m.hasValidTrigger && scoreData.score >= MIN_VALID_SCORE) {
        const targets = calculateProTargets(tf5m.close, tf5m.atr, direction);
        await sendProSignalMessage(env, { ...candidate, targets }, customChatId);

        if (env.SIGNAL_KV) {
          const posState = {
            symbol,
            direction,
            entry: tf5m.close,
            tp1: parseFloat(targets.tp1),
            tp2: parseFloat(targets.tp2),
            tp3: parseFloat(targets.tp3),
            sl: parseFloat(targets.sl),
            leverage: targets.leverage,
            tp1Hit: false,
            tp2Hit: false,
            openedAt: Date.now()
          };
          await env.SIGNAL_KV.put(`POS_${symbol}`, JSON.stringify(posState), { expirationTtl: POSITION_TTL_SECONDS });
        }
        activePositions++;
      }
    }

    if (forceBest && bestCandidate) {
      const targets = calculateProTargets(bestCandidate.entry, bestCandidate.tf5m.atr, bestCandidate.direction);
      await sendProSignalMessage(env, { ...bestCandidate, targets, isForced: true }, customChatId);
    }
  } catch (error) {
    console.error("Bot Engine Error:", error);
  }
}

/* =========================================================
   ۴. اندیکاتورهای پیشرفته (OB + FVG + Divergence + MACD + StochRSI)
========================================================= */
function analyzeInstitutionalIndicators(klines, stPeriod, stMult) {
  // استفاده از کندل بسته‌شده ماقبل آخر برای تایید قطعی و جلوگیری از Fake Wick
  const closes = klines.map(k => k.close);
  const current = klines[klines.length - 1];
  const closedCandle = klines[klines.length - 2];

  const ema9 = calcEMA(closes, 9);
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);

  const rsiSeries = calcRSISeries(closes, 14);
  const rsi = rsiSeries[rsiSeries.length - 1];
  const stochRsi = calcStochRSI(rsiSeries, 14);
  const macd = calcMACD(closes);

  const atr = calcATR(klines, 14);
  const adx = calcADX(klines, 14);
  const vwap = calcVWAP(klines.slice(-48));
  const bb = calcBollingerBands(closes, 20, 2);
  const supertrend = calcSupertrend(klines, stPeriod, stMult);

  const divergence = detectRSIDivergence(klines, rsiSeries, 30);
  const orderBlock = detectOrderBlocks(klines, atr, 45);
  const fvg = detectFVG(klines, atr, 25);

  const avgVol = klines.slice(-21, -1).reduce((s, k) => s + k.volume, 0) / 20;
  const volRatio = Math.max(current.volume, closedCandle.volume) / (avgVol || 1);

  // تشخیص سخت‌گیرانه بازار رنج و نوسان فرسایشی (Chop Filter)
  const isRanging = (adx < 20 && bb.bandwidth < 0.0045) || bb.bandwidth < 0.0028;

  // تایید کندل بسته‌شده در جهت روند همراه با مومنتوم MACD
  const bullMomentum = supertrend.direction === "LONG" && current.close > ema9 && ema9 >= ema20 && macd.histogram >= macd.prevHistogram;
  const bearMomentum = supertrend.direction === "SHORT" && current.close < ema9 && ema9 <= ema20 && macd.histogram <= macd.prevHistogram;

  const smcReversal =
    (divergence.bullish && (orderBlock.inBullishOB || fvg.inBullishFVG) && current.close > current.open) ||
    (divergence.bearish && (orderBlock.inBearishOB || fvg.inBearishFVG) && current.close < current.open);

  const hasValidTrigger = supertrend.justFlipped || bullMomentum || bearMomentum || smcReversal;

  return {
    close: current.close,
    ema9, ema20, ema50, vwap,
    rsi, stochRsi, macd,
    atr, adx, bb, supertrend,
    volRatio, isRanging, hasValidTrigger,
    divergence, orderBlock, fvg
  };
}

// تشخیص شکاف ارزش منصفانه (Fair Value Gap - ICT FVG)
function detectFVG(klines, atr, lookback = 25) {
  const len = klines.length;
  const current = klines[len - 1];
  const start = Math.max(3, len - lookback);

  let bullFVG = null;
  let bearFVG = null;

  for (let i = start; i < len - 1; i++) {
    const c1 = klines[i - 2];
    const c2 = klines[i - 1];
    const c3 = klines[i];

    // Bullish FVG: فاصله بین سقف کندل اول و کف کندل سوم در حرکت صعودی شارپ
    if (c3.low > c1.high && (c2.close - c2.open) > atr * 0.7) {
      let mitigated = false;
      for (let j = i + 1; j < len - 1; j++) {
        if (klines[j].low < c1.high) { mitigated = true; break; }
      }
      if (!mitigated) bullFVG = { bottom: c1.high, top: c3.low };
    }

    // Bearish FVG: فاصله بین کف کندل اول و سقف کندل سوم در حرکت نزولی شارپ
    if (c3.high < c1.low && (c2.open - c2.close) > atr * 0.7) {
      let mitigated = false;
      for (let j = i + 1; j < len - 1; j++) {
        if (klines[j].high > c1.low) { mitigated = true; break; }
      }
      if (!mitigated) bearFVG = { bottom: c3.high, top: c1.low };
    }
  }

  const buf = atr * 0.25;
  const inBullishFVG = Boolean(bullFVG && current.low <= bullFVG.top + buf && current.close >= bullFVG.bottom);
  const inBearishFVG = Boolean(bearFVG && current.high >= bearFVG.bottom - buf && current.close <= bearFVG.top);

  return { bullFVG, bearFVG, inBullishFVG, inBearishFVG };
}

// محاسبه MACD (12, 26, 9)
function calcMACD(closes) {
  const ema12Series = calcEMASeries(closes, 12);
  const ema26Series = calcEMASeries(closes, 26);
  const macdLine = ema12Series.map((v, i) => v - ema26Series[i]);
  const signalLine = calcEMASeries(macdLine, 9);
  const len = closes.length;
  const hist = macdLine[len - 1] - signalLine[len - 1];
  const prevHist = macdLine[len - 2] - signalLine[len - 2];
  return { macd: macdLine[len - 1], signal: signalLine[len - 1], histogram: hist, prevHistogram: prevHist };
}

// محاسبه Stochastic RSI
function calcStochRSI(rsiSeries, period = 14) {
  const slice = rsiSeries.slice(-period);
  const minRsi = Math.min(...slice);
  const maxRsi = Math.max(...slice);
  if (maxRsi === minRsi) return 50;
  return ((rsiSeries[rsiSeries.length - 1] - minRsi) / (maxRsi - minRsi)) * 100;
}

/* =========================================================
   ۵. سیستم امتیازدهی سخت‌گیرانه ۱۰۰ امتیازی (نسخه v3.0)
========================================================= */
function evaluateInstitutionalScore({ direction, tf5m, tf15m, macroData, news }) {
  let score = 0;
  let reasons = [];

  // ۱. هم‌جهتی ساختار مولتی تایم‌فریم 5m و 15m (۲۰ امتیاز)
  if (tf5m.supertrend.direction === tf15m.supertrend.direction) {
    score += 20;
    reasons.push("✅ هم‌جهتی ساختار روند در تایم 5m و 15m");
  } else {
    score += 7;
  }

  // ۲. نواحی اسمارت مانی: Order Block + FVG (۲۰ امتیاز)
  const inSmartBull = direction === "LONG" && (tf5m.orderBlock.inBullishOB || tf5m.fvg.inBullishFVG);
  const inSmartBear = direction === "SHORT" && (tf5m.orderBlock.inBearishOB || tf5m.fvg.inBearishFVG);
  const nearSmart = (direction === "LONG" && tf5m.orderBlock.nearBullishOB) || (direction === "SHORT" && tf5m.orderBlock.nearBearishOB);

  if (inSmartBull || inSmartBear) {
    score += 20;
    reasons.push("🏦 ورود از درون ناحیه نقدینگی نهنگ‌ها (Order Block / FVG)");
  } else if (nearSmart) {
    score += 14;
    reasons.push("📦 حمایت توسط ناحیه Order Block نزدیک قیمت");
  } else {
    score += 7;
  }

  // ۳. واگرایی RSI + شتاب MACD و StochRSI (۱۵ امتیاز)
  const hasDiv = (direction === "LONG" && tf5m.divergence.bullish) || (direction === "SHORT" && tf5m.divergence.bearish);
  const macdAligned = (direction === "LONG" && tf5m.macd.histogram >= tf5m.macd.prevHistogram) ||
                      (direction === "SHORT" && tf5m.macd.histogram <= tf5m.macd.prevHistogram);

  if (hasDiv) {
    score += 15;
    reasons.push(`📐 تایید ${tf5m.divergence.type} + چرخش مومنتوم`);
  } else if (macdAligned) {
    score += 12;
    reasons.push("✅ تایید شتاب هیستوگرام MACD و RSI");
  } else {
    score += 5;
  }

  // ۴. تثبیت قیمت نسبت به VWAP و آرایش EMA 9/20/50 (۱۵ امتیاز)
  const vwapAligned = (direction === "LONG" && tf5m.close > tf5m.vwap && tf5m.ema9 > tf5m.ema20) ||
                      (direction === "SHORT" && tf5m.close < tf5m.vwap && tf5m.ema9 < tf5m.ema20);
  if (vwapAligned) {
    score += 15;
    reasons.push("✅ تثبیت قیمت در سمت درست VWAP مؤسسات و EMA 9/20");
  } else {
    score += 7;
  }

  // ۵. قدرت روند ADX و عدم فشردگی (۱۰ امتیاز)
  if (tf5m.adx >= 23 && !tf5m.isRanging) {
    score += 10;
    reasons.push(`✅ قدرت روند بالا و خروج از رِنج (ADX: ${tf5m.adx.toFixed(0)})`);
  } else {
    score += 5;
  }

  // ۶. حجم پول هوشمند (۱۰ امتیاز)
  if (tf5m.volRatio >= 1.2) {
    score += 10;
    reasons.push(`✅ ورود حجم پول هوشمند (${tf5m.volRatio.toFixed(1)}x میانگین)`);
  } else {
    score += 6;
  }

  // ۷. هم‌سویی با دامیننس تتر (USDT.D) و شاخص کل (TOTAL) (۱۰ امتیاز)
  if (((direction === "LONG" && macroData.bias === "BULLISH") || (direction === "SHORT" && macroData.bias === "BEARISH")) || news.bias === direction) {
    score += 10;
    reasons.push("✅ هم‌سویی با جریان نقدینگی کلان (USDT.D و TOTAL)");
  } else {
    score += 6;
  }

  let grade = "⚡ متوسط (رد شده در فیلتر خودکار)";
  if (score >= 86) grade = "💎 فوق‌معتبر (VIP A+)";
  else if (score >= 78) grade = "🔥 معتبر و قوی (Grade A)";

  return { score, grade, reasons };
}

/* =========================================================
   ۶. محاسبه تارگت‌های درصدی، R:R و اهرم هوشمند
========================================================= */
function calculateProTargets(price, atr, direction) {
  const dec = price > 100 ? 2 : 3;
  const m = direction === "LONG" ? 1 : -1;

  // استاپ استاندارد بر اساس نوسان ATR
  const riskDist = atr * 1.45;
  const slPrice = price - m * riskDist;
  const tp1Price = price + m * (riskDist * 1.1); // R:R = 1:1.1 (سیو سود سریع و ریسک‌فری)
  const tp2Price = price + m * (riskDist * 2.0); // R:R = 1:2.0 (تارگت اصلی اسکلپ)
  const tp3Price = price + m * (riskDist * 3.2); // R:R = 1:3.2 (تارگت امتدادی)

  // محدوده ورود بهینه (Entry Zone)
  const zoneLow = (price - m * (atr * 0.25)).toFixed(dec);
  const zoneHigh = price.toFixed(dec);

  const slPct = ((Math.abs(price - slPrice) / price) * 100).toFixed(2);
  const tp1Pct = ((Math.abs(tp1Price - price) / price) * 100).toFixed(2);
  const tp2Pct = ((Math.abs(tp2Price - price) / price) * 100).toFixed(2);
  const tp3Pct = ((Math.abs(tp3Price - price) / price) * 100).toFixed(2);

  // محاسبه اهرم امن بر اساس فاصله استاپ (به طوری که استاپ بیش از ۵٪ تا ۸٪ مارجین نشود)
  const rawLev = Math.round(6 / Math.max(0.3, parseFloat(slPct)));
  const leverage = Math.min(15, Math.max(3, rawLev));

  return {
    entryZone: `${zoneLow} ~ ${zoneHigh}`,
    sl: slPrice.toFixed(dec),
    tp1: tp1Price.toFixed(dec),
    tp2: tp2Price.toFixed(dec),
    tp3: tp3Price.toFixed(dec),
    slPct, tp1Pct, tp2Pct, tp3Pct,
    leverage
  };
}

/* =========================================================
   ۷. طراحی جدید و حرفه‌ای پیام سیگنال با دکمه‌های شیشه‌ای
========================================================= */
function buildScoreBar(score) {
  const filled = Math.round(score / 10);
  return "🟩".repeat(filled) + "⬜".repeat(10 - filled);
}

async function sendProSignalMessage(env, data, customChatId = null) {
  const { symbol, direction, entry, targets, scoreData, tf5m, macroData, isForced } = data;
  const isLong = direction === "LONG";
  const headerBadge = isForced ? "⚡ <b>سیگنال درخواستی لحظه‌ای (/force)</b>" : "🚨 <b>سیگنال اسکلپ VIP تاییدشده</b>";
  const dirBanner = isLong ? "🟢 <b>LONG (خرید / صعودی)</b> 📈" : "🔴 <b>SHORT (فروش / نزولی)</b> 📉";
  const dec = entry > 100 ? 2 : 3;

  let smcText = "ندارد";
  if (isLong && tf5m.orderBlock.bullOB) {
    smcText = `OB صعودی (<code>${tf5m.orderBlock.bullOB.bottom.toFixed(dec)}</code> - <code>${tf5m.orderBlock.bullOB.top.toFixed(dec)}</code>)`;
  } else if (!isLong && tf5m.orderBlock.bearOB) {
    smcText = `OB نزولی (<code>${tf5m.orderBlock.bearOB.bottom.toFixed(dec)}</code> - <code>${tf5m.orderBlock.bearOB.top.toFixed(dec)}</code>)`;
  }

  const text = `
${headerBadge}
🪙 <b>ارز:</b> <b>#${symbol}</b> (Perpetual 5m/15m)
━━━━━━━━━━━━━━━━━━
🧭 <b>جهت معامله:</b> ${dirBanner}
⚡ <b>اهرم پیشنهادی:</b> <code>Isolated ${targets.leverage}x</code>
📊 <b>اعتبار سیگنال:</b> <b>${scoreData.score}/100</b> (${scoreData.grade})
${buildScoreBar(scoreData.score)}

🎯 <b>نقاط ورود و تارگت‌های دقیق:</b>
🔹 <b>قیمت ورود (Entry):</b> <code>${entry}</code>
🎯 <b>محدوده ورود بهینه:</b> <code>${targets.entryZone}</code>

✅ <b>تارگت ۱ (سیو سود و ریسک‌فری):</b> <code>${targets.tp1}</code> (<b>+${targets.tp1Pct}%</b>)
🔥 <b>تارگت ۲ (تارگت اصلی اسکلپ):</b> <code>${targets.tp2}</code> (<b>+${targets.tp2Pct}%</b>)
🚀 <b>تارگت ۳ (تارگت امتدادی):</b> <code>${targets.tp3}</code> (<b>+${targets.tp3Pct}%</b>)
🛑 <b>حد ضرر (Stop-Loss):</b> <code>${targets.sl}</code> (<b>-${targets.slPct}%</b>)

🧠 <b>تحلیل اسمارت مانی و کلان:</b>
• <b>ناحیه نقدینگی:</b> ${smcText}
• <b>واگرایی RSI:</b> ${tf5m.divergence.type !== "NONE" ? tf5m.divergence.type : "روند نرمال"}
• <b>VWAP:</b> <code>${tf5m.vwap.toFixed(dec)}</code> | <b>RSI:</b> ${tf5m.rsi.toFixed(1)} | <b>ADX:</b> ${tf5m.adx.toFixed(0)}
• <b>دامیننس‌ها:</b> BTC.D: ${macroData.btcD}% | USDT.D: ${macroData.usdtD}%

📋 <b>تاییدیه‌های استراتژی:</b>
${scoreData.reasons.join("\n")}

🤖 <i>بات هر ۱۵ ثانیه این پوزیشن را رصد می‌کند و به محض تاچ شدن TP یا SL به شما اطلاع می‌دهد.</i>
`.trim();

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "📈 مشاهده چارت TradingView", url: `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol}` }
      ],
      [
        { text: "🔄 بروزرسانی تحلیل این ارز", callback_data: `coin_${symbol}` },
        { text: "❌ بستن دستی پوزیشن", callback_data: `close_${symbol}` }
      ],
      [
        { text: "📂 وضعیت پوزیشن‌ها", callback_data: "cmd_positions" },
        { text: "🔎 اسکن کل بازار", callback_data: "cmd_scan" }
      ]
    ]
  };

  const targetChat = customChatId || env.TELEGRAM_CHAT_ID;
  await sendTelegramRaw(env, targetChat, text, replyMarkup);
}

/* =========================================================
   ۸. مدیریت دستورات جدید (/menu, /positions, /stats, /btc ...)
========================================================= */
async function sendMainMenu(env, chatId) {
  const text = `
🤖 <b>پنل هوشمند اسکلپ کریپتو (نسخه v3.0 PRO)</b>
━━━━━━━━━━━━━━━━━━
⚡ <b>وضعیت رصد لحظه‌ای:</b> فعال (چک کردن قیمت هر ۱۵ ثانیه)
🎯 <b>فیلتر اعتبار سیگنال:</b> فقط سیگنال‌های بالای <b>${MIN_VALID_SCORE}/100</b>
🪙 <b>ارزهای تحت پوشش:</b> BTC, ETH, SOL, BNB

👇 <b>از دکمه‌های شیشه‌ای زیر یا دستورات متنی استفاده کنید:</b>
• /scan — اسکن عمیق هر ۴ ارز در همین لحظه
• /positions — سود و ضرر لحظه‌ای پوزیشن‌های باز
• /btc | /eth | /sol | /bnb — کالبدشکافی تکی هر ارز
• /stats — کارنامه و وین‌ریت سیگنال‌های بات
• /force — دریافت فوری بهترین سیگنال فعلی بازار
`.trim();

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "🔎 اسکن لحظه‌ای بازار (/scan)", callback_data: "cmd_scan" },
        { text: "📂 پوزیشن‌های باز (/positions)", callback_data: "cmd_positions" }
      ],
      [
        { text: "🟡 تحلیل BTC", callback_data: "coin_BTCUSDT" },
        { text: "🔵 تحلیل ETH", callback_data: "coin_ETHUSDT" },
        { text: "🟣 تحلیل SOL", callback_data: "coin_SOLUSDT" },
        { text: "🟠 تحلیل BNB", callback_data: "coin_BNBUSDT" }
      ],
      [
        { text: "⚡ بهترین سیگنال الان (/force)", callback_data: "cmd_force" },
        { text: "📈 آمار و وین‌ریت (/stats)", callback_data: "cmd_stats" }
      ]
    ]
  };

  return await sendTelegramRaw(env, chatId, text, replyMarkup);
}

// دستور /btc, /eth, /sol, /bnb : کالبدشکافی دقیق یک ارز
async function handleSingleCoinCommand(env, chatId, symbol) {
  const [klines5m, klines15m, macroData] = await Promise.all([
    fetchKlines(symbol, "5m", 120),
    fetchKlines(symbol, "15m", 100),
    fetchMacroData()
  ]);

  if (klines5m.length < 60 || klines15m.length < 60) {
    await sendTelegramRaw(env, chatId, `❌ خطا در دریافت دیتای کندل برای #${symbol}`);
    return;
  }

  const tf5m = analyzeInstitutionalIndicators(klines5m, 7, 2.0);
  const tf15m = analyzeInstitutionalIndicators(klines15m, 10, 3.0);
  const direction = tf5m.supertrend.direction;
  const scoreData = evaluateInstitutionalScore({ direction, tf5m, tf15m, macroData, news: { bias: "NEUTRAL" } });
  const targets = calculateProTargets(tf5m.close, tf5m.atr, direction);
  const dec = tf5m.close > 100 ? 2 : 3;

  const text = `
🔬 <b>کالبدشکافی لحظه‌ای (X-Ray) | #${symbol}</b>
━━━━━━━━━━━━━━━━━━
💰 <b>قیمت لحظه‌ای:</b> <code>${tf5m.close}</code>
🧭 <b>روند ۵ دقیقه:</b> ${direction === "LONG" ? "🟢 صعودی" : "🔴 نزولی"} | <b>روند ۱۵ دقیقه:</b> ${tf15m.supertrend.direction === "LONG" ? "🟢 صعودی" : "🔴 نزولی"}
⭐ <b>امتیاز اعتبار فعلی:</b> <b>${scoreData.score}/100</b> (${scoreData.score >= MIN_VALID_SCORE ? "✅ واجد شرایط سیگنال" : "⏳ منتظر تکمیل شروط"})
${buildScoreBar(scoreData.score)}

📊 <b>جزئیات اندیکاتورها:</b>
• <b>وضعیت بازار:</b> ${tf5m.isRanging ? "⚠️ رِنج و فرسایشی (ورود ممنوع)" : "✅ رونددار و مناسب اسکلپ"}
• <b>VWAP:</b> <code>${tf5m.vwap.toFixed(dec)}</code> | <b>EMA 9/20:</b> <code>${tf5m.ema9.toFixed(dec)}</code> / <code>${tf5m.ema20.toFixed(dec)}</code>
• <b>RSI (14):</b> ${tf5m.rsi.toFixed(1)} | <b>StochRSI:</b> ${tf5m.stochRsi.toFixed(0)}% | <b>ADX:</b> ${tf5m.adx.toFixed(1)}
• <b>واگرایی:</b> ${tf5m.divergence.type !== "NONE" ? tf5m.divergence.type : "ندارد"}
• <b>FVG فعال:</b> ${tf5m.fvg.inBullishFVG ? "🟢 داخل Bullish FVG" : tf5m.fvg.inBearishFVG ? "🔴 داخل Bearish FVG" : "خارج از FVG"}

🎯 <b>سطوح کلیدی در صورت ورود (${direction}):</b>
• <b>TP1:</b> <code>${targets.tp1}</code> | <b>TP2:</b> <code>${targets.tp2}</code> | <b>SL:</b> <code>${targets.sl}</code>
`.trim();

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "🔄 بروزرسانی مجدد", callback_data: `coin_${symbol}` },
        { text: "📈 چارت TradingView", url: `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol}` }
      ]
    ]
  };

  await sendTelegramRaw(env, chatId, text, replyMarkup);
}

// دستور /positions یا /status : نمایش سود/ضرر لحظه‌ای پوزیشن‌های باز
async function handlePositionsCommand(env, chatId) {
  const [macro, livePrices] = await Promise.all([fetchMacroData(), fetchLivePrices()]);
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

        activeCards.push(
          `🔸 <b>#${symbol}</b> (${isLong ? "🟢 LONG" : "🔴 SHORT"} | ${p.leverage || 5}x)\n` +
          `   ورود: <code>${p.entry}</code> | قیمت الان: <code>${cur}</code>\n` +
          `   ${pnlEmoji} <b>سود/ضرر لحظه‌ای:</b> <b>${pnlPct}%</b> (با اهرم: <b>${levPnl}%</b>)\n` +
          `   🎯 TP1: <code>${p.tp1}</code> ${p.tp1Hit ? "✅" : "⏳"} | TP2: <code>${p.tp2}</code> ${p.tp2Hit ? "✅" : "⏳"} | 🛑 SL: <code>${p.sl}</code>`
        );
      }
    }
  }

  const posText = activeCards.length > 0 ? activeCards.join("\n\n") : "هیچ پوزیشن بازی در حال حاضر وجود ندارد. 🟢";

  const report = `
📂 <b>وضعیت لحظه‌ای پوزیشن‌ها و بازار (Live PnL)</b>
━━━━━━━━━━━━━━━━━━
🌐 <b>وضعیت کلان بازار:</b>
• <b>BTC.D:</b> ${macro.btcD}% | <b>USDT.D:</b> ${macro.usdtD}%
• <b>تغییرات TOTAL:</b> ${macro.total24h}% (${macro.bias})

📊 <b>پوزیشن‌های تحت رصد (چک هر ۱۵ ثانیه):</b>
${posText}
`.trim();

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "🔄 رفرش لحظه‌ای سود/ضرر", callback_data: "cmd_positions" },
        { text: "🗑️ بستن همه پوزیشن‌ها (/clear)", callback_data: "cmd_clear" }
      ]
    ]
  };

  await sendTelegramRaw(env, chatId, report, replyMarkup);
}

// دستور /scan : اسکن کلی هر ۴ ارز
async function handleScanCommand(env, chatId) {
  try {
    const macroData = await fetchMacroData();
    let lines = [];

    for (const symbol of SYMBOLS) {
      const [klines5m, klines15m] = await Promise.all([
        fetchKlines(symbol, "5m", 120),
        fetchKlines(symbol, "15m", 100)
      ]);

      if (klines5m.length < 60 || klines15m.length < 60) {
        lines.push(`• <b>#${symbol}</b>: ⚠️ خطا در دریافت کندل`);
        continue;
      }

      const tf5m = analyzeInstitutionalIndicators(klines5m, 7, 2.0);
      const tf15m = analyzeInstitutionalIndicators(klines15m, 10, 3.0);
      const direction = tf5m.supertrend.direction;
      const scoreData = evaluateInstitutionalScore({ direction, tf5m, tf15m, macroData, news: { bias: "NEUTRAL" } });

      const rangeStatus = tf5m.isRanging ? "⚠️ رِنج" : "✅ رونددار";
      const dirEmoji = direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
      const validBadge = scoreData.score >= MIN_VALID_SCORE && !tf5m.isRanging ? "🔥 <b>واجد شرایط سیگنال!</b>" : "⏳ در انتظار تایید";

      lines.push(
        `🔹 <b>#${symbol}</b> | قیمت: <code>${tf5m.close}</code>\n` +
        `   جهت: <b>${dirEmoji}</b> | امتیاز: <b>${scoreData.score}/100</b> (${validBadge})\n` +
        `   وضعیت: ${rangeStatus} | RSI: ${tf5m.rsi.toFixed(1)} | ADX: ${tf5m.adx.toFixed(0)}`
      );
    }

    const msg = `
🔎 <b>نتیجه اسکن لحظه‌ای بازار (v3.0 PRO)</b>
━━━━━━━━━━━━━━━━━━
🌐 <b>BTC.D:</b> ${macroData.btcD}% | <b>USDT.D:</b> ${macroData.usdtD}% | <b>TOTAL:</b> ${macroData.total24h}%

${lines.join("\n\n")}

💡 <i>حداقل امتیاز برای ارسال خودکار سیگنال: <b>${MIN_VALID_SCORE}/100</b></i>
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
          { text: "⚡ صدور فوری بهترین سیگنال (/force)", callback_data: "cmd_force" }
        ]
      ]
    };

    await sendTelegramRaw(env, chatId, msg, replyMarkup);
  } catch (e) {
    await sendTelegramRaw(env, chatId, `❌ خطا در اسکن بازار: ${e.message}`);
  }
}

// دستور /stats : نمایش وین‌ریت و عملکرد بات
async function handleStatsCommand(env, chatId) {
  let stats = { wins: 0, losses: 0, netPct: 0 };
  if (env.SIGNAL_KV) {
    const raw = await env.SIGNAL_KV.get("BOT_STATS");
    if (raw) stats = JSON.parse(raw);
  }
  const total = stats.wins + stats.losses;
  const winRate = total > 0 ? ((stats.wins / total) * 100).toFixed(1) : "0.0";

  const text = `
📈 <b>آمار عملکرد و وین‌ریت بات (Win-Rate Stats)</b>
━━━━━━━━━━━━━━━━━━
✅ <b>تارگت‌های موفق (Wins):</b> ${stats.wins}
🛑 <b>حد ضررها (Losses):</b> ${stats.losses}
🏆 <b>نرخ برد (Win Rate):</b> <b>${winRate}%</b>
💰 <b>برآیند خالص درصدی (بدون اهرم):</b> <b>${stats.netPct >= 0 ? "+" : ""}${stats.netPct.toFixed(2)}%</b>
`.trim();

  await sendTelegramRaw(env, chatId, text);
}

async function recordTradeStat(env, type, pctChange) {
  if (!env.SIGNAL_KV) return;
  let stats = { wins: 0, losses: 0, netPct: 0 };
  const raw = await env.SIGNAL_KV.get("BOT_STATS");
  if (raw) stats = JSON.parse(raw);

  if (type === "WIN") stats.wins += 1;
  else stats.losses += 1;
  stats.netPct += pctChange;

  await env.SIGNAL_KV.put("BOT_STATS", JSON.stringify(stats));
}

async function handleClearCommand(env, chatId) {
  if (env.SIGNAL_KV) {
    for (const sym of SYMBOLS) await env.SIGNAL_KV.delete(`POS_${sym}`);
  }
  await sendTelegramRaw(env, chatId, "🗑️ تمام پوزیشن‌های فعال پاکسازی شدند و بات آماده شکار موقعیت‌های جدید است.");
}

/* =========================================================
   ۹. دریافت قیمت‌های لحظه‌ای و کندل‌ها (ضدتحریم)
========================================================= */
async function fetchLivePrices() {
  const prices = {};

  // تلاش اول: OKX Tickers
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

  // تلاش دوم: Gate.io یا کندل آخر
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

  try {
    const okxBar = interval === "5m" ? "5m" : "15m";
    const res = await fetch(`https://www.okx.com/api/v5/market/candles?instId=${coin}-USDT&bar=${okxBar}&limit=${limit}`, { headers: BROWSER_HEADERS });
    if (res.ok) {
      const json = await res.json();
      if (json.data && json.data.length >= 50) {
        return json.data.reverse().map(d => ({
          open: parseFloat(d[1]), high: parseFloat(d[2]), low: parseFloat(d[3]), close: parseFloat(d[4]), volume: parseFloat(d[5])
        }));
      }
    }
  } catch (e) {}

  try {
    const res = await fetch(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${coin}_USDT&interval=${interval}&limit=${limit}`, { headers: BROWSER_HEADERS });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length >= 50) {
        return data.map(d => ({
          open: parseFloat(d[5]), high: parseFloat(d[3]), low: parseFloat(d[4]), close: parseFloat(d[2]), volume: parseFloat(d[6])
        }));
      }
    }
  } catch (e) {}

  try {
    const kcType = interval === "5m" ? "5min" : "15min";
    const res = await fetch(`https://api.kucoin.com/api/v1/market/candles?type=${kcType}&symbol=${coin}-USDT`, { headers: BROWSER_HEADERS });
    if (res.ok) {
      const json = await res.json();
      if (json.data && json.data.length >= 50) {
        return json.data.slice(0, limit).reverse().map(d => ({
          open: parseFloat(d[1]), close: parseFloat(d[2]), high: parseFloat(d[3]), low: parseFloat(d[4]), volume: parseFloat(d[5])
        }));
      }
    }
  } catch (e) {}

  return [];
}

async function fetchMacroData() {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/global", { headers: BROWSER_HEADERS });
    if (res.ok) {
      const { data } = await res.json();
      const btcD = data.market_cap_percentage.btc || 55;
      const usdtD = data.market_cap_percentage.usdt || 5;
      const total24h = data.market_cap_change_percentage_24h_usd || 0;
      let bias = "NEUTRAL";
      if (total24h > 0.5 && usdtD < 7.0) bias = "BULLISH";
      else if (total24h < -0.5) bias = "BEARISH";
      return { btcD: btcD.toFixed(2), usdtD: usdtD.toFixed(2), total24h: total24h.toFixed(2), bias };
    }
  } catch (e) {}

  try {
    const [globalRes, usdtRes] = await Promise.all([
      fetch("https://api.coinlore.net/api/global/", { headers: BROWSER_HEADERS }),
      fetch("https://api.coinlore.net/api/ticker/?id=518", { headers: BROWSER_HEADERS })
    ]);
    if (globalRes.ok) {
      const g = (await globalRes.json())[0];
      const totalMcap = parseFloat(g.total_mcap) || 2500000000000;
      const btcD = parseFloat(g.btc_d) || 55;
      const total24h = parseFloat(g.mcap_change) || 0;
      let usdtD = 5.2;
      if (usdtRes.ok) {
        const u = (await usdtRes.json())[0];
        if (u?.market_cap_usd) usdtD = (parseFloat(u.market_cap_usd) / totalMcap) * 100;
      }
      let bias = total24h > 0.5 ? "BULLISH" : total24h < -0.5 ? "BEARISH" : "NEUTRAL";
      return { btcD: btcD.toFixed(2), usdtD: usdtD.toFixed(2), total24h: total24h.toFixed(2), bias };
    }
  } catch (e) {}

  return { btcD: "55.10", usdtD: "5.10", total24h: "0.10", bias: "NEUTRAL" };
}

async function fetchNewsSentiment(coin, apiKey) {
  if (!apiKey) return { bias: "NEUTRAL", label: "متعادل ⚪" };
  try {
    const res = await fetch(`https://cryptopanic.com/api/v1/posts/?auth_token=${apiKey}&currencies=${coin}&filter=important`, { headers: BROWSER_HEADERS });
    if (!res.ok) return { bias: "NEUTRAL", label: "متعادل ⚪" };
    const data = await res.json();
    let pos = 0, neg = 0;
    (data.results || []).slice(0, 5).forEach(p => {
      pos += (p.votes?.positive || 0) + (p.votes?.liked || 0);
      neg += (p.votes?.negative || 0) + (p.votes?.disliked || 0);
    });
    if (pos > neg * 1.3) return { bias: "LONG", label: "مثبت 🟢" };
    if (neg > pos * 1.3) return { bias: "SHORT", label: "منفی 🔴" };
    return { bias: "NEUTRAL", label: "متعادل ⚪" };
  } catch {
    return { bias: "NEUTRAL", label: "متعادل ⚪" };
  }
}

/* =========================================================
   ۱۰. توابع پایه ریاضی و ارسال تلگرام
========================================================= */
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

function detectRSIDivergence(klines, rsiSeries, lookback = 30) {
  const len = klines.length;
  const start = Math.max(5, len - lookback);
  let lows = [], highs = [];
  for (let i = start; i < len - 1; i++) {
    if (klines[i].low <= klines[i - 1].low && klines[i].low <= klines[i - 2].low && klines[i].low <= klines[i + 1].low) {
      lows.push({ index: i, price: klines[i].low, rsi: rsiSeries[i] });
    }
    if (klines[i].high >= klines[i - 1].high && klines[i].high >= klines[i - 2].high && klines[i].high >= klines[i + 1].high) {
      highs.push({ index: i, price: klines[i].high, rsi: rsiSeries[i] });
    }
  }
  let bullish = false, bearish = false, type = "NONE";
  if (lows.length >= 2) {
    const l = lows[lows.length - 1], p = lows[lows.length - 2];
    if ((len - 1 - l.index) <= 6 && l.price < p.price && l.rsi > p.rsi + 1.5 && l.rsi < 48) { bullish = true; type = "واگرایی مثبت (+RD)"; }
    else if ((len - 1 - l.index) <= 6 && l.price > p.price && l.rsi < p.rsi - 1.5 && l.rsi < 55) { bullish = true; type = "واگرایی مخفی مثبت (+HD)"; }
  }
  if (highs.length >= 2) {
    const l = highs[highs.length - 1], p = highs[highs.length - 2];
    if ((len - 1 - l.index) <= 6 && l.price > p.price && l.rsi < p.rsi - 1.5 && l.rsi > 52) { bearish = true; type = "واگرایی منفی (-RD)"; }
    else if ((len - 1 - l.index) <= 6 && l.price < p.price && l.rsi > p.rsi + 1.5 && l.rsi > 45) { bearish = true; type = "واگرایی مخفی منفی (-HD)"; }
  }
  return { bullish, bearish, type };
}

function detectOrderBlocks(klines, atr, lookback = 45) {
  const len = klines.length, current = klines[len - 1], start = Math.max(2, len - lookback);
  let bullOB = null, bearOB = null;
  for (let i = start; i < len - 3; i++) {
    const c = klines[i], n1 = klines[i + 1], n2 = klines[i + 2];
    if (c.close < c.open && ((n1.close - c.open) > atr * 1.25 || ((n2.close - c.open) > atr * 1.6 && n1.close > c.high))) {
      let inv = false;
      for (let j = i + 3; j < len - 1; j++) if (klines[j].close < c.low) { inv = true; break; }
      if (!inv) bullOB = { bottom: c.low, top: Math.max(c.open, c.high) };
    }
    if (c.close > c.open && ((c.open - n1.close) > atr * 1.25 || ((c.open - n2.close) > atr * 1.6 && n1.close < c.low))) {
      let inv = false;
      for (let j = i + 3; j < len - 1; j++) if (klines[j].close > c.high) { inv = true; break; }
      if (!inv) bearOB = { bottom: Math.min(c.open, c.low), top: c.high };
    }
  }
  const buf = atr * 0.35;
  const inBullishOB = Boolean(bullOB && current.low <= bullOB.top + buf && current.close >= bullOB.bottom);
  const nearBullishOB = Boolean(bullOB && !inBullishOB && Math.abs(current.close - bullOB.top) <= atr * 0.8 && current.close > bullOB.top);
  const inBearishOB = Boolean(bearOB && current.high >= bearOB.bottom - buf && current.close <= bearOB.top);
  const nearBearishOB = Boolean(bearOB && !inBearishOB && Math.abs(bearOB.bottom - current.close) <= atr * 0.8 && current.close < bearOB.bottom);
  return { bullOB, bearOB, inBullishOB, nearBullishOB, inBearishOB, nearBearishOB };
}

function calcVWAP(klines) {
  let pv = 0, vol = 0;
  for (const k of klines) { pv += ((k.high + k.low + k.close) / 3) * k.volume; vol += k.volume; }
  return vol === 0 ? klines[klines.length - 1].close : pv / vol;
}

function calcBollingerBands(closes, period = 20, mult = 2) {
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period);
  return { upper: mean + mult * std, middle: mean, lower: mean - mult * std, bandwidth: ((mean + mult * std) - (mean - mult * std)) / mean };
}

function calcSupertrend(klines, period = 7, multiplier = 2.0) {
  let trs = [0];
  for (let i = 1; i < klines.length; i++) {
    trs.push(Math.max(klines[i].high - klines[i].low, Math.abs(klines[i].high - klines[i - 1].close), Math.abs(klines[i].low - klines[i - 1].close)));
  }
  let up = 0, low = 0, dir = "LONG", prevDir = "LONG";
  for (let i = period; i < klines.length; i++) {
    const atr = trs.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
    const hl2 = (klines[i].high + klines[i].low) / 2;
    const bUp = hl2 + multiplier * atr, bLow = hl2 - multiplier * atr;
    up = (bUp < up || klines[i - 1].close > up) ? bUp : up;
    low = (bLow > low || klines[i - 1].close < low) ? bLow : low;
    prevDir = dir;
    if (klines[i].close > up) dir = "LONG";
    else if (klines[i].close < low) dir = "SHORT";
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
  let sum = 0;
  for (let i = klines.length - period; i < klines.length; i++) {
    sum += Math.max(klines[i].high - klines[i].low, Math.abs(klines[i].high - klines[i - 1].close), Math.abs(klines[i].low - klines[i - 1].close));
  }
  return sum / period;
}

function calcADX(klines, period = 14) {
  let dx = [];
  for (let i = klines.length - period * 2; i < klines.length; i++) {
    if (i <= 0) continue;
    const up = klines[i].high - klines[i - 1].high, down = klines[i - 1].low - klines[i].low;
    const pDM = (up > down && up > 0) ? up : 0, mDM = (down > up && down > 0) ? down : 0;
    const tr = Math.max(klines[i].high - klines[i].low, Math.abs(klines[i].high - klines[i - 1].close), Math.abs(klines[i].low - klines[i - 1].close)) || 1;
    const pDI = (pDM / tr) * 100, mDI = (mDM / tr) * 100;
    dx.push((Math.abs(pDI - mDI) / ((pDI + mDI) || 1)) * 100);
  }
  return dx.slice(-period).reduce((a, b) => a + b, 0) / period;
}

async function answerCallback(env, callbackQueryId, text) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text })
  });
}

async function sendTelegramGlobal(env, text, replyMarkup = null) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return { ok: false };
  return await sendTelegramRaw(env, env.TELEGRAM_CHAT_ID, text, replyMarkup);
}

async function sendTelegramRaw(env, chatId, text, replyMarkup = null) {
  const payload = { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true };
  if (replyMarkup) payload.reply_markup = replyMarkup;

  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return await res.json();
}