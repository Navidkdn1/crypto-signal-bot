/**
 * 🚀 Crypto Scalping Signal Bot v4.0 (Sniper Anti-Stop-Hunt Edition)
 * -----------------------------------------------------------------
 * 🛡️ حد ضرر ساختاری (Structural SL): قرارگیری استاپ پشت Swing High/Low و Order Block واقعی
 * 🎯 حذف ورود در قله/دره: ورود فقط در «پولبک به EMA20/VWAP/OB» یا «شکار نقدینگی (Liquidity Sweep)»
 * 🕯️ تایید کندل بسته‌شده (Closed-Candle Confirmation) برای حذف کامل سیگنال‌های فیکِ وسط کندل
 * 🚫 مسدودساز اشباع (RSI Exhaustion Block): ممنوعیت Long در RSI بالای 64 و Short در RSI زیر 36
 * 🧭 فیلتر ۳ تایم‌فریمی (5m + 15m + 1H Trend) + هم‌جهتی با BTC Leader
 */

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"];
const DEFAULT_MAX_POSITIONS = 2;
const DEFAULT_MIN_SCORE = 80; // افزایش کیفیت پایه برای جلوگیری از معاملات ضعیف
const MAX_TRADE_DURATION_MIN = 75;

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

    if (url.pathname === "/diag") {
      const [prices, macro, config] = await Promise.all([
        fetchLivePrices(),
        fetchMacroData(),
        getBotConfig(env)
      ]);
      return new Response(JSON.stringify({
        ok: true,
        version: "4.0 Sniper Anti-Stop-Hunt Edition",
        config,
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

        // ۱. مدیریت دکمه‌های شیشه‌ای
        if (update.callback_query) {
          const cb = update.callback_query;
          const chatId = cb.message.chat.id;
          const data = cb.data;

          await answerCallback(env, cb.id, "⏳ در حال پردازش...");

          if (data === "cmd_scan") await handleScanCommand(env, chatId);
          else if (data === "cmd_positions") await handlePositionsCommand(env, chatId);
          else if (data === "cmd_stats") await handleStatsCommand(env, chatId);
          else if (data === "cmd_history") await handleHistoryCommand(env, chatId);
          else if (data === "cmd_settings") await handleSettingsMenu(env, chatId);
          else if (data === "cmd_menu") await sendMainMenu(env, chatId);
          else if (data === "cmd_force") await runBotEngine(env, true, chatId);
          else if (data === "cmd_clear") await handleClearCommand(env, chatId);
          else if (data.startsWith("set_score_")) {
            const val = parseInt(data.replace("set_score_", ""), 10);
            await updateBotConfig(env, { minScore: val });
            await handleSettingsMenu(env, chatId, `✅ حداقل امتیاز روی ${val} تنظیم شد.`);
          } else if (data.startsWith("set_maxpos_")) {
            const val = parseInt(data.replace("set_maxpos_", ""), 10);
            await updateBotConfig(env, { maxPositions: val });
            await handleSettingsMenu(env, chatId, `✅ سقف پوزیشن همزمان روی ${val} تنظیم شد.`);
          } else if (data.startsWith("coin_")) {
            const sym = data.replace("coin_", "");
            await handleSingleCoinCommand(env, chatId, sym);
          } else if (data.startsWith("close_")) {
            const sym = data.replace("close_", "");
            if (env.SIGNAL_KV) {
              const raw = await env.SIGNAL_KV.get(`POS_${sym}`);
              const p = raw ? JSON.parse(raw) : null;
              await env.SIGNAL_KV.delete(`POS_${sym}`);
              const sigTag = p?.signalId ? `<code>#SIG-${p.signalId}</code> ` : "";
              await sendTelegramRaw(env, chatId, `🗑️ <b>بستن دستی پوزیشن</b>\n├ <b>سیگنال:</b> ${sigTag}(<b>#${sym}</b>)\n└ <b>وضعیت:</b> از لیست رصد خارج شد ✅`);
            }
          }
          return new Response("OK", { status: 200 });
        }

        // ۲. مدیریت دستورات متنی
        if (update.message && update.message.text) {
          const chatId = update.message.chat.id;
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
          } else if (text === "/settings") {
            await handleSettingsMenu(env, chatId);
          } else if (text === "/force") {
            await runBotEngine(env, true, chatId);
          } else if (text === "/clear") {
            await handleClearCommand(env, chatId);
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

    return new Response("🤖 Crypto Signal Bot v4.0 Sniper Anti-Stop-Hunt is Active!", { status: 200 });
  }
};

/* =========================================================
   ۱. مدیریت شمارنده سیگنال (#SIG-ID) و تنظیمات در KV
========================================================= */
async function getNextSignalId(env) {
  if (!env.SIGNAL_KV) return Math.floor(1000 + Math.random() * 9000);
  const raw = await env.SIGNAL_KV.get("LAST_SIGNAL_ID");
  const currentId = raw ? parseInt(raw, 10) : 1000;
  const nextId = currentId + 1;
  await env.SIGNAL_KV.put("LAST_SIGNAL_ID", String(nextId));
  return nextId;
}

async function getBotConfig(env) {
  const defaults = { minScore: DEFAULT_MIN_SCORE, maxPositions: DEFAULT_MAX_POSITIONS };
  if (!env.SIGNAL_KV) return defaults;
  const raw = await env.SIGNAL_KV.get("BOT_CONFIG");
  if (!raw) return defaults;
  try { return { ...defaults, ...JSON.parse(raw) }; } catch { return defaults; }
}

async function updateBotConfig(env, newValues) {
  if (!env.SIGNAL_KV) return;
  const current = await getBotConfig(env);
  const updated = { ...current, ...newValues };
  await env.SIGNAL_KV.put("BOT_CONFIG", JSON.stringify(updated));
  return updated;
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
   ۳. رصد هوشمند تارگت و استاپ (با محافظت در برابر شدوهای فیک)
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

    const sigTag = `#SIG-${pos.signalId || "1000"}`;
    const replyMsgId = pos.messageId || null;
    const isLong = pos.direction === "LONG";
    const dec = pos.entry > 100 ? 2 : 3;
    const durationMin = Math.max(1, Math.round((Date.now() - (pos.openedAt || Date.now())) / 60000));

    // ۱. بررسی برخورد با حد ضرر (یا نقطه ریسک‌فری)
    const slHit = isLong ? currentPrice <= pos.sl : currentPrice >= pos.sl;
    if (slHit) {
      if (pos.tp1Hit) {
        const msg = `
🛡️ <b>خروج امن در ریسک‌فری (Break-Even)</b>
<blockquote>🔖 <b>سیگنال:</b> <code>${sigTag}</code> | <b>#${symbol}</b> (${pos.direction})
├ <b>نقطه خروج:</b> <code>${pos.sl}</code>
├ <b>وضعیت قبلی:</b> تارگت ۱ قبلاً با سود بسته شده ✅
└ <b>مدت معامله:</b> ${durationMin} دقیقه</blockquote>
`.trim();
        await sendTelegramGlobal(env, msg, null, replyMsgId);
      } else {
        const lossPct = (Math.abs(pos.entry - pos.sl) / pos.entry * 100).toFixed(2);
        const levLoss = (lossPct * (pos.leverage || 5)).toFixed(1);
        await recordTradeStat(env, {
          signalId: pos.signalId, symbol, direction: pos.direction, result: "SL 🛑", pct: -parseFloat(lossPct)
        });
        const msg = `
🛑 <b>برخورد با حد ضرر ساختاری (Stop-Loss)</b>
<blockquote>🔖 <b>سیگنال:</b> <code>${sigTag}</code> | <b>#${symbol}</b> (${pos.direction})
├ <b>قیمت ورود:</b> <code>${pos.entry}</code>
├ <b>قیمت استاپ:</b> <code>${pos.sl}</code>
├ <b>نتیجه:</b> <b>-${lossPct}%</b> <i>(با اهرم: -${levLoss}%)</i>
└ <b>مدت معامله:</b> ${durationMin} دقیقه</blockquote>
`.trim();
        await sendTelegramGlobal(env, msg, null, replyMsgId);
      }
      await env.SIGNAL_KV.delete(`POS_${symbol}`);
      continue;
    }

    // ۲. بررسی برخورد با تارگت سوم (TP3 - فول تارگت)
    const tp3Hit = isLong ? currentPrice >= pos.tp3 : currentPrice <= pos.tp3;
    if (tp3Hit) {
      const profitPct = (Math.abs(pos.tp3 - pos.entry) / pos.entry * 100).toFixed(2);
      const levProfit = (profitPct * (pos.leverage || 5)).toFixed(1);
      if (!pos.tp1Hit) {
        await recordTradeStat(env, {
          signalId: pos.signalId, symbol, direction: pos.direction, result: "TP3 🚀", pct: parseFloat(profitPct)
        });
      }
      const msg = `
🚀💎 <b>فول تارگت نهایی (TP3 Hit!)</b>
<blockquote>🔖 <b>سیگنال:</b> <code>${sigTag}</code> | <b>#${symbol}</b> (${pos.direction})
├ <b>قیمت ورود:</b> <code>${pos.entry}</code>
├ <b>تارگت ۳:</b> <code>${pos.tp3}</code>
├ <b>سود خالص:</b> <b>+${profitPct}%</b> <i>(با اهرم ${pos.leverage}x: <b>+${levProfit}%</b>)</i>
└ <b>مدت معامله:</b> ${durationMin} دقیقه</blockquote>
🏆 <i>معامله با موفقیت کامل بسته شد!</i>
`.trim();
      await sendTelegramGlobal(env, msg, null, replyMsgId);
      await env.SIGNAL_KV.delete(`POS_${symbol}`);
      continue;
    }

    // ۳. بررسی برخورد با تارگت دوم (TP2)
    const tp2Hit = isLong ? currentPrice >= pos.tp2 : currentPrice <= pos.tp2;
    if (tp2Hit && !pos.tp2Hit) {
      pos.tp2Hit = true;
      const wasCounted = pos.tp1Hit;
      pos.tp1Hit = true;
      pos.sl = pos.tp1; // قفل سود روی TP1
      const profitPct = (Math.abs(pos.tp2 - pos.entry) / pos.entry * 100).toFixed(2);
      const levProfit = (profitPct * (pos.leverage || 5)).toFixed(1);

      if (!wasCounted) {
        await recordTradeStat(env, {
          signalId: pos.signalId, symbol, direction: pos.direction, result: "TP2 🔥", pct: parseFloat(profitPct)
        });
      }

      const msg = `
🎯🔥 <b>تارگت دوم تاچ شد (TP2 Hit!)</b>
<blockquote>🔖 <b>سیگنال:</b> <code>${sigTag}</code> | <b>#${symbol}</b> (${pos.direction})
├ <b>قیمت ورود:</b> <code>${pos.entry}</code>
├ <b>قیمت فعلی:</b> <code>${currentPrice.toFixed(dec)}</code>
├ <b>سود فعلی:</b> <b>+${profitPct}%</b> <i>(با اهرم ${pos.leverage}x: <b>+${levProfit}%</b>)</i>
└ <b>مدت زمان:</b> ${durationMin} دقیقه</blockquote>
🛡️ <b>قفل سود:</b> حد ضرر خودکار به <b>TP1 (<code>${pos.tp1}</code>)</b> منتقل شد.
`.trim();
      await sendTelegramGlobal(env, msg, null, replyMsgId);
      await env.SIGNAL_KV.put(`POS_${symbol}`, JSON.stringify(pos), { expirationTtl: 3000 });
      activeCount++;
      continue;
    }

    // ۴. بررسی برخورد با تارگت اول امن (Safe TP1)
    const tp1Hit = isLong ? currentPrice >= pos.tp1 : currentPrice <= pos.tp1;
    if (tp1Hit && !pos.tp1Hit) {
      pos.tp1Hit = true;
      // انتقال استاپ به نقطه ورود با یک بافر کوچک در سود تا کارمزد صرافی هم پوشش داده شود
      const feeBuffer = (pos.tp1 - pos.entry) * 0.12;
      pos.sl = parseFloat((pos.entry + feeBuffer).toFixed(dec));

      const profitPct = (Math.abs(pos.tp1 - pos.entry) / pos.entry * 100).toFixed(2);
      const levProfit = (profitPct * (pos.leverage || 5)).toFixed(1);
      await recordTradeStat(env, {
        signalId: pos.signalId, symbol, direction: pos.direction, result: "TP1 ✅", pct: parseFloat(profitPct)
      });

      const msg = `
✅⚡️ <b>تارگت اول تاچ شد (Safe TP1)</b>
<blockquote>🔖 <b>سیگنال:</b> <code>${sigTag}</code> | <b>#${symbol}</b> (${pos.direction})
├ <b>قیمت ورود:</b> <code>${pos.entry}</code>
├ <b>قیمت فعلی:</b> <code>${currentPrice.toFixed(dec)}</code>
├ <b>سود فعلی:</b> <b>+${profitPct}%</b> <i>(با اهرم ${pos.leverage}x: <b>+${levProfit}%</b>)</i>
└ <b>مدت زمان:</b> ${durationMin} دقیقه</blockquote>
🛡️ <b>ریسک‌فری کامل (+کارمزد):</b> ۶۰٪ سیو سود کنید؛ استاپ به <code>${pos.sl}</code> منتقل شد.
`.trim();
      await sendTelegramGlobal(env, msg, null, replyMsgId);
      await env.SIGNAL_KV.put(`POS_${symbol}`, JSON.stringify(pos), { expirationTtl: 3000 });
      activeCount++;
      continue;
    }

    // ۵. خروج هوشمند زمانی (Time-Stop بعد از ۷۵ دقیقه)
    if (durationMin >= MAX_TRADE_DURATION_MIN) {
      const livePnl = (((isLong ? currentPrice - pos.entry : pos.entry - currentPrice) / pos.entry) * 100).toFixed(2);
      const msg = `
⏳ <b>انقضای زمان اسکلپ (Time-Stop)</b>
<blockquote>🔖 <b>سیگنال:</b> <code>${sigTag}</code> | <b>#${symbol}</b> (${pos.direction})
├ <b>ورود:</b> <code>${pos.entry}</code> | <b>فعلی:</b> <code>${currentPrice.toFixed(dec)}</code>
├ <b>برآیند لحظه‌ای:</b> <b>${livePnl >= 0 ? "+" : ""}${livePnl}%</b>
└ <b>علت:</b> گذشت ${MAX_TRADE_DURATION_MIN} دقیقه و کاهش مومنتوم</blockquote>
`.trim();
      await sendTelegramGlobal(env, msg, null, replyMsgId);
      await env.SIGNAL_KV.delete(`POS_${symbol}`);
      continue;
    }

    activeCount++;
  }
  return activeCount;
}

/* =========================================================
   ۴. موتور اسکن ضد استاپ (v4.0 Sniper Anti-Stop-Hunt Engine)
========================================================= */
async function runBotEngine(env, forceBest = false, customChatId = null) {
  try {
    const config = await getBotConfig(env);
    let activePositions = await checkActivePositionsRealTime(env);
    if (!forceBest && activePositions >= config.maxPositions) return;

    const [macroData, btcLeader] = await Promise.all([
      fetchMacroData(),
      analyzeBTCLeader()
    ]);

    let bestCandidate = null;

    for (const symbol of SYMBOLS) {
      if (!forceBest && activePositions >= config.maxPositions) break;

      if (!forceBest && env.SIGNAL_KV) {
        const existingPos = await env.SIGNAL_KV.get(`POS_${symbol}`);
        const cooldown = await env.SIGNAL_KV.get(`COOLDOWN_${symbol}`);
        if (existingPos || cooldown) continue;
      }

      const coin = symbol.replace("USDT", "");
      const [klines5m, klines15m, futuresData] = await Promise.all([
        fetchKlines(symbol, "5m", 120),
        fetchKlines(symbol, "15m", 120),
        fetchOKXFuturesData(coin)
      ]);
      if (klines5m.length < 70 || klines15m.length < 70) continue;

      const tf5m = analyzeSniperIndicators(klines5m, 10, 2.5); // سوپرترند پایدارتر (10, 2.5) برای حذف نویز
      const tf15m = analyzeSniperIndicators(klines15m, 10, 3.0);

      // تعیین جهت بر اساس ساختار ۱۵ دقیقه + ستاپ اسنایپر ۵ دقیقه
      let direction = tf5m.setupDirection || tf15m.supertrend.direction;

      const news = await fetchNewsSentiment(coin, env.CRYPTOPANIC_API_KEY);
      const scoreData = evaluateSniperScore({
        symbol, direction, tf5m, tf15m, btcLeader, futuresData, macroData, news
      });

      const candidate = {
        symbol, direction, entry: tf5m.close, tf5m, tf15m, btcLeader, futuresData, scoreData, macroData
      };

      if (!bestCandidate || scoreData.score > bestCandidate.scoreData.score) {
        bestCandidate = candidate;
      }

      // شروط سخت‌گیرانه ضد استاپ (Sniper Entry Conditions):
      // ۱. بازار رنج نباشد (!tf5m.isRanging)
      // ۲. کندل کشیده نباشد (!tf5m.isOverextended)
      // ۳. در اشباع خرید/فروش نباشد (!scoreData.rsiExhausted)
      // ۴. هم‌جهت با تایم ۱۵ دقیقه و رهبر بازار (BTC) باشد
      // ۵. حتماً یکی از ۳ ستاپ اسنایپر (پولبک، جمع‌آوری نقدینگی، یا شکست تاییدشده) روی کندل بسته‌شده رخ داده باشد
      if (
        !forceBest &&
        !tf5m.isRanging &&
        !tf5m.isOverextended &&
        !scoreData.rsiExhausted &&
        scoreData.btcAligned &&
        scoreData.mtfAligned &&
        tf5m.hasSniperTrigger &&
        scoreData.score >= config.minScore
      ) {
        const signalId = await getNextSignalId(env);
        const targets = calculateStructuralTargets(tf5m, direction);
        const sentMsgId = await sendProSignalMessage(env, { ...candidate, targets, signalId }, customChatId);

        if (env.SIGNAL_KV) {
          const posState = {
            signalId,
            messageId: sentMsgId,
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
          await env.SIGNAL_KV.put(`POS_${symbol}`, JSON.stringify(posState), { expirationTtl: 4800 });
          // ایجاد ۲۰ دقیقه Cooldown برای جلوگیری از سیگنال‌های پشت سر هم روی یک ارز
          await env.SIGNAL_KV.put(`COOLDOWN_${symbol}`, "1", { expirationTtl: 1200 });
        }
        activePositions++;
      }
    }

    if (forceBest && bestCandidate) {
      const signalId = await getNextSignalId(env);
      const targets = calculateStructuralTargets(bestCandidate.tf5m, bestCandidate.direction);
      const sentMsgId = await sendProSignalMessage(
        env,
        { ...bestCandidate, targets, signalId, isForced: true },
        customChatId
      );

      if (env.SIGNAL_KV) {
        const existing = await env.SIGNAL_KV.get(`POS_${bestCandidate.symbol}`);
        if (!existing) {
          const posState = {
            signalId,
            messageId: sentMsgId,
            symbol: bestCandidate.symbol,
            direction: bestCandidate.direction,
            entry: bestCandidate.entry,
            tp1: parseFloat(targets.tp1),
            tp2: parseFloat(targets.tp2),
            tp3: parseFloat(targets.tp3),
            sl: parseFloat(targets.sl),
            leverage: targets.leverage,
            tp1Hit: false,
            tp2Hit: false,
            openedAt: Date.now()
          };
          await env.SIGNAL_KV.put(`POS_${bestCandidate.symbol}`, JSON.stringify(posState), { expirationTtl: 4800 });
        }
      }
    }
  } catch (error) {
    console.error("Bot Engine Error:", error);
  }
}

/* =========================================================
   ۵. موتور اندیکاتورهای اسنایپر (Pullback + Liquidity Sweep + Swing SL)
========================================================= */
function analyzeSniperIndicators(klines, stPeriod = 10, stMult = 2.5) {
  // نکته طلایی: تحلیل سیگنال روی کندل بسته‌شده (closedCandle) انجام می‌شود تا شدوهای وسط کندل فریب ندهند!
  const closedKlines = klines.slice(0, -1);
  const closes = closedKlines.map(k => k.close);
  const liveCandle = klines[klines.length - 1];
  const closed = closedKlines[closedKlines.length - 1]; // آخرین کندل کامل بسته‌شده
  const prevClosed = closedKlines[closedKlines.length - 2];

  const ema9 = calcEMA(closes, 9);
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, Math.min(100, closes.length - 5)); // فیلتر روند ماکرو

  const rsiSeries = calcRSISeries(closes, 14);
  const rsi = rsiSeries[rsiSeries.length - 1];
  const stochRsi = calcStochRSI(rsiSeries, 14);
  const macd = calcMACD(closes);

  const atr = calcATR(closedKlines, 14);
  const adx = calcADX(closedKlines, 14);
  const vwap = calcVWAP(closedKlines.slice(-48));
  const bb = calcBollingerBands(closes, 20, 2);
  const supertrend = calcSupertrend(closedKlines, stPeriod, stMult);

  const divergence = detectRSIDivergence(closedKlines, rsiSeries, 30);
  const orderBlock = detectOrderBlocks(closedKlines, atr, 45);
  const fvg = detectFVG(closedKlines, atr, 25);

  // ۱. محاسبه دقیق سقف و کف ساختاری (Swing High / Swing Low) برای گذاشتن استاپ امن پشت آن‌ها
  const recent12 = closedKlines.slice(-12);
  const swingLow = Math.min(...recent12.map(k => k.low));
  const swingHigh = Math.max(...recent12.map(k => k.high));

  // ۲. تشخیص جمع‌آوری نقدینگی و استاپ‌هانت (Liquidity Sweep / SFP)
  const prior10 = closedKlines.slice(-12, -2);
  const priorLow = Math.min(...prior10.map(k => k.low));
  const priorHigh = Math.max(...prior10.map(k => k.high));

  // Bullish Sweep: کندل به زیر کف قبلی شدو زده (استاپ‌ها را جمع کرده) ولی بالای آن و سبز بسته شده!
  const bullishSweep = (closed.low < priorLow || prevClosed.low < priorLow) &&
                       closed.close > priorLow &&
                       closed.close > closed.open;

  // Bearish Sweep: کندل به بالای سقف قبلی شدو زده ولی زیر آن و قرمز بسته شده!
  const bearishSweep = (closed.high > priorHigh || prevClosed.high > priorHigh) &&
                       closed.close < priorHigh &&
                       closed.close < closed.open;

  // ۳. تشخیص ستاپ پولبک بهینه به میانگین‌ها یا اوردر بلاک (Pullback Bounce)
  const touchedBullSupport =
    closed.low <= ema20 + atr * 0.25 ||
    closed.low <= vwap + atr * 0.20 ||
    orderBlock.inBullishOB ||
    fvg.inBullishFVG;

  const bullishPullbackBounce =
    supertrend.direction === "LONG" &&
    touchedBullSupport &&
    closed.close > ema9 &&
    closed.close > closed.open && // کندل تایید حتماً سبز بسته شده باشد
    macd.histogram >= macd.prevHistogram;

  const touchedBearResistance =
    closed.high >= ema20 - atr * 0.25 ||
    closed.high >= vwap - atr * 0.20 ||
    orderBlock.inBearishOB ||
    fvg.inBearishFVG;

  const bearishPullbackBounce =
    supertrend.direction === "SHORT" &&
    touchedBearResistance &&
    closed.close < ema9 &&
    closed.close < closed.open && // کندل تایید حتماً قرمز بسته شده باشد
    macd.histogram <= macd.prevHistogram;

  const avgVol = closedKlines.slice(-21, -1).reduce((s, k) => s + k.volume, 0) / 20;
  const volRatio = closed.volume / (avgVol || 1);

  // ۴. فیلتر بازار رنج و نوسان فرسایشی
  const isRanging = (adx < 20 && bb.bandwidth < 0.0050) || bb.bandwidth < 0.0032;

  // ۵. فیلتر سخت‌گیرانه ضد هیجان (Anti-Chase Filter)
  const extensionAtr = Math.abs(liveCandle.close - ema20) / (atr || 1);
  const candleBodyAtr = Math.abs(closed.close - closed.open) / (atr || 1);
  const isOverextended = extensionAtr > 1.45 || candleBodyAtr > 1.60;

  // ۶. تعیین ستاپ نهایی اسنایپر (حذف کامل ورودهای بی‌دلیل وسط روند!)
  let hasSniperTrigger = false;
  let setupType = "ندارد (منتظر پولبک/شکست)";
  let setupDirection = supertrend.direction;

  if (bullishSweep && (divergence.bullish || closed.close > vwap)) {
    hasSniperTrigger = true;
    setupType = "🧲 شکار نقدینگی کف (Bullish Liquidity Sweep)";
    setupDirection = "LONG";
  } else if (bearishSweep && (divergence.bearish || closed.close < vwap)) {
    hasSniperTrigger = true;
    setupType = "🧲 شکار نقدینگی سقف (Bearish Liquidity Sweep)";
    setupDirection = "SHORT";
  } else if (bullishPullbackBounce) {
    hasSniperTrigger = true;
    setupType = "🎯 پولبک دقیق به حمایت (EMA20 / VWAP / OB)";
    setupDirection = "LONG";
  } else if (bearishPullbackBounce) {
    hasSniperTrigger = true;
    setupType = "🎯 پولبک دقیق به مقاومت (EMA20 / VWAP / OB)";
    setupDirection = "SHORT";
  } else if (supertrend.justFlipped && volRatio >= 1.15 && !isOverextended) {
    hasSniperTrigger = true;
    setupType = "⚡ شکست تاییدشده ساختار (Supertrend Breakout)";
    setupDirection = supertrend.direction;
  }

  return {
    close: liveCandle.close,
    closedPrice: closed.close,
    ema9, ema20, ema50, ema200, vwap,
    rsi, stochRsi, macd,
    atr, adx, bb, supertrend,
    swingLow, swingHigh,
    bullishSweep, bearishSweep,
    volRatio, isRanging,
    extensionAtr, isOverextended,
    hasSniperTrigger, setupType, setupDirection,
    divergence, orderBlock, fvg
  };
}

/* =========================================================
   ۶. محاسبه حد ضرر ساختاری هوشمند (Structural Stop-Loss)
========================================================= */
function calculateStructuralTargets(tf5m, direction) {
  const price = tf5m.close;
  const atr = tf5m.atr;
  const dec = price > 100 ? 2 : 3;
  const isLong = direction === "LONG";
  const m = isLong ? 1 : -1;

  // ۱. پیدا کردن نقطه امن ساختاری برای استاپ (پشت Swing Low/High یا پشت Order Block + بافر 0.45x ATR)
  let structuralSL;
  if (isLong) {
    const obBottom = tf5m.orderBlock.bullOB ? tf5m.orderBlock.bullOB.bottom : tf5m.swingLow;
    const baseSupport = Math.min(tf5m.swingLow, obBottom);
    structuralSL = baseSupport - (atr * 0.45); // قرارگیری استاپ زیر شدوی کف قبلی
  } else {
    const obTop = tf5m.orderBlock.bearOB ? tf5m.orderBlock.bearOB.top : tf5m.swingHigh;
    const baseResistance = Math.max(tf5m.swingHigh, obTop);
    structuralSL = baseResistance + (atr * 0.45); // قرارگیری استاپ بالای شدوی سقف قبلی
  }

  // محدود کردن فاصله استاپ بین حداقل 1.35x ATR (که با نویز نخورد) و حداکثر 2.3x ATR (که ریسک زیاد نشود)
  let riskDist = Math.abs(price - structuralSL);
  const minRisk = atr * 1.35;
  const maxRisk = atr * 2.30;
  if (riskDist < minRisk) riskDist = minRisk;
  if (riskDist > maxRisk) riskDist = maxRisk;

  const slPrice = price - m * riskDist;

  // ۲. تارگت اول بسیار امن و در دسترس (0.75 برابر فاصله استاپ) برای ریسک‌فری سریع
  const tp1Price = price + m * (riskDist * 0.75);
  const tp2Price = price + m * (riskDist * 1.50);
  const tp3Price = price + m * (riskDist * 2.50);

  const zoneLow = (price - m * (atr * 0.25)).toFixed(dec);
  const zoneHigh = price.toFixed(dec);

  const slPct = ((riskDist / price) * 100).toFixed(2);
  const tp1Pct = ((Math.abs(tp1Price - price) / price) * 100).toFixed(2);
  const tp2Pct = ((Math.abs(tp2Price - price) / price) * 100).toFixed(2);
  const tp3Pct = ((Math.abs(tp3Price - price) / price) * 100).toFixed(2);

  // کاهش اهرم پیشنهادی برای امنیت کامل در برابر نوسانات
  const rawLev = Math.round(5 / Math.max(0.35, parseFloat(slPct)));
  const leverage = Math.min(12, Math.max(3, rawLev));
  const stopLossWithLev = parseFloat(slPct) * leverage;
  const marginPct = Math.min(20, Math.max(5, Math.round((1.5 / Math.max(1, stopLossWithLev)) * 100)));

  return {
    entryZone: `${zoneLow} ~ ${zoneHigh}`,
    sl: slPrice.toFixed(dec),
    tp1: tp1Price.toFixed(dec),
    tp2: tp2Price.toFixed(dec),
    tp3: tp3Price.toFixed(dec),
    slPct, tp1Pct, tp2Pct, tp3Pct,
    leverage, marginPct
  };
}

/* =========================================================
   ۷. امتیازدهی سخت‌گیرانه ضد استاپ (Sniper Scoring v4.0)
========================================================= */
function evaluateSniperScore({ symbol, direction, tf5m, tf15m, btcLeader, futuresData, macroData, news }) {
  let score = 0;
  let reasons = [];

  // ۱. بررسی اشباع RSI (مسدودکننده خرید در سقف و فروش در کف!)
  const rsiExhausted = (direction === "LONG" && tf5m.rsi > 64) || (direction === "SHORT" && tf5m.rsi < 36);

  // ۲. هم‌جهتی کامل تایم ۵ دقیقه با ساختار ۱۵ دقیقه و روند ماکرو (۲۰ امتیاز)
  const mtfAligned =
    (direction === "LONG" && tf15m.supertrend.direction === "LONG" && tf15m.close >= tf15m.ema50) ||
    (direction === "SHORT" && tf15m.supertrend.direction === "SHORT" && tf15m.close <= tf15m.ema50);

  if (mtfAligned) {
    score += 20;
    reasons.push("• هم‌جهتی کامل ساختار 5m و 15m و EMA50 ✅");
  } else if (tf5m.supertrend.direction === tf15m.supertrend.direction) {
    score += 13;
    reasons.push("• هم‌جهتی سوپرترند 5m و 15m ✅");
  } else {
    score += 4;
  }

  // ۳. ستاپ ورود اسنایپر: پولبک یا جمع‌آوری نقدینگی (۲۰ امتیاز)
  if (tf5m.bullishSweep || tf5m.bearishSweep) {
    score += 20;
    reasons.push("• جمع‌آوری استاپ‌ها و برگشت (Liquidity Sweep) 🧲");
  } else if (tf5m.hasSniperTrigger) {
    score += 18;
    reasons.push(`• ${tf5m.setupType}`);
  } else {
    score += 6;
  }

  // ۴. فیلتر رهبر بازار - هم‌جهتی با بیت‌کوین (۱۵ امتیاز)
  let btcAligned = true;
  if (symbol === "BTCUSDT") {
    score += 15;
    reasons.push("• ساختار مستقیم رهبر بازار (BTC) 👑");
  } else {
    if ((direction === "LONG" && btcLeader.dir === "SHORT") || (direction === "SHORT" && btcLeader.dir === "LONG")) {
      btcAligned = false; // در نسخه 4.0 معامله خلاف جهت بیت‌کوین کاملاً مسدود است!
      score += 2;
    } else {
      score += 15;
      reasons.push(`• هم‌جهتی ۱۰۰٪ با روند بیت‌کوین (${btcLeader.dir}) 👑`);
    }
  }

  // ۵. نواحی اسمارت مانی: Order Block + FVG + VWAP (۱۵ امتیاز)
  const inSmartZone =
    (direction === "LONG" && (tf5m.orderBlock.inBullishOB || tf5m.fvg.inBullishFVG || tf5m.close > tf5m.vwap)) ||
    (direction === "SHORT" && (tf5m.orderBlock.inBearishOB || tf5m.fvg.inBearishFVG || tf5m.close < tf5m.vwap));

  if (inSmartZone && !tf5m.isOverextended) {
    score += 15;
    reasons.push("• ورود در ناحیه امن نقدینگی (OB / VWAP) 🏦");
  } else {
    score += 6;
  }

  // ۶. دیتای فیوچرز OKX: جریان سفارشات Taker (۱۵ امتیاز)
  if (futuresData.flowBias === direction) {
    score += 15;
    reasons.push(`• تایید سفارشات مارکت فیوچرز (Taker: ${futuresData.takerBuyRatio}%) 📊`);
  } else if (futuresData.flowBias === "NEUTRAL") {
    score += 10;
  } else {
    score += 4;
  }

  // ۷. عدم اشباع RSI + واگرایی + حجم و دامیننس (۱۵ امتیاز)
  if (!rsiExhausted) {
    score += 10;
    if (tf5m.divergence.bullish || tf5m.divergence.bearish) {
      score += 5;
      reasons.push(`• تایید ${tf5m.divergence.type} 📐`);
    } else if (tf5m.volRatio >= 1.1 || macroData.bias !== "NEUTRAL") {
      score += 5;
      reasons.push("• فضای باز مومنتوم RSI (بدون اشباع) ✅");
    }
  } else {
    score -= 10; // جریمه سنگین برای اشباع خرید/فروش
  }

  let grade = "رد شده ⏳";
  if (score >= 86) grade = "Sniper VIP A+ 💎";
  else if (score >= 80) grade = "Sniper Grade A 🔥";
  else if (score >= 74) grade = "Grade B+ ⚡️";

  return { score: Math.max(0, Math.min(100, score)), grade, reasons, btcAligned, mtfAligned, rsiExhausted };
}

/* =========================================================
   ۸. ارسال کارت سیگنال و منوهای تلگرام (نسخه v4.0)
========================================================= */
function buildScoreBar(score) {
  const filled = Math.min(10, Math.max(0, Math.round(score / 10)));
  return "🟩".repeat(filled) + "⬜".repeat(10 - filled);
}

async function sendProSignalMessage(env, data, customChatId = null) {
  const { signalId, symbol, direction, entry, targets, scoreData, tf5m, btcLeader, futuresData, macroData, isForced } = data;
  const isLong = direction === "LONG";
  const sigTag = `#SIG-${signalId}`;
  const dirTitle = isLong ? "🟢 <b>LONG (خرید اسنایپر)</b>" : "🔴 <b>SHORT (فروش اسنایپر)</b>";
  const modeTag = isForced ? "⚡️ <i>سیگنال درخواستی (/force)</i>\n" : "";

  const text = `
${modeTag}${dirTitle} | <b>#${symbol}</b> • <code>5m/15m</code>
🔖 <b>کد سیگنال:</b> <code>${sigTag}</code>
⭐️ <b>اعتبار استراتژی:</b> <b>${scoreData.score}/100</b> <i>(${scoreData.grade})</i>
<code>${buildScoreBar(scoreData.score)}</code>

🎯 <b>نقطه ورود و ستاپ معاملاتی</b>
├ <b>ستاپ شکارشده:</b> ${tf5m.setupType}
├ <b>قیمت ورود:</b> <code>${entry}</code> <i>(پله‌ای: ${targets.entryZone})</i>
└ <b>اهرم و حجم:</b> <code>Isolated ${targets.leverage}x</code> <i>(${targets.marginPct}% Wallet)</i>

💰 <b>تارگت‌ها و استاپ ساختاری</b> <i>(با لمس کپی می‌شود)</i>
├ ⚡️ <b>TP 1 (امن):</b> <code>${targets.tp1}</code> <i>(+${targets.tp1Pct}% | ریسک‌فری)</i>
├ 🔥 <b>TP 2 (اصلی):</b> <code>${targets.tp2}</code> <i>(+${targets.tp2Pct}%)</i>
├ 🚀 <b>TP 3 (موج):</b> <code>${targets.tp3}</code> <i>(+${targets.tp3Pct}%)</i>
└ 🛡️ <b>SL (پشت سوئینگ):</b> <code>${targets.sl}</code> <i>(-${targets.slPct}%)</i>

<blockquote>📊 <b>تاییدیه‌های ضد استاپ (v4.0):</b>
• <b>BTC:</b> ${btcLeader.dir === "LONG" ? "🟢 صعودی" : "🔴 نزولی"} | <b>Taker:</b> ${futuresData.takerBuyRatio}% | <b>RSI:</b> ${tf5m.rsi.toFixed(0)}
${scoreData.reasons.slice(0, 3).join("\n")}</blockquote>
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

  const targetChat = customChatId || env.TELEGRAM_CHAT_ID;
  const tgResp = await sendTelegramRaw(env, targetChat, text, replyMarkup);
  return tgResp?.result?.message_id || null;
}

async function sendMainMenu(env, chatId) {
  const config = await getBotConfig(env);
  const lastId = env.SIGNAL_KV ? (await env.SIGNAL_KV.get("LAST_SIGNAL_ID") || "1000") : "1000";

  const text = `
🤖 <b>پنل هوشمند اسکلپ کریپتو</b> • <code>v4.0 Anti-Stop-Hunt</code>

<blockquote>🛡️ <b>ارتقاهای ضد استاپ نسخه 4.0:</b>
├ <b>حد ضرر ساختاری:</b> پشت Swing و Order Block واقعی ✅
├ <b>ورود اسنایپر:</b> فقط در پولبک به EMA20/VWAP یا Sweep ✅
├ <b>فیلتر اشباع RSI:</b> مسدودسازی خرید در سقف (>64) ✅
├ <b>آخرین کد سیگنال:</b> <code>#SIG-${lastId}</code>
└ <b>حداقل امتیاز ارسال:</b> <b>${config.minScore}/100</b></blockquote>

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
        { text: "⚙️ تنظیمات (/settings)", callback_data: "cmd_settings" },
        { text: "⚡️ سیگنال فوری (/force)", callback_data: "cmd_force" }
      ]
    ]
  };

  return await sendTelegramRaw(env, chatId, text, replyMarkup);
}

