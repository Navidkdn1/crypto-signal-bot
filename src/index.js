/**
 * 🚀 Crypto Scalping Signal Bot v5.0 (Quant Volume-Flow & High Win-Rate Edition)
 * ------------------------------------------------------------------------------
 * ⏱ تایم‌فریم بهینه‌شده: ۱۵ دقیقه (ماشه ورود) + ۱ ساعت (روند ماکرو) برای حذف نویز ۵ دقیقه
 * 📊 اندیکاتورهای جدید: MFI (شاخص جریان پول)، باندهای انحراف معیار VWAP، شاخص Choppiness و Heikin-Ashi
 * 🛡️ جلوگیری از استاپ‌هانت: Chandelier ATR Stop + تارگت اول بسیار سریع (0.65R) برای ریسک‌فری آنی
 * 💾 ضد پاک شدن بعد از Git Push: ذخیره خودکار توکن تلگرام و آیدی گروه در دیتابیس KV
 */

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"];
const DEFAULT_MAX_POSITIONS = 2;
const DEFAULT_MIN_SCORE = 80;
const MAX_TRADE_DURATION_MIN = 120; // حداکثر ۲ ساعت برای تایم‌فریم ۱۵ دقیقه
const FALLBACK_CHAT_ID = "-1003828847427"; // آیدی پیش‌فرض سوپرگروه شما

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
      const [prices, macro, config, creds] = await Promise.all([
        fetchLivePrices(),
        fetchMacroData(),
        getBotConfig(env),
        getTelegramCredentials(env)
      ]);
      return new Response(JSON.stringify({
        ok: true,
        version: "5.0 Quant Volume-Flow Edition (15m/1H)",
        hasToken: Boolean(creds.token),
        chatId: creds.chatId,
        config,
        livePrices: prices,
        macro
      }, null, 2), { headers: { "Content-Type": "application/json; charset=utf-8" } });
    }

    if (url.pathname === "/test") {
      const { chatId } = await getTelegramCredentials(env);
      const res = await sendMainMenu(env, chatId);
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

    return new Response("🤖 Crypto Signal Bot v5.0 Quant Edition is Active!", { status: 200 });
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
   ۳. رصد لحظه‌ای TP1/TP2/TP3/SL با محافظت در برابر شدوهای لحظه‌ای
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
🛑 <b>برخورد با حد ضرر (Stop-Loss)</b>
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

    // ۲. بررسی برخورد با تارگت سوم (TP3)
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
      pos.sl = pos.tp1;
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
      await env.SIGNAL_KV.put(`POS_${symbol}`, JSON.stringify(pos), { expirationTtl: 5400 });
      activeCount++;
      continue;
    }

    // ۴. بررسی برخورد با تارگت اول سریع (Ultra-Safe TP1 = 0.65R)
    const tp1Hit = isLong ? currentPrice >= pos.tp1 : currentPrice <= pos.tp1;
    if (tp1Hit && !pos.tp1Hit) {
      pos.tp1Hit = true;
      const feeBuffer = (pos.tp1 - pos.entry) * 0.15;
      pos.sl = parseFloat((pos.entry + feeBuffer).toFixed(dec));

      const profitPct = (Math.abs(pos.tp1 - pos.entry) / pos.entry * 100).toFixed(2);
      const levProfit = (profitPct * (pos.leverage || 5)).toFixed(1);
      await recordTradeStat(env, {
        signalId: pos.signalId, symbol, direction: pos.direction, result: "TP1 ✅", pct: parseFloat(profitPct)
      });

      const msg = `
✅⚡️ <b>تارگت اول سریع تاچ شد (Quick TP1)</b>
<blockquote>🔖 <b>سیگنال:</b> <code>${sigTag}</code> | <b>#${symbol}</b> (${pos.direction})
├ <b>قیمت ورود:</b> <code>${pos.entry}</code>
├ <b>قیمت فعلی:</b> <code>${currentPrice.toFixed(dec)}</code>
├ <b>سود فعلی:</b> <b>+${profitPct}%</b> <i>(با اهرم ${pos.leverage}x: <b>+${levProfit}%</b>)</i>
└ <b>مدت زمان:</b> ${durationMin} دقیقه</blockquote>
🛡️ <b>ریسک‌فری کامل (+کارمزد):</b> ۶۵٪ سیو سود کنید؛ استاپ به <code>${pos.sl}</code> منتقل شد.
`.trim();
      await sendTelegramGlobal(env, msg, null, replyMsgId);
      await env.SIGNAL_KV.put(`POS_${symbol}`, JSON.stringify(pos), { expirationTtl: 5400 });
      activeCount++;
      continue;
    }

    // ۵. خروج هوشمند زمانی (Time-Stop)
    if (durationMin >= MAX_TRADE_DURATION_MIN) {
      const livePnl = (((isLong ? currentPrice - pos.entry : pos.entry - currentPrice) / pos.entry) * 100).toFixed(2);
      const msg = `
⏳ <b>انقضای زمان معامله (Time-Stop)</b>
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
   ۴. موتور اسکن اصلی نسخه v5.0 (تایم‌فریم ۱۵ دقیقه + ۱ ساعت)
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
      // دریافت کندل‌های ۱۵ دقیقه (ماشه ورود بدون نویز) و ۱ ساعت (ساختار ماکرو)
      const [klines15m, klines1h, futuresData] = await Promise.all([
        fetchKlines(symbol, "15m", 120),
        fetchKlines(symbol, "1h", 100),
        fetchOKXFuturesData(coin)
      ]);
      if (klines15m.length < 70 || klines1h.length < 60) continue;

      const tfEntry = analyzeQuantIndicators(klines15m, 10, 2.5);
      const tfMacro = analyzeQuantIndicators(klines1h, 10, 3.0);

      let direction = tfEntry.setupDirection || tfMacro.supertrend.direction;

      const news = await fetchNewsSentiment(coin, env.CRYPTOPANIC_API_KEY);
      const scoreData = evaluateQuantScore({
        symbol, direction, tfEntry, tfMacro, btcLeader, futuresData, macroData, news
      });

      const candidate = {
        symbol, direction, entry: tfEntry.close, tfEntry, tfMacro, btcLeader, futuresData, scoreData, macroData
      };

      if (!bestCandidate || scoreData.score > bestCandidate.scoreData.score) {
        bestCandidate = candidate;
      }

      // شروط سخت‌گیرانه نسخه کوانت v5.0 برای بالاترین وین‌ریت:
      if (
        !forceBest &&
        !tfEntry.isChoppy &&
        !tfEntry.isOverextended &&
        !scoreData.oscillatorExhausted &&
        scoreData.btcAligned &&
        scoreData.mtfAligned &&
        tfEntry.hasQuantTrigger &&
        scoreData.score >= config.minScore
      ) {
        const signalId = await getNextSignalId(env);
        const targets = calculateQuantTargets(tfEntry, direction);
        const sentMsgId = await sendProSignalMessage(env, { ...candidate, targets, signalId }, customChatId);

        if (env.SIGNAL_KV) {
          const posState = {
            signalId,
            messageId: sentMsgId,
            symbol,
            direction,
            entry: tfEntry.close,
            tp1: parseFloat(targets.tp1),
            tp2: parseFloat(targets.tp2),
            tp3: parseFloat(targets.tp3),
            sl: parseFloat(targets.sl),
            leverage: targets.leverage,
            tp1Hit: false,
            tp2Hit: false,
            openedAt: Date.now()
          };
          await env.SIGNAL_KV.put(`POS_${symbol}`, JSON.stringify(posState), { expirationTtl: 7200 });
          await env.SIGNAL_KV.put(`COOLDOWN_${symbol}`, "1", { expirationTtl: 1800 });
        }
        activePositions++;
      }
    }

    if (forceBest && bestCandidate) {
      const signalId = await getNextSignalId(env);
      const targets = calculateQuantTargets(bestCandidate.tfEntry, bestCandidate.direction);
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
          await env.SIGNAL_KV.put(`POS_${bestCandidate.symbol}`, JSON.stringify(posState), { expirationTtl: 7200 });
        }
      }
    }
  } catch (error) {
    console.error("Bot Engine Error:", error);
  }
}

/* =========================================================
   ۵. موتور اندیکاتورهای کوانت (MFI + VWAP Bands + Choppiness + Heikin-Ashi)
========================================================= */
function analyzeQuantIndicators(klines, stPeriod = 10, stMult = 2.5) {
  const closedKlines = klines.slice(0, -1);
  const closes = closedKlines.map(k => k.close);
  const liveCandle = klines[klines.length - 1];
  const closed = closedKlines[closedKlines.length - 1];
  const prevClosed = closedKlines[closedKlines.length - 2];

  const ema9 = calcEMA(closes, 9);
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);

  const rsiSeries = calcRSISeries(closes, 14);
  const rsi = rsiSeries[rsiSeries.length - 1];
  const mfi = calcMFI(closedKlines, 14); // شاخص جریان پول (حجم + قیمت)
  const chop = calcChoppinessIndex(closedKlines, 14); // شاخص تشخیص بازار رنج و فرسایشی
  const ha = calcHeikinAshi(closedKlines); // کندل بدون نویز Heikin-Ashi
  const macd = calcMACD(closes);

  const atr = calcATR(closedKlines, 14);
  const adx = calcADX(closedKlines, 14);
  const vwapData = calcVWAPBands(closedKlines.slice(-48)); // VWAP همراه با باندهای انحراف معیار
  const bb = calcBollingerBands(closes, 20, 2);
  const supertrend = calcSupertrend(closedKlines, stPeriod, stMult);

  const divergence = detectRSIDivergence(closedKlines, rsiSeries, 30);
  const orderBlock = detectOrderBlocks(closedKlines, atr, 45);
  const fvg = detectFVG(closedKlines, atr, 25);

  const recent14 = closedKlines.slice(-14);
  const swingLow = Math.min(...recent14.map(k => k.low));
  const swingHigh = Math.max(...recent14.map(k => k.high));

  // ۱. تشخیص شکار نقدینگی (Liquidity Sweep)
  const prior10 = closedKlines.slice(-12, -2);
  const priorLow = Math.min(...prior10.map(k => k.low));
  const priorHigh = Math.max(...prior10.map(k => k.high));

  const bullishSweep = (closed.low < priorLow || prevClosed.low < priorLow) &&
                       closed.close > priorLow && closed.close > closed.open;
  const bearishSweep = (closed.high > priorHigh || prevClosed.high > priorHigh) &&
                       closed.close < priorHigh && closed.close < closed.open;

  // ۲. تشخیص پولبک به ارزش منصفانه (VWAP / EMA20 / Order Block) + تایید Heikin-Ashi
  const nearBullValue =
    closed.low <= ema20 + atr * 0.30 ||
    closed.low <= vwapData.vwap + atr * 0.25 ||
    orderBlock.inBullishOB ||
    fvg.inBullishFVG;

  const bullValueBounce =
    supertrend.direction === "LONG" &&
    nearBullValue &&
    ha.isBullish &&
    closed.close > ema9 &&
    macd.histogram >= macd.prevHistogram;

  const nearBearValue =
    closed.high >= ema20 - atr * 0.30 ||
    closed.high >= vwapData.vwap - atr * 0.25 ||
    orderBlock.inBearishOB ||
    fvg.inBearishFVG;

  const bearValueBounce =
    supertrend.direction === "SHORT" &&
    nearBearValue &&
    !ha.isBullish &&
    closed.close < ema9 &&
    macd.histogram <= macd.prevHistogram;

  // ۳. تشخیص برگشت از باندهای انحراف معیار VWAP (Mean Reversion در جهت روند)
  const vwapLowerBounce = closed.low <= vwapData.lower1 && closed.close > vwapData.lower1 && mfi < 42 && ha.isBullish;
  const vwapUpperReject = closed.high >= vwapData.upper1 && closed.close < vwapData.upper1 && mfi > 58 && !ha.isBullish;

  const avgVol = closedKlines.slice(-21, -1).reduce((s, k) => s + k.volume, 0) / 20;
  const volRatio = closed.volume / (avgVol || 1);

  // ۴. فیلتر دقیق بازار فرسایشی با Choppiness Index (اعداد بالای 58 یعنی بازار کاملاً رنج است)
  const isChoppy = chop > 58.5 || (adx < 19 && bb.bandwidth < 0.0055);

  // ۵. فیلتر عدم خرید در سقف باند VWAP (Anti-Chase)
  const extensionAtr = Math.abs(liveCandle.close - ema20) / (atr || 1);
  const hitVwapExtreme = (supertrend.direction === "LONG" && liveCandle.close >= vwapData.upper2) ||
                         (supertrend.direction === "SHORT" && liveCandle.close <= vwapData.lower2);
  const isOverextended = extensionAtr > 1.40 || hitVwapExtreme;

  let hasQuantTrigger = false;
  let setupType = "منتظر برگشت به VWAP/EMA20";
  let setupDirection = supertrend.direction;

  if (bullishSweep && (divergence.bullish || mfi < 45)) {
    hasQuantTrigger = true;
    setupType = "🧲 شکار نقدینگی کف (Liquidity Sweep + MFI)";
    setupDirection = "LONG";
  } else if (bearishSweep && (divergence.bearish || mfi > 55)) {
    hasQuantTrigger = true;
    setupType = "🧲 شکار نقدینگی سقف (Liquidity Sweep + MFI)";
    setupDirection = "SHORT";
  } else if (bullValueBounce) {
    hasQuantTrigger = true;
    setupType = "🎯 پولبک به محدوده ارزش (VWAP / EMA20 / OB)";
    setupDirection = "LONG";
  } else if (bearValueBounce) {
    hasQuantTrigger = true;
    setupType = "🎯 پولبک به مقاومت (VWAP / EMA20 / OB)";
    setupDirection = "SHORT";
  } else if (vwapLowerBounce && supertrend.direction === "LONG") {
    hasQuantTrigger = true;
    setupType = "📐 واکنش به باند پایینی VWAP (-1.5 SD)";
    setupDirection = "LONG";
  } else if (vwapUpperReject && supertrend.direction === "SHORT") {
    hasQuantTrigger = true;
    setupType = "📐 واکنش به باند بالایی VWAP (+1.5 SD)";
    setupDirection = "SHORT";
  }

  return {
    close: liveCandle.close,
    ema9, ema20, ema50,
    vwap: vwapData.vwap,
    vwapBands: vwapData,
    rsi, mfi, chop, ha, macd,
    atr, adx, bb, supertrend,
    swingLow, swingHigh,
    bullishSweep, bearishSweep,
    volRatio, isChoppy,
    extensionAtr, isOverextended,
    hasQuantTrigger, setupType, setupDirection,
    divergence, orderBlock, fvg
  };
}

// محاسبه شاخص جریان پول (Money Flow Index - MFI 14)
function calcMFI(klines, period = 14) {
  if (klines.length <= period) return 50;
  let posFlow = 0, negFlow = 0;
  for (let i = klines.length - period; i < klines.length; i++) {
    const tp = (klines[i].high + klines[i].low + klines[i].close) / 3;
    const prevTp = (klines[i - 1].high + klines[i - 1].low + klines[i - 1].close) / 3;
    const rawMoneyFlow = tp * klines[i].volume;
    if (tp > prevTp) posFlow += rawMoneyFlow;
    else if (tp < prevTp) negFlow += rawMoneyFlow;
  }
  if (negFlow === 0) return 100;
  const mfr = posFlow / negFlow;
  return 100 - (100 / (1 + mfr));
}

// محاسبه شاخص Choppiness Index (تشخیص بازار رنج در برابر رونددار)
function calcChoppinessIndex(klines, period = 14) {
  const slice = klines.slice(-period - 1);
  if (slice.length <= period) return 50;
  let atrSum = 0;
  let maxHigh = -Infinity, minLow = Infinity;

  for (let i = 1; i < slice.length; i++) {
    const tr = Math.max(
      slice[i].high - slice[i].low,
      Math.abs(slice[i].high - slice[i - 1].close),
      Math.abs(slice[i].low - slice[i - 1].close)
    );
    atrSum += tr;
    if (slice[i].high > maxHigh) maxHigh = slice[i].high;
    if (slice[i].low < minLow) minLow = slice[i].low;
  }

  const range = maxHigh - minLow;
  if (range <= 0) return 100;
  return (100 * Math.log10(atrSum / range)) / Math.log10(period);
}

// محاسبه VWAP به همراه باندهای انحراف معیار (±1.28 SD و ±2.0 SD)
function calcVWAPBands(klines) {
  let pv = 0, vol = 0;
  for (const k of klines) {
    const tp = (k.high + k.low + k.close) / 3;
    pv += tp * k.volume;
    vol += k.volume;
  }
  const vwap = vol === 0 ? klines[klines.length - 1].close : pv / vol;

  let varianceSum = 0;
  for (const k of klines) {
    const tp = (k.high + k.low + k.close) / 3;
    varianceSum += k.volume * Math.pow(tp - vwap, 2);
  }
  const stdDev = vol === 0 ? 0 : Math.sqrt(varianceSum / vol);

  return {
    vwap,
    upper1: vwap + stdDev * 1.28,
    lower1: vwap - stdDev * 1.28,
    upper2: vwap + stdDev * 2.0,
    lower2: vwap - stdDev * 2.0
  };
}

// محاسبه کندل‌های Heikin-Ashi برای تشخیص بدون نویز جهت کندل
function calcHeikinAshi(klines) {
  let haOpen = (klines[0].open + klines[0].close) / 2;
  let haClose = (klines[0].open + klines[0].high + klines[0].low + klines[0].close) / 4;

  for (let i = 1; i < klines.length; i++) {
    const k = klines[i];
    const nextClose = (k.open + k.high + k.low + k.close) / 4;
    const nextOpen = (haOpen + haClose) / 2;
    haOpen = nextOpen;
    haClose = nextClose;
  }
  return { haOpen, haClose, isBullish: haClose > haOpen };
}

/* =========================================================
   ۶. محاسبه حد ضرر Chandelier + تارگت اول بسیار سریع (0.65R)
========================================================= */
function calculateQuantTargets(tfEntry, direction) {
  const price = tfEntry.close;
  const atr = tfEntry.atr;
  const dec = price > 100 ? 2 : 3;
  const isLong = direction === "LONG";
  const m = isLong ? 1 : -1;

  // فرمول Chandelier Exit + Swing Structure برای استاپ ضد شدو
  let structuralSL;
  if (isLong) {
    const obBottom = tfEntry.orderBlock.bullOB ? tfEntry.orderBlock.bullOB.bottom : tfEntry.swingLow;
    const chandelierLong = tfEntry.swingHigh - (atr * 2.2);
    structuralSL = Math.min(tfEntry.swingLow, obBottom, chandelierLong) - (atr * 0.35);
  } else {
    const obTop = tfEntry.orderBlock.bearOB ? tfEntry.orderBlock.bearOB.top : tfEntry.swingHigh;
    const chandelierShort = tfEntry.swingLow + (atr * 2.2);
    structuralSL = Math.max(tfEntry.swingHigh, obTop, chandelierShort) + (atr * 0.35);
  }

  let riskDist = Math.abs(price - structuralSL);
  const minRisk = atr * 1.40;
  const maxRisk = atr * 2.40;
  if (riskDist < minRisk) riskDist = minRisk;
  if (riskDist > maxRisk) riskDist = maxRisk;

  const slPrice = price - m * riskDist;

  // تارگت اول فوق‌سریع (0.65 برابر فاصله ریسک) برای رساندن وین‌ریت به بالای ۸۰٪
  const tp1Price = price + m * (riskDist * 0.65);
  const tp2Price = price + m * (riskDist * 1.40);
  const tp3Price = price + m * (riskDist * 2.30);

  const zoneLow = (price - m * (atr * 0.25)).toFixed(dec);
  const zoneHigh = price.toFixed(dec);

  const slPct = ((riskDist / price) * 100).toFixed(2);
  const tp1Pct = ((Math.abs(tp1Price - price) / price) * 100).toFixed(2);
  const tp2Pct = ((Math.abs(tp2Price - price) / price) * 100).toFixed(2);
  const tp3Pct = ((Math.abs(tp3Price - price) / price) * 100).toFixed(2);

  const rawLev = Math.round(5 / Math.max(0.35, parseFloat(slPct)));
  const leverage = Math.min(10, Math.max(3, rawLev));
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
   ۷. امتیازدهی ۱۰۰ امتیازی نسخه کوانت v5.0
========================================================= */
function evaluateQuantScore({ symbol, direction, tfEntry, tfMacro, btcLeader, futuresData, macroData, news }) {
  let score = 0;
  let reasons = [];

  // ۱. بررسی اشباع همزمان در RSI و MFI (مسدودکننده خرید در سقف!)
  const oscillatorExhausted =
    (direction === "LONG" && (tfEntry.rsi > 64 || tfEntry.mfi > 72)) ||
    (direction === "SHORT" && (tfEntry.rsi < 36 || tfEntry.mfi < 28));

  // ۲. هم‌جهتی ساختار ۱۵ دقیقه با تایم‌فریم ۱ ساعته (۲۰ امتیاز)
  const mtfAligned =
    (direction === "LONG" && tfMacro.supertrend.direction === "LONG" && tfMacro.close >= tfMacro.ema50) ||
    (direction === "SHORT" && tfMacro.supertrend.direction === "SHORT" && tfMacro.close <= tfMacro.ema50);

  if (mtfAligned) {
    score += 20;
    reasons.push("• هم‌جهتی ساختار ۱۵ دقیقه با روند ۱ ساعته (1H) ✅");
  } else if (tfEntry.supertrend.direction === tfMacro.supertrend.direction) {
    score += 14;
    reasons.push("• هم‌جهتی سوپرترند 15m و 1H ✅");
  } else {
    score += 4;
  }

  // ۳. کیفیت ستاپ کوانت و تایید کندل Heikin-Ashi (۲۰ امتیاز)
  if (tfEntry.bullishSweep || tfEntry.bearishSweep) {
    score += 20;
    reasons.push("• جمع‌آوری استاپ‌ها و برگشت (Liquidity Sweep) 🧲");
  } else if (tfEntry.hasQuantTrigger) {
    score += 18;
    reasons.push(`• ${tfEntry.setupType}`);
  } else {
    score += 6;
  }

  // ۴. شاخص جریان پول (MFI) و باندهای VWAP (۱۵ امتیاز)
  const mfiHealthy =
    (direction === "LONG" && tfEntry.mfi >= 35 && tfEntry.mfi <= 68 && tfEntry.close <= tfEntry.vwapBands.upper1) ||
    (direction === "SHORT" && tfEntry.mfi <= 65 && tfEntry.mfi >= 32 && tfEntry.close >= tfEntry.vwapBands.lower1);

  if (mfiHealthy) {
    score += 15;
    reasons.push(`• تایید ورود پول هوشمند (MFI: ${tfEntry.mfi.toFixed(0)}) و باند VWAP 🏦`);
  } else {
    score += 6;
  }

  // ۵. فیلتر رهبر بازار - هم‌جهتی با بیت‌کوین (۱۵ امتیاز)
  let btcAligned = true;
  if (symbol === "BTCUSDT") {
    score += 15;
    reasons.push("• ساختار مستقیم رهبر بازار (BTC) 👑");
  } else {
    if ((direction === "LONG" && btcLeader.dir === "SHORT") || (direction === "SHORT" && btcLeader.dir === "LONG")) {
      btcAligned = false;
      score += 2;
    } else {
      score += 15;
      reasons.push(`• هم‌جهتی ۱۰۰٪ با روند بیت‌کوین (${btcLeader.dir}) 👑`);
    }
  }

  // ۶. دیتای فیوچرز OKX: جریان سفارشات Taker (۱۵ امتیاز)
  if (futuresData.flowBias === direction) {
    score += 15;
    reasons.push(`• تایید سفارشات مارکت فیوچرز (Taker Buy: ${futuresData.takerBuyRatio}%) 📊`);
  } else if (futuresData.flowBias === "NEUTRAL") {
    score += 10;
  } else {
    score += 4;
  }

  // ۷. پایین بودن شاخص Choppiness (بازار رونددار و غیرفرسایشی) + واگرایی (۱۵ امتیاز)
  if (!tfEntry.isChoppy && !oscillatorExhausted) {
    score += 10;
    if (tfEntry.divergence.bullish || tfEntry.divergence.bearish) {
      score += 5;
      reasons.push(`• تایید ${tfEntry.divergence.type} 📐`);
    } else if (tfEntry.chop < 50) {
      score += 5;
      reasons.push(`• بازار کاملاً رونددار (Choppiness: ${tfEntry.chop.toFixed(0)}) ⚡`);
    }
  } else {
    score -= 10;
  }

  let grade = "رد شده ⏳";
  if (score >= 86) grade = "Quant VIP A+ 💎";
  else if (score >= 80) grade = "Quant Grade A 🔥";
  else if (score >= 74) grade = "Grade B+ ⚡️";

  return {
    score: Math.max(0, Math.min(100, score)),
    grade,
    reasons,
    btcAligned,
    mtfAligned,
    oscillatorExhausted
  };
}

/* =========================================================
   ۸. ارسال کارت سیگنال و منوهای تلگرام (نسخه v5.0)
========================================================= */
function buildScoreBar(score) {
  const filled = Math.min(10, Math.max(0, Math.round(score / 10)));
  return "🟩".repeat(filled) + "⬜".repeat(10 - filled);
}

async function sendProSignalMessage(env, data, customChatId = null) {
  const { signalId, symbol, direction, entry, targets, scoreData, tfEntry, btcLeader, futuresData, macroData, isForced } = data;
  const isLong = direction === "LONG";
  const sigTag = `#SIG-${signalId}`;
  const dirTitle = isLong ? "🟢 <b>LONG (خرید کوانت)</b>" : "🔴 <b>SHORT (فروش کوانت)</b>";
  const modeTag = isForced ? "⚡️ <i>سیگنال درخواستی (/force)</i>\n" : "";

  const text = `
${modeTag}${dirTitle} | <b>#${symbol}</b> • <code>15m/1H</code>
🔖 <b>کد سیگنال:</b> <code>${sigTag}</code>
⭐️ <b>اعتبار کوانت:</b> <b>${scoreData.score}/100</b> <i>(${scoreData.grade})</i>
<code>${buildScoreBar(scoreData.score)}</code>

🎯 <b>ستاپ ورود و مدیریت ریسک</b>
├ <b>ستاپ:</b> ${tfEntry.setupType}
├ <b>قیمت ورود:</b> <code>${entry}</code> <i>(پله‌ای: ${targets.entryZone})</i>
└ <b>اهرم و حجم:</b> <code>Isolated ${targets.leverage}x</code> <i>(${targets.marginPct}% Wallet)</i>

💰 <b>تارگت‌ها و استاپ ساختاری</b> <i>(با لمس کپی می‌شود)</i>
├ ⚡️ <b>TP 1 (سریع):</b> <code>${targets.tp1}</code> <i>(+${targets.tp1Pct}% | ریسک‌فری)</i>
├ 🔥 <b>TP 2 (اصلی):</b> <code>${targets.tp2}</code> <i>(+${targets.tp2Pct}%)</i>
├ 🚀 <b>TP 3 (موج):</b> <code>${targets.tp3}</code> <i>(+${targets.tp3Pct}%)</i>
└ 🛡️ <b>SL (Chandelier):</b> <code>${targets.sl}</code> <i>(-${targets.slPct}%)</i>

<blockquote>📊 <b>داده‌های کوانت (v5.0):</b>
• <b>MFI (جریان پول):</b> ${tfEntry.mfi.toFixed(0)} | <b>CHOP:</b> ${tfEntry.chop.toFixed(0)} | <b>Taker:</b> ${futuresData.takerBuyRatio}%
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

  const { chatId: defaultChatId } = await getTelegramCredentials(env);
  const targetChat = customChatId || defaultChatId;
  const tgResp = await sendTelegramRaw(env, targetChat, text, replyMarkup);
  return tgResp?.result?.message_id || null;
}

async function sendMainMenu(env, chatId) {
  const config = await getBotConfig(env);
  const lastId = env.SIGNAL_KV ? (await env.SIGNAL_KV.get("LAST_SIGNAL_ID") || "1000") : "1000";

  const text = `
🤖 <b>پنل هوشمند کوانت کریپتو</b> • <code>v5.0 Quant Edition</code>

<blockquote>🧠 <b>موتور جدید افزایش وین‌ریت (v5.0):</b>
├ <b>تایم‌فریم بدون نویز:</b> ۱۵ دقیقه + روند ۱ ساعته ✅
├ <b>اندیکاتورهای حجم:</b> MFI + باندهای VWAP + CHOP ✅
├ <b>تارگت اول سریع:</b> <code>0.65R</code> همراه با ریسک‌فری خودکار ✅
├ <b>بکاپ خودکار توکن:</b> فعال در دیتابیس KV ✅
└ <b>حداقل امتیاز ارسال:</b> <b>${config.minScore}/100</b> (آخرین کد: <code>#SIG-${lastId}</code>)</blockquote>

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
      const [klines15m, klines1h, futuresData] = await Promise.all([
        fetchKlines(symbol, "15m", 120),
        fetchKlines(symbol, "1h", 100),
        fetchOKXFuturesData(coin)
      ]);

      if (klines15m.length < 70 || klines1h.length < 60) {
        blocks.push(`🔸 <b>#${symbol}</b>: ⚠️ خطا در دریافت کندل`);
        continue;
      }

      const tfEntry = analyzeQuantIndicators(klines15m, 10, 2.5);
      const tfMacro = analyzeQuantIndicators(klines1h, 10, 3.0);
      const direction = tfEntry.setupDirection || tfMacro.supertrend.direction;
      const scoreData = evaluateQuantScore({
        symbol, direction, tfEntry, tfMacro, btcLeader, futuresData, macroData, news: { bias: "NEUTRAL" }
      });

      const dirIcon = direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
      let stateText = "⏳ منتظر پولبک به VWAP/EMA20";
      if (tfEntry.isChoppy) stateText = `⚠️ بازار رِنج (CHOP: ${tfEntry.chop.toFixed(0)})`;
      else if (scoreData.oscillatorExhausted) stateText = "🚫 اشباع MFI/RSI (ورود ممنوع)";
      else if (tfEntry.isOverextended) stateText = "🚫 برخورد با سقف باند VWAP";
      else if (!scoreData.btcAligned) stateText = "🚫 خلاف جهت BTC";
      else if (!scoreData.mtfAligned) stateText = "⏳ ناهماهنگ با روند ۱ ساعته";
      else if (tfEntry.hasQuantTrigger && scoreData.score >= config.minScore) stateText = "🎯 <b>ستاپ کوانت آماده!</b>";

      blocks.push(
        `🪙 <b>#${symbol}</b> • <code>${tfEntry.close}</code>\n` +
        `├ <b>جهت (15m/1H):</b> ${dirIcon} | <b>امتیاز: ${scoreData.score}/100</b>\n` +
        `├ <b>کوانت:</b> MFI: <code>${tfEntry.mfi.toFixed(0)}</code> | CHOP: <code>${tfEntry.chop.toFixed(0)}</code> | Taker: <code>${futuresData.takerBuyRatio}%</code>\n` +
        `└ <b>وضعیت:</b> ${stateText}`
      );
    }

    const msg = `
🔎 <b>اسکن کوانت بازار (v5.0 • 15m/1H)</b>
<blockquote>👑 <b>BTC 1H:</b> ${btcLeader.dir === "LONG" ? "🟢 صعودی" : "🔴 نزولی"} | <b>BTC.D:</b> ${macroData.btcD}% | <b>USDT.D:</b> ${macroData.usdtD}%</blockquote>

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
📂 <b>پوزیشن‌های فعال تحت رصد (v5.0)</b>
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
  const [klines15m, klines1h, macroData, btcLeader, futuresData, config] = await Promise.all([
    fetchKlines(symbol, "15m", 120),
    fetchKlines(symbol, "1h", 100),
    fetchMacroData(),
    analyzeBTCLeader(),
    fetchOKXFuturesData(coin),
    getBotConfig(env)
  ]);

  if (klines15m.length < 70 || klines1h.length < 60) {
    await sendTelegramRaw(env, chatId, `❌ خطا در دریافت دیتای کندل برای #${symbol}`);
    return;
  }

  const tfEntry = analyzeQuantIndicators(klines15m, 10, 2.5);
  const tfMacro = analyzeQuantIndicators(klines1h, 10, 3.0);
  const direction = tfEntry.setupDirection || tfMacro.supertrend.direction;
  const scoreData = evaluateQuantScore({
    symbol, direction, tfEntry, tfMacro, btcLeader, futuresData, macroData, news: { bias: "NEUTRAL" }
  });
  const targets = calculateQuantTargets(tfEntry, direction);
  const dec = tfEntry.close > 100 ? 2 : 3;

  const text = `
🔬 <b>کالبدشکافی کوانت (v5.0 • 15m/1H)</b> | <b>#${symbol}</b>
💰 <b>قیمت لحظه‌ای:</b> <code>${tfEntry.close}</code>
⭐️ <b>امتیاز کوانت:</b> <b>${scoreData.score}/100</b> <i>(حد نصاب: ${config.minScore})</i>
<code>${buildScoreBar(scoreData.score)}</code>

📊 <b>اندیکاتورهای جریان پول و نوسان</b>
├ <b>روند 15m / 1H:</b> ${direction === "LONG" ? "🟢 صعودی" : "🔴 نزولی"} / ${tfMacro.supertrend.direction === "LONG" ? "🟢 صعودی" : "🔴 نزولی"}
├ <b>MFI (جریان پول):</b> <code>${tfEntry.mfi.toFixed(1)}</code> | <b>RSI:</b> <code>${tfEntry.rsi.toFixed(1)}</code>
├ <b>Choppiness (فرسایش):</b> <code>${tfEntry.chop.toFixed(1)}</code> ${tfEntry.isChoppy ? "⚠️ (رنج)" : "✅ (رونددار)"}
├ <b>باندهای VWAP:</b> <code>${tfEntry.vwapBands.lower1.toFixed(dec)}</code> ~ <code>${tfEntry.vwapBands.upper1.toFixed(dec)}</code>
└ <b>سفارشات Taker فیوچرز:</b> <code>${futuresData.takerBuyRatio}%</code> (${futuresData.flowBias})

<blockquote>🎯 <b>سطوح کوانت در صورت ورود (${direction}):</b>
⚡️ <b>Quick TP1:</b> <code>${targets.tp1}</code> | 🔥 <b>TP2:</b> <code>${targets.tp2}</code> | 🛡️ <b>Chandelier SL:</b> <code>${targets.sl}</code></blockquote>
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
${banner}⚙️ <b>تنظیمات زنده بات کوانت (v5.0)</b>
├ 🎯 <b>حداقل امتیاز ارسال خودکار:</b> <b>${config.minScore}/100</b>
└ 📂 <b>سقف پوزیشن همزمان:</b> <b>${config.maxPositions} پوزیشن</b>
`.trim();

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: `${config.minScore === 76 ? "✅ " : ""}متعادل (76+)`, callback_data: "set_score_76" },
        { text: `${config.minScore === 80 ? "✅ " : ""}کوانت (80+)`, callback_data: "set_score_80" },
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
  await sendTelegramRaw(env, chatId, "🗑️ <b>پاکسازی انجام شد</b>\n└ تمام پوزیشن‌های فعال بسته شدند.");
}

