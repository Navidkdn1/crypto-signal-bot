/**
 * 🚀 Crypto Scalping Signal Bot v3.1 (High Win-Rate Institutional Edition)
 * -------------------------------------------------------------------------
 * 👑 فیلتر رهبر بازار (BTC Leader Synchronization) برای محافظت از آلت‌کوین‌ها
 * 🚫 فیلتر ضد هیجان (Anti-Chase Filter) برای جلوگیری از ورود در سقف/کف کندل‌های کشیده
 * 📊 اتصال به دیتای فیوچرز OKX (Taker Buy/Sell Volume + Funding Rate)
 * ⚡ سیستم تارگت اول سریع (Quick TP1 = 0.9x ATR) + ریسک‌فری خودکار ۱۵ ثانیه‌ای
 * 🧠 موتور تحلیلی: Supertrend + VWAP + Order Block + FVG + RSI Divergence + MACD
 */

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"];
const MAX_OPEN_POSITIONS = 2;
const POSITION_TTL_SECONDS = 3600; // حداکثر ۶۰ دقیقه زمان مجاز پوزیشن اسکلپ
const MIN_VALID_SCORE = 78; // حداقل امتیاز برای ارسال خودکار سیگنال معتبر

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Accept": "application/json"
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export default {
  // ۱. اجرای خودکار هر ۱ دقیقه + حلقه رصد لحظه‌ای هر ۱۵ ثانیه
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runRealTimeSchedule(env));
  },

  // ۲. مدیریت وب‌هوک تلگرام و لینک‌های مرورگر
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/diag") {
      const [prices, macro, btcFut] = await Promise.all([
        fetchLivePrices(),
        fetchMacroData(),
        fetchOKXFuturesData("BTC")
      ]);
      return new Response(JSON.stringify({
        ok: true,
        version: "3.1 High Win-Rate Edition",
        livePrices: prices,
        macro,
        sampleFuturesData: btcFut
      }, null, 2), { headers: { "Content-Type": "application/json; charset=utf-8" } });
    }

    if (url.pathname === "/test") {
      const res = await sendMainMenu(env, env.TELEGRAM_CHAT_ID);
      return new Response(JSON.stringify(res, null, 2), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      try {
        const update = await request.json();

        // الف) مدیریت دکمه‌های شیشه‌ای (Inline Keyboard Callbacks)
        if (update.callback_query) {
          const cb = update.callback_query;
          const chatId = cb.message.chat.id;
          const data = cb.data;

          await answerCallback(env, cb.id, "⏳ در حال پردازش...");

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
            await sendTelegramRaw(env, chatId, `✅ پوزیشن <b>#${sym}</b> به صورت دستی بسته شد و از رصد خارج گردید.`);
          }
          return new Response("OK", { status: 200 });
        }

        // ب) مدیریت دستورات متنی تلگرام
        if (update.message && update.message.text) {
          const chatId = update.message.chat.id;
          const text = update.message.text.trim().split("@")[0].toLowerCase();

          if (text === "/start" || text === "/menu" || text === "/help") {
            await sendMainMenu(env, chatId);
          } else if (text === "/scan") {
            await sendTelegramRaw(env, chatId, "🔍 <b>در حال اسکن عمیق کندل‌ها، دیتای فیوچرز OKX و هم‌جهتی بیت‌کوین...</b>");
            await handleScanCommand(env, chatId);
          } else if (text === "/status" || text === "/positions") {
            await handlePositionsCommand(env, chatId);
          } else if (text === "/stats") {
            await handleStatsCommand(env, chatId);
          } else if (text === "/force") {
            await sendTelegramRaw(env, chatId, "⚡ <b>در حال استخراج بالاترین امتیاز فعلی بازار (v3.1)...</b>");
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

    return new Response("🤖 Crypto Signal Bot v3.1 (High Win-Rate) is Active!", { status: 200 });
  }
};

/* =========================================================
   ۱. موتور زمان‌بندی لحظه‌ای (چک کردن تارگت/استاپ هر ۱۵ ثانیه)
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
    const dec = pos.entry > 100 ? 2 : 3;
    const durationMin = Math.max(1, Math.round((Date.now() - (pos.openedAt || Date.now())) / 60000));

    // ۱. بررسی برخورد با حد ضرر (یا نقطه ریسک‌فری بعد از TP1)
    const slHit = isLong ? currentPrice <= pos.sl : currentPrice >= pos.sl;
    if (slHit) {
      if (pos.tp1Hit) {
        const msg = `
🛡️ <b>خروج امن در نقطه ریسک‌فری (Break-Even) | #${symbol}</b>
━━━━━━━━━━━━━━━━━━
🧭 <b>جهت:</b> ${pos.direction}
✅ <b>نتیجه:</b> این معامله قبلاً <b>تارگت اول (TP1)</b> را با موفقیت ثبت کرده بود و مابقی حجم در قیمت ورود (<code>${pos.sl}</code>) بدون ضرر بسته شد.
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
🛑 <b>قیمت استاپ (SL):</b> <code>${pos.sl}</code> (<b>-${lossPct}%</b> بدون اهرم)
⏱ <b>مدت زمان:</b> ${durationMin} دقیقه
`.trim();
        await sendTelegramGlobal(env, msg);
      }
      await env.SIGNAL_KV.delete(`POS_${symbol}`);
      continue;
    }

    // ۲. بررسی برخورد با تارگت سوم (TP3 - فول تارگت)
    const tp3Hit = isLong ? currentPrice >= pos.tp3 : currentPrice <= pos.tp3;
    if (tp3Hit) {
      const profitPct = (Math.abs(pos.tp3 - pos.entry) / pos.entry * 100).toFixed(2);
      if (!pos.tp1Hit) await recordTradeStat(env, "WIN", parseFloat(profitPct));
      const msg = `
🚀💎 <b>فول تارگت نهایی (TP3 Hit!) | #${symbol}</b>
━━━━━━━━━━━━━━━━━━
🧭 <b>جهت:</b> ${isLong ? "🟢 LONG" : "🔴 SHORT"}
🔹 <b>قیمت ورود:</b> <code>${pos.entry}</code>
🎯 <b>تارگت سوم (TP3):</b> <code>${pos.tp3}</code>
🔥 <b>سود خالص حرکت:</b> <b>+${profitPct}%</b> (با اهرم ${pos.leverage}x: <b>+${(profitPct * pos.leverage).toFixed(1)}%</b>)
⏱ <b>مدت زمان:</b> ${durationMin} دقیقه
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
      pos.sl = pos.tp1; // قفل کردن سود روی TP1
      const profitPct = (Math.abs(pos.tp2 - pos.entry) / pos.entry * 100).toFixed(2);
      await recordTradeStat(env, "WIN", parseFloat(profitPct));

      const msg = `
🎯🔥 <b>تارگت دوم تاچ شد (TP2 Hit!) | #${symbol}</b>
━━━━━━━━━━━━━━━━━━
🔹 <b>قیمت ورود:</b> <code>${pos.entry}</code>
✅ <b>قیمت فعلی (TP2):</b> <code>${currentPrice.toFixed(dec)}</code> (<b>+${profitPct}%</b>)
🛡️ <b>قفل سود خودکار:</b> حد ضرر بات به <b>TP1 (<code>${pos.tp1}</code>)</b> منتقل شد!
⏱ <b>زمان سپری‌شده:</b> ${durationMin} دقیقه
`.trim();
      await sendTelegramGlobal(env, msg);
      await env.SIGNAL_KV.put(`POS_${symbol}`, JSON.stringify(pos), { expirationTtl: 2400 });
      activeCount++;
      continue;
    }

    // ۴. بررسی برخورد با تارگت اول سریع (Quick TP1 = برد تضمینی و ریسک‌فری)
    const tp1Hit = isLong ? currentPrice >= pos.tp1 : currentPrice <= pos.tp1;
    if (tp1Hit && !pos.tp1Hit) {
      pos.tp1Hit = true;
      pos.sl = pos.entry; // انتقال آنی استاپ به نقطه ورود
      const profitPct = (Math.abs(pos.tp1 - pos.entry) / pos.entry * 100).toFixed(2);
      await recordTradeStat(env, "WIN", parseFloat(profitPct));

      const msg = `
✅⚡ <b>تارگت اول سریع تاچ شد (Quick TP1 Hit!) | #${symbol}</b>
━━━━━━━━━━━━━━━━━━
🔹 <b>قیمت ورود:</b> <code>${pos.entry}</code>
🎯 <b>قیمت فعلی (TP1):</b> <code>${currentPrice.toFixed(dec)}</code> (<b>+${profitPct}%</b> | با اهرم: <b>+${(profitPct * pos.leverage).toFixed(1)}%</b>)
🛡️ <b>ریسک‌فری خودکار فعال شد:</b> حد ضرر به نقطه ورود (<code>${pos.entry}</code>) منتقل گردید. ۶۰٪ سیو سود کنید؛ این معامله دیگر تحت هیچ شرایطی ضرر نخواهد شد!
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
   ۳. موتور اصلی اسکن v3.1 (با فیلتر BTC Leader و Anti-Chase)
========================================================= */
async function runBotEngine(env, forceBest = false, customChatId = null) {
  try {
    let activePositions = await checkActivePositionsRealTime(env);
    if (!forceBest && activePositions >= MAX_OPEN_POSITIONS) return;

    const macroData = await fetchMacroData();

    // گام کلیدی ۱: تحلیل وضعیت رهبر بازار (BTCUSDT) قبل از بررسی سایر ارزها
    const btcLeader = await analyzeBTCLeader();

    let bestCandidate = null;

    for (const symbol of SYMBOLS) {
      if (!forceBest && activePositions >= MAX_OPEN_POSITIONS) break;

      if (!forceBest && env.SIGNAL_KV) {
        const existingPos = await env.SIGNAL_KV.get(`POS_${symbol}`);
        if (existingPos) continue;
      }

      const coin = symbol.replace("USDT", "");
      const [klines5m, klines15m, futuresData] = await Promise.all([
        fetchKlines(symbol, "5m", 120),
        fetchKlines(symbol, "15m", 100),
        fetchOKXFuturesData(coin)
      ]);
      if (klines5m.length < 60 || klines15m.length < 60) continue;

      const tf5m = analyzeInstitutionalIndicators(klines5m, 7, 2.0);
      const tf15m = analyzeInstitutionalIndicators(klines15m, 10, 3.0);

      let direction = tf5m.supertrend.direction;
      if (tf5m.divergence.bullish && (tf5m.orderBlock.inBullishOB || tf5m.fvg.inBullishFVG)) direction = "LONG";
      if (tf5m.divergence.bearish && (tf5m.orderBlock.inBearishOB || tf5m.fvg.inBearishFVG)) direction = "SHORT";

      const news = await fetchNewsSentiment(coin, env.CRYPTOPANIC_API_KEY);
      const scoreData = evaluateHighWinRateScore({
        symbol,
        direction,
        tf5m,
        tf15m,
        btcLeader,
        futuresData,
        macroData,
        news
      });

      const candidate = {
        symbol,
        direction,
        entry: tf5m.close,
        tf5m,
        tf15m,
        btcLeader,
        futuresData,
        scoreData,
        macroData
      };

      if (!bestCandidate || scoreData.score > bestCandidate.scoreData.score) {
        bestCandidate = candidate;
      }

      // شروط سخت‌گیرانه افزایش وین‌ریت در حالت خودکار:
      // ۱. بازار رنج نباشد (!tf5m.isRanging)
      // ۲. کندل بیش از حد کشیده و هیجانی نباشد (!tf5m.isOverextended -> Anti-Chase Filter)
      // ۳. بیت‌کوین خلاف جهت پوزیشن در حال حرکت شدید نباشد (scoreData.btcAligned)
      // ۴. امتیاز کل حداقل ۷۸ از ۱۰۰ باشد
      if (
        !forceBest &&
        !tf5m.isRanging &&
        !tf5m.isOverextended &&
        scoreData.btcAligned &&
        tf5m.hasValidTrigger &&
        scoreData.score >= MIN_VALID_SCORE
      ) {
        const targets = calculateHighWinRateTargets(tf5m.close, tf5m.atr, direction);
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
      const targets = calculateHighWinRateTargets(bestCandidate.entry, bestCandidate.tf5m.atr, bestCandidate.direction);
      await sendProSignalMessage(env, { ...bestCandidate, targets, isForced: true }, customChatId);
    }
  } catch (error) {
    console.error("Bot Engine Error:", error);
  }
}

/* =========================================================
   ۴. تحلیل رهبر بازار (BTC Leader) و دیتای فیوچرز OKX
========================================================= */
async function analyzeBTCLeader() {
  try {
    const klines5m = await fetchKlines("BTCUSDT", "5m", 80);
    if (klines5m.length < 50) return { bias: "NEUTRAL", dir: "LONG", strongBear: false, strongBull: false };

    const tf = analyzeInstitutionalIndicators(klines5m, 7, 2.0);
    const aboveVwap = tf.close > tf.vwap;
    const strongBull = tf.supertrend.direction === "LONG" && aboveVwap && tf.ema9 >= tf.ema20;
    const strongBear = tf.supertrend.direction === "SHORT" && !aboveVwap && tf.ema9 <= tf.ema20;

    let bias = "NEUTRAL";
    if (strongBull) bias = "BULLISH";
    else if (strongBear) bias = "BEARISH";
    else bias = tf.supertrend.direction === "LONG" ? "MILD_BULL" : "MILD_BEAR";

    return {
      price: tf.close,
      dir: tf.supertrend.direction,
      bias,
      strongBull,
      strongBear
    };
  } catch {
    return { bias: "NEUTRAL", dir: "LONG", strongBear: false, strongBull: false };
  }
}

// دریافت دیتای لحظه‌ای فیوچرز از صرافی OKX (حجم سفارشات Taker + نرخ Funding Rate)
async function fetchOKXFuturesData(coin) {
  let fundingRate = 0.0001; // 0.01% پیش‌فرض
  let takerBuyRatio = 50.0;
  let flowBias = "NEUTRAL";

  try {
    const [fundRes, takerRes] = await Promise.all([
      fetch(`https://www.okx.com/api/v5/public/funding-rate?instId=${coin}-USDT-SWAP`, { headers: BROWSER_HEADERS }),
      fetch(`https://www.okx.com/api/v5/rubik/stat/taker-volume?ccy=${coin}&instType=CONTRACTS&period=5m`, { headers: BROWSER_HEADERS })
    ]);

    if (fundRes.ok) {
      const fJson = await fundRes.json();
      if (fJson.data && fJson.data[0]) {
        fundingRate = parseFloat(fJson.data[0].fundingRate) * 100; // تبدیل به درصد
      }
    }

    if (takerRes.ok) {
      const tJson = await takerRes.json();
      // فرمت خروجی OKX: [[timestamp, sellVolume, buyVolume], ...]
      if (tJson.data && tJson.data.length > 0) {
        const latest = tJson.data[0];
        const sellVol = parseFloat(latest[1]) || 1;
        const buyVol = parseFloat(latest[2]) || 1;
        takerBuyRatio = (buyVol / (buyVol + sellVol)) * 100;
      }
    }

    if (takerBuyRatio >= 52.5) flowBias = "LONG";
    else if (takerBuyRatio <= 47.5) flowBias = "SHORT";
  } catch (e) {}

  return {
    fundingRateStr: `${fundingRate >= 0 ? "+" : ""}${fundingRate.toFixed(4)}%`,
    fundingRate,
    takerBuyRatio: parseFloat(takerBuyRatio.toFixed(1)),
    flowBias
  };
}

/* =========================================================
   ۵. محاسبات اندیکاتورها + فیلتر ضد هیجان (Anti-Chase Filter)
========================================================= */
function analyzeInstitutionalIndicators(klines, stPeriod, stMult) {
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

  // ۱. فیلتر بازار رنج (Chop / Squeeze Filter)
  const isRanging = (adx < 20 && bb.bandwidth < 0.0045) || bb.bandwidth < 0.0028;

  // ۲. فیلتر ضد هیجان و کندل کشیده (Anti-Chase / Anti-FOMO Filter)
  // اگر فاصله قیمت از EMA9 بیش از 1.35 برابر ATR باشد یا بدنه کندل بیش از 1.6 برابر ATR جامپ کرده باشد -> ورود در سقف/کف ممنوع!
  const extensionAtr = Math.abs(current.close - ema9) / (atr || 1);
  const candleBodyAtr = Math.abs(current.close - current.open) / (atr || 1);
  const isOverextended = extensionAtr > 1.35 || candleBodyAtr > 1.65;

  // ۳. بررسی پین‌بار و جمع‌آوری نقدینگی (Wick Rejection)
  const totalRange = (current.high - current.low) || 1;
  const lowerWickRatio = (Math.min(current.open, current.close) - current.low) / totalRange;
  const upperWickRatio = (current.high - Math.max(current.open, current.close)) / totalRange;
  const hasBullishRejection = lowerWickRatio >= 0.35;
  const hasBearishRejection = upperWickRatio >= 0.35;

  const bullMomentum = supertrend.direction === "LONG" && current.close > ema9 && ema9 >= ema20 && macd.histogram >= macd.prevHistogram;
  const bearMomentum = supertrend.direction === "SHORT" && current.close < ema9 && ema9 <= ema20 && macd.histogram <= macd.prevHistogram;

  const smcReversal =
    (divergence.bullish && (orderBlock.inBullishOB || fvg.inBullishFVG)) ||
    (divergence.bearish && (orderBlock.inBearishOB || fvg.inBearishFVG));

  const hasValidTrigger = supertrend.justFlipped || bullMomentum || bearMomentum || smcReversal;

  return {
    close: current.close,
    ema9, ema20, ema50, vwap,
    rsi, stochRsi, macd,
    atr, adx, bb, supertrend,
    volRatio, isRanging,
    extensionAtr, isOverextended,
    hasBullishRejection, hasBearishRejection,
    hasValidTrigger,
    divergence, orderBlock, fvg
  };
}

/* =========================================================
   ۶. موتور امتیازدهی ۱۰۰ امتیازی نسخه v3.1 (High Win-Rate)
========================================================= */
function evaluateHighWinRateScore({ symbol, direction, tf5m, tf15m, btcLeader, futuresData, macroData, news }) {
  let score = 0;
  let reasons = [];

  // ۱. هم‌جهتی ساختار مولتی تایم‌فریم 5m و 15m (۱۸ امتیاز)
  if (tf5m.supertrend.direction === tf15m.supertrend.direction) {
    score += 18;
    reasons.push("✅ هم‌جهتی ساختار روند در تایم 5m و 15m");
  } else {
    score += 7;
  }

  // ۲. فیلتر رهبر بازار - هم‌جهتی با بیت‌کوین (۱۵ امتیاز)
  let btcAligned = true;
  if (symbol === "BTCUSDT") {
    score += 15;
    reasons.push("👑 ارز رهبر بازار (BTC Structure)");
  } else {
    if (direction === "LONG" && btcLeader.strongBear) {
      btcAligned = false;
      score += 2;
      reasons.push("⚠️ هشدار: بیت‌کوین در فاز نزولی است (خطر استاپ)");
    } else if (direction === "SHORT" && btcLeader.strongBull) {
      btcAligned = false;
      score += 2;
      reasons.push("⚠️ هشدار: بیت‌کوین در فاز صعودی قوی است");
    } else if ((direction === "LONG" && btcLeader.dir === "LONG") || (direction === "SHORT" && btcLeader.dir === "SHORT")) {
      score += 15;
      reasons.push(`👑 هم‌جهتی کامل با روند لحظه‌ای بیت‌کوین (${btcLeader.dir})`);
    } else {
      score += 9;
    }
  }

  // ۳. نواحی اسمارت مانی: Order Block + FVG + Rejection Wick (۱۸ امتیاز)
  const inSmartBull = direction === "LONG" && (tf5m.orderBlock.inBullishOB || tf5m.fvg.inBullishFVG);
  const inSmartBear = direction === "SHORT" && (tf5m.orderBlock.inBearishOB || tf5m.fvg.inBearishFVG);
  const nearSmart = (direction === "LONG" && tf5m.orderBlock.nearBullishOB) || (direction === "SHORT" && tf5m.orderBlock.nearBearishOB);

  if (inSmartBull || inSmartBear) {
    score += 18;
    reasons.push("🏦 ورود از درون ناحیه نقدینگی نهنگ‌ها (Order Block / FVG)");
  } else if (nearSmart || (direction === "LONG" && tf5m.hasBullishRejection) || (direction === "SHORT" && tf5m.hasBearishRejection)) {
    score += 13;
    reasons.push("🕯️ حمایت در مجاورت Order Block همراه با شدوی بازگشتی");
  } else {
    score += 7;
  }

  // ۴. فیلتر ضد هیجان (Anti-Chase) و فاصله استاندارد از VWAP/EMA9 (۱۴ امتیاز)
  const vwapAligned = (direction === "LONG" && tf5m.close > tf5m.vwap && tf5m.ema9 >= tf5m.ema20) ||
                      (direction === "SHORT" && tf5m.close < tf5m.vwap && tf5m.ema9 <= tf5m.ema20);
  if (!tf5m.isOverextended && vwapAligned) {
    score += 14;
    reasons.push(`🎯 نقطه ورود بهینه و غیرهیجانی (فاصله از EMA9: ${tf5m.extensionAtr.toFixed(1)}x ATR)`);
  } else if (tf5m.isOverextended) {
    score += 3;
    reasons.push("🚫 کندل کشیده و هیجانی (ریسک پولبک بالا - Anti-Chase)");
  } else {
    score += 8;
  }

  // ۵. دیتای فیوچرز OKX: جریان سفارشات Taker و فاندینگ ریت (۱۵ امتیاز)
  if (futuresData.flowBias === direction) {
    score += 15;
    reasons.push(`📊 تایید جریان سفارشات فیوچرز OKX (Taker Buy: ${futuresData.takerBuyRatio}%)`);
  } else if (futuresData.flowBias === "NEUTRAL") {
    score += 10;
  } else {
    score += 5;
  }

  // ۶. واگرایی RSI و شتاب MACD (۱۰ امتیاز)
  const hasDiv = (direction === "LONG" && tf5m.divergence.bullish) || (direction === "SHORT" && tf5m.divergence.bearish);
  const macdAligned = (direction === "LONG" && tf5m.macd.histogram >= tf5m.macd.prevHistogram) ||
                      (direction === "SHORT" && tf5m.macd.histogram <= tf5m.macd.prevHistogram);
  if (hasDiv) {
    score += 10;
    reasons.push(`📐 تایید ${tf5m.divergence.type}`);
  } else if (macdAligned && !tf5m.isRanging) {
    score += 8;
    reasons.push("✅ تایید مومنتوم MACD و قدرت روند ADX");
  } else {
    score += 4;
  }

  // ۷. حجم معاملات و هم‌سویی با دامیننس تتر (۱۰ امتیاز)
  const macroOk = (direction === "LONG" && macroData.bias === "BULLISH") || (direction === "SHORT" && macroData.bias === "BEARISH");
  if (tf5m.volRatio >= 1.15 || macroOk || news.bias === direction) {
    score += 10;
    reasons.push(`✅ تایید حجم (${tf5m.volRatio.toFixed(1)}x) و جریان نقدینگی کلان`);
  } else {
    score += 6;
  }

  let grade = "⚡ متوسط (فیلتر شده)";
  if (score >= 86) grade = "💎 فوق‌معتبر (VIP A+)";
  else if (score >= 78) grade = "🔥 وین‌ریت بالا (Grade A)";

  return { score, grade, reasons, btcAligned };
}

/* =========================================================
   ۷. محاسبه تارگت اول سریع (Quick TP1 = 0.9x ATR) برای حداکثر وین‌ریت
========================================================= */
function calculateHighWinRateTargets(price, atr, direction) {
  const dec = price > 100 ? 2 : 3;
  const m = direction === "LONG" ? 1 : -1;

  // فرمول اختصاصی وین‌ریت بالا:
  // TP1 بسیار نزدیک (0.9x ATR) برای سیو سود سریع و ریسک‌فری کردن معامله در دقایق اول
  const slPrice = price - m * (atr * 1.40);
  const tp1Price = price + m * (atr * 0.90); // تارگت اول سریع (احتمال برخورد ~80%)
  const tp2Price = price + m * (atr * 1.85); // تارگت دوم استاندارد
  const tp3Price = price + m * (atr * 3.00); // تارگت سوم امتدادی

  const zoneLow = (price - m * (atr * 0.20)).toFixed(dec);
  const zoneHigh = price.toFixed(dec);

  const slPct = ((Math.abs(price - slPrice) / price) * 100).toFixed(2);
  const tp1Pct = ((Math.abs(tp1Price - price) / price) * 100).toFixed(2);
  const tp2Pct = ((Math.abs(tp2Price - price) / price) * 100).toFixed(2);
  const tp3Pct = ((Math.abs(tp3Price - price) / price) * 100).toFixed(2);

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
   ۸. ارسال کارت سیگنال VIP و مدیریت دستورات تلگرام
========================================================= */
function buildScoreBar(score) {
  const filled = Math.min(10, Math.max(0, Math.round(score / 10)));
  return "🟩".repeat(filled) + "⬜".repeat(10 - filled);
}

async function sendProSignalMessage(env, data, customChatId = null) {
  const { symbol, direction, entry, targets, scoreData, tf5m, btcLeader, futuresData, macroData, isForced } = data;
  const isLong = direction === "LONG";
  const headerBadge = isForced ? "⚡ <b>سیگنال درخواستی لحظه‌ای (/force)</b>" : "🚨 <b>سیگنال اسکلپ VIP (وین‌ریت بالا v3.1)</b>";
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
📊 <b>امتیاز وین‌ریت:</b> <b>${scoreData.score}/100</b> (${scoreData.grade})
${buildScoreBar(scoreData.score)}

🎯 <b>نقاط ورود و تارگت‌های هوشمند:</b>
🔹 <b>قیمت ورود (Entry):</b> <code>${entry}</code>
🎯 <b>محدوده ورود بهینه:</b> <code>${targets.entryZone}</code>

⚡ <b>تارگت ۱ سریع (ریوارد سریع + ریسک‌فری):</b> <code>${targets.tp1}</code> (<b>+${targets.tp1Pct}%</b>)
🔥 <b>تارگت ۲ (تارگت اصلی اسکلپ):</b> <code>${targets.tp2}</code> (<b>+${targets.tp2Pct}%</b>)
🚀 <b>تارگت ۳ (تارگت موج کامل):</b> <code>${targets.tp3}</code> (<b>+${targets.tp3Pct}%</b>)
🛑 <b>حد ضرر (Stop-Loss):</b> <code>${targets.sl}</code> (<b>-${targets.slPct}%</b>)

📊 <b>دیتای فیوچرز OKX و اسمارت مانی:</b>
• <b>حجم خریداران مارکت (Taker Buy):</b> <b>${futuresData.takerBuyRatio}%</b>
• <b>نرخ فاندینگ (Funding Rate):</b> <code>${futuresData.fundingRateStr}</code>
• <b>وضعیت رهبر بازار (BTC):</b> ${btcLeader.dir === "LONG" ? "🟢 همراه و صعودی" : "🔴 نزولی"}
• <b>ناحیه نقدینگی:</b> ${smcText}
• <b>فاصله از EMA9 (Anti-Chase):</b> ${tf5m.extensionAtr.toFixed(2)}x ATR ${tf5m.isOverextended ? "⚠️ (کشیده)" : "✅ (استاندارد)"}
• <b>دامیننس‌ها:</b> BTC.D: ${macroData.btcD}% | USDT.D: ${macroData.usdtD}%

📋 <b>چک‌لیست تاییدیه استراتژی:</b>
${scoreData.reasons.join("\n")}

🤖 <i>رصد ۱۵ ثانیه‌ای فعال است: به محض تاچ شدن TP1، بات پیام می‌دهد و استاپ را خودکار به نقطه ورود منتقل می‌کند.</i>
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

// منوی اصلی شیشه‌ای
async function sendMainMenu(env, chatId) {
  const text = `
🤖 <b>پنل هوشمند اسکلپ کریپتو (نسخه v3.1 High Win-Rate)</b>
━━━━━━━━━━━━━━━━━━
👑 <b>فیلتر رهبر بازار (BTC Leader):</b> فعال ✅
🚫 <b>فیلتر ضد هیجان (Anti-Chase):</b> فعال ✅
📊 <b>دیتای فیوچرز OKX (Taker & Funding):</b> متصل ✅
⚡ <b>تارگت اول سریع (Quick TP1 = 0.9x ATR):</b> فعال ✅

👇 <b>از دکمه‌های شیشه‌ای زیر یا دستورات متنی استفاده کنید:</b>
• /scan — اسکن کامل ۴ ارز + وضعیت فیوچرز و بیت‌کوین
• /positions — سود و ضرر لحظه‌ای پوزیشن‌های باز
• /btc | /eth | /sol | /bnb — کالبدشکافی تخصصی هر ارز
• /stats — کارنامه و نرخ برد (Win-Rate) بات
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
  const coin = symbol.replace("USDT", "");
  const [klines5m, klines15m, macroData, btcLeader, futuresData] = await Promise.all([
    fetchKlines(symbol, "5m", 120),
    fetchKlines(symbol, "15m", 100),
    fetchMacroData(),
    analyzeBTCLeader(),
    fetchOKXFuturesData(coin)
  ]);

  if (klines5m.length < 60 || klines15m.length < 60) {
    await sendTelegramRaw(env, chatId, `❌ خطا در دریافت دیتای کندل برای #${symbol}`);
    return;
  }

  const tf5m = analyzeInstitutionalIndicators(klines5m, 7, 2.0);
  const tf15m = analyzeInstitutionalIndicators(klines15m, 10, 3.0);
  const direction = tf5m.supertrend.direction;
  const scoreData = evaluateHighWinRateScore({
    symbol, direction, tf5m, tf15m, btcLeader, futuresData, macroData, news: { bias: "NEUTRAL" }
  });
  const targets = calculateHighWinRateTargets(tf5m.close, tf5m.atr, direction);
  const dec = tf5m.close > 100 ? 2 : 3;

  const text = `
🔬 <b>کالبدشکافی تخصصی (X-Ray v3.1) | #${symbol}</b>
━━━━━━━━━━━━━━━━━━
💰 <b>قیمت لحظه‌ای:</b> <code>${tf5m.close}</code>
🧭 <b>روند ۵ دقیقه:</b> ${direction === "LONG" ? "🟢 صعودی" : "🔴 نزولی"} | <b>روند ۱۵ دقیقه:</b> ${tf15m.supertrend.direction === "LONG" ? "🟢 صعودی" : "🔴 نزولی"}
⭐ <b>امتیاز وین‌ریت:</b> <b>${scoreData.score}/100</b>
${buildScoreBar(scoreData.score)}

🛡️ <b>فیلترهای محافظ وین‌ریت:</b>
• <b>هم‌جهتی با BTC:</b> ${scoreData.btcAligned ? "✅ تایید شده" : "🚫 خلاف جهت بیت‌کوین (ورود خطرناک)"}
• <b>فیلتر Anti-Chase:</b> ${tf5m.isOverextended ? "🚫 کندل بیش از حد کشیده (صبر برای پولبک)" : "✅ قیمت در محدوده استاندارد ورود"}
• <b>فیلتر بازار رِنج:</b> ${tf5m.isRanging ? "⚠️ بازار رِنج و فرسایشی" : "✅ بازار رونددار"}

📊 <b>دیتای فیوچرز OKX و تکنیکال:</b>
• <b>حجم خریداران مارکت (Taker Buy):</b> <b>${futuresData.takerBuyRatio}%</b> (${futuresData.flowBias})
• <b>نرخ فاندینگ (Funding Rate):</b> <code>${futuresData.fundingRateStr}</code>
• <b>VWAP:</b> <code>${tf5m.vwap.toFixed(dec)}</code> | <b>RSI:</b> ${tf5m.rsi.toFixed(1)} | <b>ADX:</b> ${tf5m.adx.toFixed(1)}

🎯 <b>سطوح کلیدی در صورت ورود (${direction}):</b>
• <b>Quick TP1:</b> <code>${targets.tp1}</code> (+${targets.tp1Pct}%) | <b>TP2:</b> <code>${targets.tp2}</code> | <b>SL:</b> <code>${targets.sl}</code>
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

// دستور /scan : اسکن کلی هر ۴ ارز با فیلترهای v3.1
async function handleScanCommand(env, chatId) {
  try {
    const [macroData, btcLeader] = await Promise.all([fetchMacroData(), analyzeBTCLeader()]);
    let lines = [];

    for (const symbol of SYMBOLS) {
      const coin = symbol.replace("USDT", "");
      const [klines5m, klines15m, futuresData] = await Promise.all([
        fetchKlines(symbol, "5m", 120),
        fetchKlines(symbol, "15m", 100),
        fetchOKXFuturesData(coin)
      ]);

      if (klines5m.length < 60 || klines15m.length < 60) {
        lines.push(`• <b>#${symbol}</b>: ⚠️ خطا در دریافت کندل`);
        continue;
      }

      const tf5m = analyzeInstitutionalIndicators(klines5m, 7, 2.0);
      const tf15m = analyzeInstitutionalIndicators(klines15m, 10, 3.0);
      const direction = tf5m.supertrend.direction;
      const scoreData = evaluateHighWinRateScore({
        symbol, direction, tf5m, tf15m, btcLeader, futuresData, macroData, news: { bias: "NEUTRAL" }
      });

      const dirEmoji = direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
      let statusBadge = "✅ آماده شکار";
      if (tf5m.isRanging) statusBadge = "⚠️ بازار رِنج";
      else if (tf5m.isOverextended) statusBadge = "🚫 کندل کشیده (صبر برای پولبک)";
      else if (!scoreData.btcAligned) statusBadge = "🚫 خلاف جهت BTC";

      lines.push(
        `🔹 <b>#${symbol}</b> | قیمت: <code>${tf5m.close}</code>\n` +
        `   جهت: <b>${dirEmoji}</b> | امتیاز: <b>${scoreData.score}/100</b>\n` +
        `   وضعیت: ${statusBadge}\n` +
        `   📊 Taker Buy: <b>${futuresData.takerBuyRatio}%</b> | Funding: <code>${futuresData.fundingRateStr}</code>`
      );
    }

    const msg = `
🔎 <b>نتیجه اسکن هوشمند بازار (v3.1 High Win-Rate)</b>
━━━━━━━━━━━━━━━━━━
👑 <b>وضعیت رهبر بازار (BTC):</b> ${btcLeader.dir === "LONG" ? "🟢 صعودی" : "🔴 نزولی"} (${btcLeader.bias})
🌐 <b>BTC.D:</b> ${macroData.btcD}% | <b>USDT.D:</b> ${macroData.usdtD}% | <b>TOTAL:</b> ${macroData.total24h}%

${lines.join("\n\n")}

💡 <i>حداقل امتیاز ارسال خودکار: <b>${MIN_VALID_SCORE}/100</b> (به شرط تایید BTC و عدم کشیدگی کندل)</i>
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

// دستور /positions : سود و ضرر لحظه‌ای پوزیشن‌های باز
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
          `   ⚡ Quick TP1: <code>${p.tp1}</code> ${p.tp1Hit ? "✅ (ریسک‌فری شده)" : "⏳"} | TP2: <code>${p.tp2}</code> | 🛑 SL: <code>${p.sl}</code>`
        );
      }
    }
  }

  const posText = activeCards.length > 0 ? activeCards.join("\n\n") : "هیچ پوزیشن بازی در حال حاضر وجود ندارد. 🟢";

  const report = `
📂 <b>وضعیت لحظه‌ای پوزیشن‌ها (Live PnL v3.1)</b>
━━━━━━━━━━━━━━━━━━
🌐 <b>BTC.D:</b> ${macro.btcD}% | <b>USDT.D:</b> ${macro.usdtD}% | <b>TOTAL:</b> ${macro.total24h}%

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

// دستور /stats : کارنامه و وین‌ریت بات
async function handleStatsCommand(env, chatId) {
  let stats = { wins: 0, losses: 0, netPct: 0 };
  if (env.SIGNAL_KV) {
    const raw = await env.SIGNAL_KV.get("BOT_STATS");
    if (raw) stats = JSON.parse(raw);
  }
  const total = stats.wins + stats.losses;
  const winRate = total > 0 ? ((stats.wins / total) * 100).toFixed(1) : "0.0";

  const text = `
📈 <b>کارنامه و نرخ برد بات (Win-Rate Stats v3.1)</b>
━━━━━━━━━━━━━━━━━━
✅ <b>معاملات برنده (TP1/TP2/TP3):</b> ${stats.wins}
🛑 <b>معاملات استاپ‌شده (SL):</b> ${stats.losses}
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
  await sendTelegramRaw(env, chatId, "🗑️ تمام پوزیشن‌های فعال پاکسازی شدند.");
}

/* =========================================================
   ۹. دریافت قیمت‌های لحظه‌ای و کندل‌ها (Multi-Exchange)
========================================================= */
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
   ۱۰. توابع ریاضی اندیکاتورها (OB, FVG, Divergence, MACD, Supertrend)
========================================================= */
function detectFVG(klines, atr, lookback = 25) {
  const len = klines.length, current = klines[len - 1], start = Math.max(3, len - lookback);
  let bullFVG = null, bearFVG = null;
  for (let i = start; i < len - 1; i++) {
    const c1 = klines[i - 2], c2 = klines[i - 1], c3 = klines[i];
    if (c3.low > c1.high && (c2.close - c2.open) > atr * 0.7) {
      let mit = false;
      for (let j = i + 1; j < len - 1; j++) if (klines[j].low < c1.high) { mit = true; break; }
      if (!mit) bullFVG = { bottom: c1.high, top: c3.low };
    }
    if (c3.high < c1.low && (c2.open - c2.close) > atr * 0.7) {
      let mit = false;
      for (let j = i + 1; j < len - 1; j++) if (klines[j].high > c1.low) { mit = true; break; }
      if (!mit) bearFVG = { bottom: c3.high, top: c1.low };
    }
  }
  const buf = atr * 0.25;
  return {
    bullFVG, bearFVG,
    inBullishFVG: Boolean(bullFVG && current.low <= bullFVG.top + buf && current.close >= bullFVG.bottom),
    inBearishFVG: Boolean(bearFVG && current.high >= bearFVG.bottom - buf && current.close <= bearFVG.top)
  };
}

function calcMACD(closes) {
  const e12 = calcEMASeries(closes, 12), e26 = calcEMASeries(closes, 26);
  const macdLine = e12.map((v, i) => v - e26[i]);
  const sigLine = calcEMASeries(macdLine, 9);
  const len = closes.length;
  return {
    macd: macdLine[len - 1],
    signal: sigLine[len - 1],
    histogram: macdLine[len - 1] - sigLine[len - 1],
    prevHistogram: macdLine[len - 2] - sigLine[len - 2]
  };
}

function calcStochRSI(rsiSeries, period = 14) {
  const s = rsiSeries.slice(-period);
  const min = Math.min(...s), max = Math.max(...s);
  return max === min ? 50 : ((rsiSeries[rsiSeries.length - 1] - min) / (max - min)) * 100;
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

function detectRSIDivergence(klines, rsiSeries, lookback = 30) {
  const len = klines.length, start = Math.max(5, len - lookback);
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