async function handleScanCommand(env, chatId) {
  try {
    const [macroData, btcLeader, config] = await Promise.all([
      fetchMacroData(),
      analyzeBTCLeader(),
      getBotConfig(env)
    ]);
    let blocks = [];

    for (const symbol of SYMBOLS) {
      const coin = symbol.replace("USDT", "");
      const [klines5m, klines15m, futuresData] = await Promise.all([
        fetchKlines(symbol, "5m", 120),
        fetchKlines(symbol, "15m", 120),
        fetchOKXFuturesData(coin)
      ]);

      if (klines5m.length < 70 || klines15m.length < 70) {
        blocks.push(`🔸 <b>#${symbol}</b>: ⚠️ خطا در دریافت کندل`);
        continue;
      }

      const tf5m = analyzeSniperIndicators(klines5m, 10, 2.5);
      const tf15m = analyzeSniperIndicators(klines15m, 10, 3.0);
      const direction = tf5m.setupDirection || tf15m.supertrend.direction;
      const scoreData = evaluateSniperScore({
        symbol, direction, tf5m, tf15m, btcLeader, futuresData, macroData, news: { bias: "NEUTRAL" }
      });

      const dirIcon = direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
      let stateText = "⏳ منتظر پولبک به EMA20/VWAP";
      if (tf5m.isRanging) stateText = "⚠️ بازار رِنج (ورود ممنوع)";
      else if (scoreData.rsiExhausted) stateText = "🚫 اشباع RSI (خطر برگشت)";
      else if (tf5m.isOverextended) stateText = "🚫 کندل کشیده (صبر برای اصلاح)";
      else if (!scoreData.btcAligned) stateText = "🚫 خلاف جهت BTC";
      else if (!scoreData.mtfAligned) stateText = "⏳ عدم هماهنگی 5m با 15m";
      else if (tf5m.hasSniperTrigger && scoreData.score >= config.minScore) stateText = "🎯 <b>ستاپ اسنایپر آماده!</b>";

      blocks.push(
        `🪙 <b>#${symbol}</b> • <code>${tf5m.close}</code>\n` +
        `├ <b>جهت و امتیاز:</b> ${dirIcon} | <b>${scoreData.score}/100</b>\n` +
        `├ <b>ستاپ:</b> ${tf5m.setupType}\n` +
        `└ <b>فیلتر:</b> ${stateText}`
      );
    }

    const msg = `
🔎 <b>اسکن اسنایپر بازار (v4.0)</b> • <i>حد نصاب: ${config.minScore}</i>
<blockquote>👑 <b>BTC:</b> ${btcLeader.dir === "LONG" ? "🟢 صعودی" : "🔴 نزولی"} | <b>BTC.D:</b> ${macroData.btcD}% | <b>USDT.D:</b> ${macroData.usdtD}%</blockquote>

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
          { text: "⚡️ سیگنال فوری (/force)", callback_data: "cmd_force" }
        ]
      ]
    };

    await sendTelegramRaw(env, chatId, msg, replyMarkup);
  } catch (e) {
    await sendTelegramRaw(env, chatId, `❌ خطا در اسکن بازار: ${e.message}`);
  }
}

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
📂 <b>پوزیشن‌های فعال تحت رصد (v4.0)</b>
🌐 <code>BTC.D: ${macro.btcD}% | USDT.D: ${macro.usdtD}% | TOTAL: ${macro.total24h}%</code>

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
  const coin = symbol.replace("USDT", "");
  const [klines5m, klines15m, macroData, btcLeader, futuresData, config] = await Promise.all([
    fetchKlines(symbol, "5m", 120),
    fetchKlines(symbol, "15m", 120),
    fetchMacroData(),
    analyzeBTCLeader(),
    fetchOKXFuturesData(coin),
    getBotConfig(env)
  ]);

  if (klines5m.length < 70 || klines15m.length < 70) {
    await sendTelegramRaw(env, chatId, `❌ خطا در دریافت دیتای کندل برای #${symbol}`);
    return;
  }

  const tf5m = analyzeSniperIndicators(klines5m, 10, 2.5);
  const tf15m = analyzeSniperIndicators(klines15m, 10, 3.0);
  const direction = tf5m.setupDirection || tf15m.supertrend.direction;
  const scoreData = evaluateSniperScore({
    symbol, direction, tf5m, tf15m, btcLeader, futuresData, macroData, news: { bias: "NEUTRAL" }
  });
  const targets = calculateStructuralTargets(tf5m, direction);
  const dec = tf5m.close > 100 ? 2 : 3;

  const text = `
🔬 <b>کالبدشکافی ضد استاپ (v4.0)</b> | <b>#${symbol}</b>
💰 <b>قیمت لحظه‌ای:</b> <code>${tf5m.close}</code>
⭐️ <b>امتیاز اسنایپر:</b> <b>${scoreData.score}/100</b> <i>(حد نصاب: ${config.minScore})</i>
<code>${buildScoreBar(scoreData.score)}</code>

🛡️ <b>فیلترهای محافظ سرمایه</b>
├ <b>ستاپ ۵ دقیقه:</b> ${tf5m.setupType}
├ <b>هماهنگی 5m و 15m:</b> ${scoreData.mtfAligned ? "✅ هم‌جهت" : "🚫 ناهماهنگ"}
├ <b>هم‌جهتی با BTC:</b> ${scoreData.btcAligned ? "✅ تایید شده" : "🚫 خلاف جهت بیت‌کوین"}
├ <b>اشباع RSI:</b> ${scoreData.rsiExhausted ? "🚫 در منطقه اشباع (ورود ممنوع)" : `✅ استاندارد (${tf5m.rsi.toFixed(1)})`}
└ <b>سقف و کف ساختاری:</b> کف <code>${tf5m.swingLow.toFixed(dec)}</code> | سقف <code>${tf5m.swingHigh.toFixed(dec)}</code>

<blockquote>🎯 <b>سطوح ساختاری در صورت ورود (${direction}):</b>
⚡️ <b>Safe TP1:</b> <code>${targets.tp1}</code> | 🔥 <b>TP2:</b> <code>${targets.tp2}</code> | 🛡️ <b>Structural SL:</b> <code>${targets.sl}</code></blockquote>
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
    ? history.map(item =>
        `├ <code>#SIG-${item.signalId || "1000"}</code> • <b>#${item.symbol}</b> (${item.direction}) ➔ ${item.result} (<b>${item.pct >= 0 ? "+" : ""}${item.pct.toFixed(2)}%</b>)`
      ).join("\n")
    : "└ هنوز سیگنالی بسته نشده است.";

  const text = `
📜 <b>تاریخچه ۱۰ سیگنال آخر بات</b>
<blockquote>${lines}</blockquote>
`.trim();

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "📈 مشاهده وین‌ریت کلی (/stats)", callback_data: "cmd_stats" },
        { text: "🏠 منوی اصلی", callback_data: "cmd_menu" }
      ]
    ]
  };

  await sendTelegramRaw(env, chatId, text, replyMarkup);
}