/* =========================================================
   ۹. دریافت دیتا از صرافی‌ها (پشتیبانی از 5m, 15m, 1h)
========================================================= */
async function analyzeBTCLeader() {
  try {
    const klines15m = await fetchKlines("BTCUSDT", "15m", 90);
    if (klines15m.length < 60) return { bias: "NEUTRAL", dir: "LONG", strongBear: false, strongBull: false };
    const tf = analyzeQuantIndicators(klines15m, 10, 2.5);
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
      fetch(`https://www.okx.com/api/v5/rubik/stat/taker-volume?ccy=${coin}&instType=CONTRACTS&period=15m`, { headers: BROWSER_HEADERS })
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
    if (takerBuyRatio >= 52.0) flowBias = "LONG";
    else if (takerBuyRatio <= 48.0) flowBias = "SHORT";
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
      const kl = await fetchKlines(sym, "15m", 55);
      if (kl.length) prices[sym] = kl[kl.length - 1].close;
    }
  }
  return prices;
}

async function fetchKlines(symbol, interval, limit = 100) {
  const coin = symbol.replace("USDT", "");
  const okxBar = interval === "1h" ? "1H" : interval === "15m" ? "15m" : "5m";
  const kcType = interval === "1h" ? "1hour" : interval === "15m" ? "15min" : "5min";

  try {
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

/* =========================================================
   ۱۰. توابع ریاضی پایه + ذخیره دائمی توکن و چت‌آیدی در KV
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
    macd: macdLine[len - 1], signal: sigLine[len - 1],
    histogram: macdLine[len - 1] - sigLine[len - 1], prevHistogram: macdLine[len - 2] - sigLine[len - 2]
  };
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

// مدیریت دائمی توکن و چت‌آیدی در KV (ضد پاک شدن بعد از Git Push)
async function getTelegramCredentials(env) {
  let token = env.TELEGRAM_BOT_TOKEN;
  let chatId = env.TELEGRAM_CHAT_ID || FALLBACK_CHAT_ID;

  if (env.SIGNAL_KV) {
    if (token) {
      try { env.SIGNAL_KV.put("SAVED_BOT_TOKEN", token); } catch {}
    } else {
      token = await env.SIGNAL_KV.get("SAVED_BOT_TOKEN");
    }

    if (env.TELEGRAM_CHAT_ID) {
      try { env.SIGNAL_KV.put("SAVED_CHAT_ID", env.TELEGRAM_CHAT_ID); } catch {}
    } else {
      const savedChat = await env.SIGNAL_KV.get("SAVED_CHAT_ID");
      if (savedChat) chatId = savedChat;
    }
  }
  return { token, chatId };
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