async function handleStatsCommand(env, chatId) {
  let stats = { wins: 0, losses: 0, netPct: 0 };
  if (env.SIGNAL_KV) {
    const raw = await env.SIGNAL_KV.get("BOT_STATS");
    if (raw) { try { stats = JSON.parse(raw); } catch {} }
  }
  const total = stats.wins + stats.losses;
  const winRate = total > 0 ? ((stats.wins / total) * 100).toFixed(1) : "0.0";

  const text = `
📈 <b>کارنامه و آمار عملکرد بات</b>
<blockquote>├ ✅ <b>تارگت‌های موفق (Wins):</b> ${stats.wins}
├ 🛑 <b>استاپ‌ها (Losses):</b> ${stats.losses}
├ 🏆 <b>نرخ برد (Win-Rate):</b> <b>${winRate}%</b>
└ 💰 <b>برآیند خالص (بدون اهرم):</b> <b>${stats.netPct >= 0 ? "+" : ""}${stats.netPct.toFixed(2)}%</b></blockquote>
`.trim();

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "📜 تاریخچه سیگنال‌ها (/history)", callback_data: "cmd_history" },
        { text: "🏠 منوی اصلی", callback_data: "cmd_menu" }
      ]
    ]
  };

  await sendTelegramRaw(env, chatId, text, replyMarkup);
}

async function handleSettingsMenu(env, chatId, notice = null) {
  const config = await getBotConfig(env);
  const banner = notice ? `<blockquote>${notice}</blockquote>\n` : "";

  const text = `
${banner}⚙️ <b>تنظیمات زنده بات (نسخه ضد استاپ v4.0)</b>
├ 🎯 <b>حداقل امتیاز ارسال خودکار:</b> <b>${config.minScore}/100</b>
└ 📂 <b>سقف پوزیشن همزمان:</b> <b>${config.maxPositions} پوزیشن</b>

💡 <i>برای جلوگیری از استاپ خوردن، پیشنهاد می‌شود حداقل امتیاز را روی <b>80+</b> یا <b>84+</b> نگه دارید.</i>
`.trim();

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: `${config.minScore === 76 ? "✅ " : ""}متعادل (76+)`, callback_data: "set_score_76" },
        { text: `${config.minScore === 80 ? "✅ " : ""}اسنایپر (80+)`, callback_data: "set_score_80" },
        { text: `${config.minScore === 84 ? "✅ " : ""}فوق‌امن (84+)`, callback_data: "set_score_84" }
      ],
      [
        { text: `${config.maxPositions === 1 ? "✅ " : ""}۱ پوزیشن`, callback_data: "set_maxpos_1" },
        { text: `${config.maxPositions === 2 ? "✅ " : ""}۲ پوزیشن`, callback_data: "set_maxpos_2" },
        { text: `${config.maxPositions === 3 ? "✅ " : ""}۳ پوزیشن`, callback_data: "set_maxpos_3" }
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
  const { signalId, symbol, direction, result, pct } = tradeInfo;

  let stats = { wins: 0, losses: 0, netPct: 0 };
  const rawStats = await env.SIGNAL_KV.get("BOT_STATS");
  if (rawStats) { try { stats = JSON.parse(rawStats); } catch {} }
  if (pct >= 0) stats.wins += 1;
  else stats.losses += 1;
  stats.netPct += pct;
  await env.SIGNAL_KV.put("BOT_STATS", JSON.stringify(stats));

  let history = [];
  const rawHist = await env.SIGNAL_KV.get("SIGNAL_HISTORY");
  if (rawHist) { try { history = JSON.parse(rawHist); } catch {} }
  history.unshift({ signalId: signalId || 1000, symbol, direction, result, pct, closedAt: Date.now() });
  await env.SIGNAL_KV.put("SIGNAL_HISTORY", JSON.stringify(history.slice(0, 10)));
}

async function handleClearCommand(env, chatId) {
  if (env.SIGNAL_KV) {
    for (const sym of SYMBOLS) await env.SIGNAL_KV.delete(`POS_${sym}`);
  }
  await sendTelegramRaw(env, chatId, "🗑️ <b>پاکسازی انجام شد</b>\n└ تمام پوزیشن‌های فعال بسته شدند و بات آماده شکار ستاپ اسنایپر بعدی است.");
}

/* =========================================================
   ۹. توابع دریافت دیتا و ریاضیات پایه
========================================================= */
async function analyzeBTCLeader() {
  try {
    const klines5m = await fetchKlines("BTCUSDT", "5m", 90);
    if (klines5m.length < 60) return { bias: "NEUTRAL", dir: "LONG", strongBear: false, strongBull: false };
    const tf = analyzeSniperIndicators(klines5m, 10, 2.5);
    const aboveVwap = tf.close > tf.vwap;
    const strongBull = tf.supertrend.direction === "LONG" && aboveVwap && tf.ema9 >= tf.ema20;
    const strongBear = tf.supertrend.direction === "SHORT" && !aboveVwap && tf.ema9 <= tf.ema20;
    let bias = strongBull ? "BULLISH" : strongBear ? "BEARISH" : tf.supertrend.direction === "LONG" ? "MILD_BULL" : "MILD_BEAR";
    return { price: tf.close, dir: tf.supertrend.direction, bias, strongBull, strongBear };
  } catch {
    return { bias: "NEUTRAL", dir: "LONG", strongBear: false, strongBull: false };
  }
}

async function fetchOKXFuturesData(coin) {
  let fundingRate = 0.0001, takerBuyRatio = 50.0, flowBias = "NEUTRAL";
  try {
    const [fundRes, takerRes] = await Promise.all([
      fetch(`https://www.okx.com/api/v5/public/funding-rate?instId=${coin}-USDT-SWAP`, { headers: BROWSER_HEADERS }),
      fetch(`https://www.okx.com/api/v5/rubik/stat/taker-volume?ccy=${coin}&instType=CONTRACTS&period=5m`, { headers: BROWSER_HEADERS })
    ]);
    if (fundRes.ok) {
      const fJson = await fundRes.json();
      if (fJson.data?.[0]) fundingRate = parseFloat(fJson.data[0].fundingRate) * 100;
    }
    if (takerRes.ok) {
      const tJson = await takerRes.json();
      if (tJson.data?.length > 0) {
        const latest = tJson.data[0];
        const sellVol = parseFloat(latest[1]) || 1, buyVol = parseFloat(latest[2]) || 1;
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
      const btcD = data.market_cap_percentage.btc || 55, usdtD = data.market_cap_percentage.usdt || 5, total24h = data.market_cap_change_percentage_24h_usd || 0;
      let bias = (total24h > 0.5 && usdtD < 7.0) ? "BULLISH" : total24h < -0.5 ? "BEARISH" : "NEUTRAL";
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
      const totalMcap = parseFloat(g.total_mcap) || 2500000000000, btcD = parseFloat(g.btc_d) || 55, total24h = parseFloat(g.mcap_change) || 0;
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
    macd: macdLine[len - 1], signal: sigLine[len - 1],
    histogram: macdLine[len - 1] - sigLine[len - 1], prevHistogram: macdLine[len - 2] - sigLine[len - 2]
  };
}

function calcStochRSI(rsiSeries, period = 14) {
  const s = rsiSeries.slice(-period), min = Math.min(...s), max = Math.max(...s);
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
    if (klines[i].low <= klines[i - 1].low && klines[i].low <= klines[i - 2].low && klines[i].low <= klines[i + 1].low) lows.push({ index: i, price: klines[i].low, rsi: rsiSeries[i] });
    if (klines[i].high >= klines[i - 1].high && klines[i].high >= klines[i - 2].high && klines[i].high >= klines[i + 1].high) highs.push({ index: i, price: klines[i].high, rsi: rsiSeries[i] });
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
  const slice = closes.slice(-period), mean = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period);
  return { upper: mean + mult * std, middle: mean, lower: mean - mult * std, bandwidth: ((mean + mult * std) - (mean - mult * std)) / mean };
}

function calcSupertrend(klines, period = 10, multiplier = 2.5) {
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
  let sum = 0;
  for (let i = klines.length - period; i < klines.length; i++) sum += Math.max(klines[i].high - klines[i].low, Math.abs(klines[i].high - klines[i - 1].close), Math.abs(klines[i].low - klines[i - 1].close));
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

async function sendTelegramGlobal(env, text, replyMarkup = null, replyToMessageId = null) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return { ok: false };
  return await sendTelegramRaw(env, env.TELEGRAM_CHAT_ID, text, replyMarkup, replyToMessageId);
}

async function sendTelegramRaw(env, chatId, text, replyMarkup = null, replyToMessageId = null) {
  const payload = {
    chat_id: chatId,
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

  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return await res.json();
}