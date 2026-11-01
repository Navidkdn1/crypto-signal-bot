/**
 * 🚀 Crypto Signal Bot v7.0 (Active Pro Scalper - 5m/15m Multi-Setup Engine)
 * --------------------------------------------------------------------------
 * ⚡ تایم‌فریم سریع تریدرهای اسکلپ: ۵ دقیقه (ماشه ورود) + ۱۵ دقیقه (فیلتر روند)
 * 🔥 ۴ موتور مستقل سیگنال‌دهی:
 *    1) EMA 9/21 Ribbon Pullback + StochRSI Cross
 *    2) Institutional VWAP Reclaim / Rejection
 *    3) Fast Scalping MACD (8, 21, 5) Momentum Flip
 *    4) Liquidity Sweep (SFP) & Volatility Breakout
 * 🎯 افزایش تعداد سیگنال‌های روزانه (آستانه امتیاز متعادل 72+ و سقف ۴ پوزیشن همزمان)
 * 🛡️ حفظ حد ضرر ساختاری پشت سوئینگ + ریسک‌فری خودکار در TP1 + دستور /reset
 */

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"];
const MAX_OPEN_POSITIONS = 4; // امکان باز بودن همزمان هر ۴ ارز برای از دست نرفتن سیگنال‌ها
const FIXED_MIN_SCORE = 72;   // آستانه استاندارد اسکلپ فعال
const MAX_TRADE_DURATION_MIN = 90; // مهلت ۹۰ دقیقه‌ای برای معاملات ۵ دقیقه
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

    if (url.pathname === "/diag") {
      const [prices, breadth, creds] = await Promise.all([
        fetchLivePrices(),
        analyzeLiveMarketBreadth(),
        getTelegramCredentials(env)
      ]);
      return new Response(JSON.stringify({
        ok: true,
        version: "7.0 Active Pro Scalper (5m/15m)",
        fixedMinScore: FIXED_MIN_SCORE,
        hasToken: Boolean(creds.token),
        chatId: creds.chatId,
        livePrices: prices,
        liveMarketBreadth: breadth
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
          else if (data === "cmd_menu") await sendMainMenu(env, chatId);
          else if (data === "cmd_force") await runBotEngine(env, true, chatId);
          else if (data === "cmd_clear") await handleClearCommand(env, chatId);
          else if (data === "cmd_reset") await handleResetCommand(env, chatId);
          else if (data.startsWith("coin_")) {
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

    return new Response("🤖 Crypto Signal Bot v7.0 Active Pro Scalper is Running!", { status: 200 });
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
🛡️ <b>بسته شدن در نقطه ریسک‌فری (Break-Even)</b>
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

    // ۴. بررسی برخورد با تارگت اول سریع (TP1)
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
✅⚡️ <b>تارگت اول تاچ شد (TP1 Hit!)</b>
<blockquote>🔖 <b>سیگنال:</b> <code>${sigTag}</code> | <b>#${symbol}</b> (${pos.direction})
├ <b>قیمت ورود:</b> <code>${pos.entry}</code>
├ <b>قیمت فعلی:</b> <code>${currentPrice.toFixed(dec)}</code>
├ <b>سود فعلی:</b> <b>+${profitPct}%</b> <i>(با اهرم ${pos.leverage}x: <b>+${levProfit}%</b>)</i>
└ <b>مدت زمان:</b> ${durationMin} دقیقه</blockquote>
🛡️ <b>ریسک‌فری فعال شد:</b> ۵۰٪ سیو سود کنید؛ استاپ به <code>${pos.sl}</code> منتقل شد.
`.trim();
      await sendTelegramGlobal(env, msg, null, replyMsgId);
      await env.SIGNAL_KV.put(`POS_${symbol}`, JSON.stringify(pos), { expirationTtl: 5400 });
      activeCount++;
      continue;
    }

    // ۵. خروج زمانی پس از ۹۰ دقیقه
    if (durationMin >= MAX_TRADE_DURATION_MIN) {
      const livePnl = (((isLong ? currentPrice - pos.entry : pos.entry - currentPrice) / pos.entry) * 100).toFixed(2);
      const msg = `
⏳ <b>اتمام مهلت زمانی اسکلپ (Time-Stop)</b>
<blockquote>🔖 <b>سیگنال:</b> <code>${sigTag}</code> | <b>#${symbol}</b> (${pos.direction})
├ <b>ورود:</b> <code>${pos.entry}</code> | <b>فعلی:</b> <code>${currentPrice.toFixed(dec)}</code>
├ <b>برآیند لحظه‌ای:</b> <b>${livePnl >= 0 ? "+" : ""}${livePnl}%</b>
└ <b>علت:</b> گذشت ۹۰ دقیقه از ستاپ اسکلپ ۵ دقیقه</blockquote>
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
   ۵. موتور اسکن اصلی نسخه v7.0 (Active Pro Scalper 5m/15m)
========================================================= */
async function runBotEngine(env, forceBest = false, customChatId = null) {
  try {
    let activePositions = await checkActivePositionsRealTime(env);
    if (!forceBest && activePositions >= MAX_OPEN_POSITIONS) return;

    const breadth = await analyzeLiveMarketBreadth();
    let bestCandidate = null;

    for (const symbol of SYMBOLS) {
      if (!forceBest && activePositions >= MAX_OPEN_POSITIONS) break;

      if (!forceBest && env.SIGNAL_KV) {
        const existingPos = await env.SIGNAL_KV.get(`POS_${symbol}`);
        const cooldown = await env.SIGNAL_KV.get(`COOLDOWN_${symbol}`);
        if (existingPos || cooldown) continue;
      }

      const coin = symbol.replace("USDT", "");
      const [klines5m, klines15m, futuresData] = await Promise.all([
        fetchKlines(symbol, "5m", 120),
        fetchKlines(symbol, "15m", 100),
        fetchOKXFuturesData(coin)
      ]);
      if (klines5m.length < 60 || klines15m.length < 60) continue;

      const tf5m = analyzeProScalper(klines5m);
      const tf15m = analyzeProScalper(klines15m);

      const direction = tf5m.setupDirection;
      const scoreData = evaluateProScalpScore({
        symbol, direction, tf5m, tf15m, breadth, futuresData
      });

      const candidate = {
        symbol, direction, entry: tf5m.close, tf5m, tf15m, breadth, futuresData, scoreData
      };

      if (!bestCandidate || scoreData.score > bestCandidate.scoreData.score) {
        bestCandidate = candidate;
      }

      // شرایط متعادل و فعال اسکلپ (بدون قفل‌های بیش از حد):
      // کافی است یکی از ۴ ستاپ تریدرهای معروف فعال شده باشد، کندل بیش از حد کشیده نباشد و امتیاز به 72 برسد!
      if (
        !forceBest &&
        !tf5m.isFlatChop &&
        !tf5m.isOverextended &&
        !scoreData.extremeContraBtc &&
        tf5m.hasActiveSetup &&
        scoreData.score >= FIXED_MIN_SCORE
      ) {
        const signalId = await getNextSignalId(env);
        const targets = calculateScalpTargets(tf5m, direction);
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
          await env.SIGNAL_KV.put(`POS_${symbol}`, JSON.stringify(posState), { expirationTtl: 5400 });
          // فقط ۱۰ دقیقه Cooldown تا سیگنال‌های بعدی از دست نروند
          await env.SIGNAL_KV.put(`COOLDOWN_${symbol}`, "1", { expirationTtl: 600 });
        }
        activePositions++;
      }
    }

    if (forceBest && bestCandidate) {
      const signalId = await getNextSignalId(env);
      const targets = calculateScalpTargets(bestCandidate.tf5m, bestCandidate.direction);
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
          await env.SIGNAL_KV.put(`POS_${bestCandidate.symbol}`, JSON.stringify(posState), { expirationTtl: 5400 });
        }
      }
    }
  } catch (error) {
    console.error("Bot Engine Error:", error);
  }
}

/* =========================================================
   ۶. موتور ۴ ستاپ معروف اسکلپ (EMA 9/21 + VWAP + Fast MACD 8,21,5 + StochRSI)
========================================================= */
function analyzeProScalper(klines) {
  const closedKlines = klines.slice(0, -1);
  const closes = closedKlines.map(k => k.close);
  const liveCandle = klines[klines.length - 1];
  const c0 = closedKlines[closedKlines.length - 1];
  const c1 = closedKlines[closedKlines.length - 2];

  // ۱. ریبون محبوب اسکلپرها: EMA 9 + EMA 21 + EMA 50
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes, 50);

  // ۲. اندیکاتورهای مومنتوم سریع مخصوص کریپتو: RSI 14 + StochRSI + Fast MACD (8, 21, 5)
  const rsiSeries = calcRSISeries(closes, 14);
  const rsi = rsiSeries[rsiSeries.length - 1];
  const prevRsi = rsiSeries[rsiSeries.length - 2];
  const stochRsi = calcStochRSI(rsiSeries, 14);
  const fastMacd = calcFastMACD(closes, 8, 21, 5); // تنظیمات سریع اسکلپ (8, 21, 5)

  // ۳. مرجع حجم روزانه مؤسسات: VWAP + ATR + ADX + Bollinger
  const atr = calcATR(closedKlines, 14);
  const adx = calcWilderADX(closedKlines, 14);
  const vwap = calcVWAPBands(closedKlines.slice(-48)).vwap;
  const bb = calcBollingerBands(closes, 20, 2);
  const supertrend = calcSupertrend(closedKlines, 10, 2.2);

  const recent12 = closedKlines.slice(-12);
  const swingLow = Math.min(...recent12.map(k => k.low));
  const swingHigh = Math.max(...recent12.map(k => k.high));

  const avgVol = closedKlines.slice(-21, -1).reduce((s, k) => s + k.volume, 0) / 20;
  const volRatio = Math.max(c0.volume, liveCandle.volume) / (avgVol || 1);

  const isBullCandle = c0.close > c0.open;
  const isBearCandle = c0.close < c0.open;

  // --- بررسی ۴ ستاپ طلایی تریدرهای اسکلپ ---

  // ستاپ ۱: EMA 9/21 Ribbon Pullback (پولبک به ریبون ۹ و ۲۱ در جهت روند)
  const bullRibbonPullback =
    ema9 >= ema21 &&
    c0.low <= ema9 + atr * 0.25 &&
    c0.close >= ema21 &&
    isBullCandle &&
    (stochRsi < 75 || rsi > prevRsi);

  const bearRibbonPullback =
    ema9 <= ema21 &&
    c0.high >= ema9 - atr * 0.25 &&
    c0.close <= ema21 &&
    isBearCandle &&
    (stochRsi > 25 || rsi < prevRsi);

  // ستاپ ۲: VWAP Reclaim / Rejection (پس گرفتن خط VWAP یا واکنش مستقیم به آن)
  const bullVwapReclaim =
    (c1.low <= vwap || c0.low <= vwap + atr * 0.15) &&
    c0.close > vwap &&
    isBullCandle &&
    fastMacd.histogram >= fastMacd.prevHistogram;

  const bearVwapReject =
    (c1.high >= vwap || c0.high >= vwap - atr * 0.15) &&
    c0.close < vwap &&
    isBearCandle &&
    fastMacd.histogram <= fastMacd.prevHistogram;

  // ستاپ ۳: Fast MACD (8,21,5) Momentum Expansion (شتاب گرفتن مکدی سریع در جهت سوپرترند)
  const bullMacdImpulse =
    supertrend.direction === "LONG" &&
    c0.close > ema9 &&
    fastMacd.histogram > 0 &&
    fastMacd.histogram > fastMacd.prevHistogram &&
    rsi >= 50 && rsi <= 68;

  const bearMacdImpulse =
    supertrend.direction === "SHORT" &&
    c0.close < ema9 &&
    fastMacd.histogram < 0 &&
    fastMacd.histogram < fastMacd.prevHistogram &&
    rsi <= 50 && rsi >= 32;

  // ستاپ ۴: Liquidity Sweep / Volatility Breakout (شکار استاپ کف/سقف یا شکست با حجم)
  const prior8 = closedKlines.slice(-10, -2);
  const priorLow = Math.min(...prior8.map(k => k.low));
  const priorHigh = Math.max(...prior8.map(k => k.high));

  const bullSweepOrBreak =
    ((c0.low < priorLow && c0.close > priorLow) || (supertrend.justFlipped && supertrend.direction === "LONG")) &&
    isBullCandle;

  const bearSweepOrBreak =
    ((c0.high > priorHigh && c0.close < priorHigh) || (supertrend.justFlipped && supertrend.direction === "SHORT")) &&
    isBearCandle;

  // تجمیع ۴ ستاپ
  let hasActiveSetup = false;
  let setupType = "در حال رصد کندل ۵ دقیقه";
  let setupDirection = ema9 >= ema21 ? "LONG" : "SHORT";

  if (bullRibbonPullback) {
    hasActiveSetup = true;
    setupType = "🎯 پولبک به ریبون EMA 9/21 + تایید مومنتوم";
    setupDirection = "LONG";
  } else if (bearRibbonPullback) {
    hasActiveSetup = true;
    setupType = "🎯 پولبک به ریبون EMA 9/21 نزولی";
    setupDirection = "SHORT";
  } else if (bullVwapReclaim) {
    hasActiveSetup = true;
    setupType = "🏦 تثبیت و جهش از روی خط VWAP";
    setupDirection = "LONG";
  } else if (bearVwapReject) {
    hasActiveSetup = true;
    setupType = "🏦 ریجکت نزولی از زیر خط VWAP";
    setupDirection = "SHORT";
  } else if (bullSweepOrBreak) {
    hasActiveSetup = true;
    setupType = "🧲 شکار نقدینگی / شکست ساختار صعودی";
    setupDirection = "LONG";
  } else if (bearSweepOrBreak) {
    hasActiveSetup = true;
    setupType = "🧲 شکار نقدینگی / شکست ساختار نزولی";
    setupDirection = "SHORT";
  } else if (bullMacdImpulse) {
    hasActiveSetup = true;
    setupType = "⚡ شتاب مومنتوم Fast MACD (8,21,5)";
    setupDirection = "LONG";
  } else if (bearMacdImpulse) {
    hasActiveSetup = true;
    setupType = "⚡ شتاب مومنتوم نزولی Fast MACD (8,21,5)";
    setupDirection = "SHORT";
  }

  // فیلتر فقط بازارهای کاملاً مرده و بدون نوسان
  const isFlatChop = adx < 15 && bb.bandwidth < 0.0028;

  // فیلتر عدم ورود روی کندل‌های به شدت کشیده یا اشباع شدید (RSI > 72 یا RSI < 28)
  const distFromEma9Atr = Math.abs(liveCandle.close - ema9) / (atr || 1);
  const isOverextended =
    distFromEma9Atr > 1.70 ||
    (setupDirection === "LONG" && rsi > 71) ||
    (setupDirection === "SHORT" && rsi < 29);

  return {
    close: liveCandle.close,
    ema9, ema21, ema50, vwap,
    rsi, stochRsi, fastMacd,
    atr, adx, bb, supertrend,
    swingLow, swingHigh,
    volRatio, isFlatChop, distFromEma9Atr, isOverextended,
    hasActiveSetup, setupType, setupDirection
  };
}

/* =========================================================
   ۷. امتیازدهی انعطاف‌پذیر نسخه v7.0 (بدون قفل کردن بی‌مورد بات)
========================================================= */
function evaluateProScalpScore({ symbol, direction, tf5m, tf15m, breadth, futuresData }) {
  let score = 0;
  let reasons = [];

  // ۱. فعال بودن یکی از ۴ ستاپ استاندارد اسکلپ در تایم ۵ دقیقه (۲۵ امتیاز)
  if (tf5m.hasActiveSetup) {
    score += 25;
    reasons.push(`• ${tf5m.setupType}`);
  } else {
    score += 10;
  }

  // ۲. هماهنگی با روند تایم‌فریم ۱۵ دقیقه (۲۰ امتیاز - حتی اگر ۱۵ دقیقه در حال چرخش باشد، امتیاز نسبی می‌دهد و قفل نمی‌کند)
  const m15FullAlign =
    (direction === "LONG" && (tf15m.ema9 >= tf15m.ema21 || tf15m.supertrend.direction === "LONG")) ||
    (direction === "SHORT" && (tf15m.ema9 <= tf15m.ema21 || tf15m.supertrend.direction === "SHORT"));

  if (m15FullAlign) {
    score += 20;
    reasons.push("• هم‌جهتی با ساختار تایم‌فریم ۱۵ دقیقه ✅");
  } else {
    score += 11; // امتیاز نسبی برای ورودهای زودهنگام چرخش روند
  }

  // ۳. موقعیت قیمت نسبت به VWAP و ریبون EMA 9/21 (۱۵ امتیاز)
  const vwapOk = (direction === "LONG" && tf5m.close >= tf5m.vwap) || (direction === "SHORT" && tf5m.close <= tf5m.vwap);
  if (vwapOk) {
    score += 15;
    reasons.push("• قرارگیری در سمت درست Session VWAP 🏦");
  } else {
    score += 8;
  }

  // ۴. شتاب Fast MACD (8,21,5) و StochRSI (۱۵ امتیاز)
  const macdOk =
    (direction === "LONG" && tf5m.fastMacd.histogram >= tf5m.fastMacd.prevHistogram) ||
    (direction === "SHORT" && tf5m.fastMacd.histogram <= tf5m.fastMacd.prevHistogram);
  if (macdOk) {
    score += 15;
    reasons.push(`• تایید شتاب Fast MACD و StochRSI (${tf5m.stochRsi.toFixed(0)}%) ⚡`);
  } else {
    score += 8;
  }

  // ۵. جریان سفارشات فیوچرز OKX و حجم معاملات (۱۵ امتیاز)
  if (futuresData.flowBias === direction || tf5m.volRatio >= 1.15) {
    score += 15;
    reasons.push(`• حمایت سفارشات فیوچرز OKX (Taker Buy: ${futuresData.takerBuyRatio}%) 📊`);
  } else {
    score += 9;
  }

  // ۶. هم‌سویی با حرکت لحظه‌ای بیت‌کوین (۱۰ امتیاز)
  // فقط زمانی مانع سیگنال می‌شود که بیت‌کوین در ۳۰ دقیقه اخیر بیش از 0.6% خلاف جهت پوزیشن پامپ/دامپ کرده باشد
  const btcChange = parseFloat(breadth.btc30mChangePct) || 0;
  const extremeContraBtc =
    symbol !== "BTCUSDT" &&
    ((direction === "LONG" && btcChange < -0.65) || (direction === "SHORT" && btcChange > 0.65));

  if ((direction === "LONG" && breadth.btcTrend5m === "LONG") || (direction === "SHORT" && breadth.btcTrend5m === "SHORT")) {
    score += 10;
    reasons.push("• هم‌سو با موج لحظه‌ای بیت‌کوین 👑");
  } else if (!extremeContraBtc) {
    score += 6;
  }

  if (tf5m.isFlatChop) score -= 12;
  if (tf5m.isOverextended) score -= 15;

  let grade = "در انتظار ماشه ⏳";
  if (score >= 85) grade = "VIP Scalp A+ 💎";
  else if (score >= 78) grade = "Strong Scalp A 🔥";
  else if (score >= 72) grade = "Active Scalp B+ ⚡️";

  return {
    score: Math.max(0, Math.min(100, score)),
    grade,
    reasons,
    extremeContraBtc
  };
}

/* =========================================================
   ۸. محاسبه تارگت‌های سریع اسکلپ ۵ دقیقه + حد ضرر پشت سوئینگ
========================================================= */
function calculateScalpTargets(tf5m, direction) {
  const price = tf5m.close;
  const atr = tf5m.atr;
  const dec = price > 100 ? 2 : 3;
  const isLong = direction === "LONG";
  const m = isLong ? 1 : -1;

  // قرارگیری استاپ پشت کف/سقف سوئینگ ۱۲ کندل اخیر ۵ دقیقه + بافر 0.35x ATR
  const structuralSL = isLong
    ? tf5m.swingLow - (atr * 0.35)
    : tf5m.swingHigh + (atr * 0.35);

  let riskDist = Math.abs(price - structuralSL);
  const minRisk = atr * 1.30;
  const maxRisk = atr * 2.20;
  if (riskDist < minRisk) riskDist = minRisk;
  if (riskDist > maxRisk) riskDist = maxRisk;

  const slPrice = price - m * riskDist;

  // تارگت‌های سریع و واقع‌بینانه برای تایم‌فریم ۵ دقیقه:
  const tp1Price = price + m * (riskDist * 0.80); // 0.8R -> سیو سود سریع و ریسک‌فری
  const tp2Price = price + m * (riskDist * 1.60); // 1.6R -> تارگت اصلی اسکلپ
  const tp3Price = price + m * (riskDist * 2.50); // 2.5R -> تارگت موج ۱۵ دقیقه

  const zoneLow = (price - m * (atr * 0.20)).toFixed(dec);
  const zoneHigh = price.toFixed(dec);

  const slPct = ((riskDist / price) * 100).toFixed(2);
  const tp1Pct = ((Math.abs(tp1Price - price) / price) * 100).toFixed(2);
  const tp2Pct = ((Math.abs(tp2Price - price) / price) * 100).toFixed(2);
  const tp3Pct = ((Math.abs(tp3Price - price) / price) * 100).toFixed(2);

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
   ۹. قالب منظم پیام سیگنال و منوها (نسخه v7.0)
========================================================= */
function buildScoreBar(score) {
  const filled = Math.min(10, Math.max(0, Math.round(score / 10)));
  return "🟩".repeat(filled) + "⬜".repeat(10 - filled);
}

async function sendProSignalMessage(env, data, customChatId = null) {
  const { signalId, symbol, direction, entry, targets, scoreData, tf5m, breadth, futuresData, isForced } = data;
  const isLong = direction === "LONG";
  const sigTag = `#SIG-${signalId}`;
  const dirTitle = isLong ? "🟢 <b>LONG (اسکلپ خرید)</b>" : "🔴 <b>SHORT (اسکلپ فروش)</b>";
  const modeTag = isForced ? "⚡️ <i>سیگنال درخواستی (/force)</i>\n" : "";

  const text = `
${modeTag}${dirTitle} | <b>#${symbol}</b> • <code>5m / 15m</code>
🔖 <b>کد سیگنال:</b> <code>${sigTag}</code>
⭐️ <b>اعتبار سیگنال:</b> <b>${scoreData.score}/100</b> <i>(${scoreData.grade})</i>
<code>${buildScoreBar(scoreData.score)}</code>

🎯 <b>ستاپ ورود و مدیریت ریسک</b>
├ <b>ستاپ اسکلپ:</b> ${tf5m.setupType}
├ <b>قیمت ورود:</b> <code>${entry}</code> <i>(محدوده: ${targets.entryZone})</i>
└ <b>اهرم و حجم:</b> <code>Isolated ${targets.leverage}x</code> <i>(${targets.marginPct}% Wallet)</i>

💰 <b>تارگت‌ها و حد ضرر ساختاری</b> <i>(با لمس کپی می‌شود)</i>
├ ⚡️ <b>TP 1:</b> <code>${targets.tp1}</code> <i>(+${targets.tp1Pct}% | ریسک‌فری)</i>
├ 🔥 <b>TP 2:</b> <code>${targets.tp2}</code> <i>(+${targets.tp2Pct}%)</i>
├ 🚀 <b>TP 3:</b> <code>${targets.tp3}</code> <i>(+${targets.tp3Pct}%)</i>
└ 🛡️ <b>SL:</b> <code>${targets.sl}</code> <i>(-${targets.slPct}%)</i>

<blockquote>📊 <b>داده‌های لحظه‌ای اسکلپ (v7.0):</b>
• <b>StochRSI:</b> ${tf5m.stochRsi.toFixed(0)}% | <b>RSI:</b> ${tf5m.rsi.toFixed(0)} | <b>Taker Buy:</b> ${futuresData.takerBuyRatio}%
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
  const lastId = env.SIGNAL_KV ? (await env.SIGNAL_KV.get("LAST_SIGNAL_ID") || "1000") : "1000";

  const text = `
🤖 <b>پنل اسکلپر حرفه‌ای کریپتو</b> • <code>v7.0 Active Pro</code>

<blockquote>⚡ <b>معماری ۴ موتوره نسخه 7.0 (5m / 15m):</b>
├ <b>۱. ریبون اسکلپ:</b> EMA 9/21 Pullback + StochRSI ✅
├ <b>۲. مرجع مؤسسات:</b> Session VWAP Reclaim/Bounce ✅
├ <b>۳. مومنتوم سریع:</b> Fast MACD (8, 21, 5) Flip ✅
├ <b>۴. نقدینگی:</b> Liquidity Sweep + Taker Orderflow ✅
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
    const breadth = await analyzeLiveMarketBreadth();
    let blocks = [];

    for (const symbol of SYMBOLS) {
      const coin = symbol.replace("USDT", "");
      const [klines5m, klines15m, futuresData] = await Promise.all([
        fetchKlines(symbol, "5m", 120),
        fetchKlines(symbol, "15m", 100),
        fetchOKXFuturesData(coin)
      ]);

      if (klines5m.length < 60 || klines15m.length < 60) {
        blocks.push(`🔸 <b>#${symbol}</b>: ⚠️ خطا در دریافت کندل`);
        continue;
      }

      const tf5m = analyzeProScalper(klines5m);
      const tf15m = analyzeProScalper(klines15m);
      const direction = tf5m.setupDirection;
      const scoreData = evaluateProScalpScore({
        symbol, direction, tf5m, tf15m, breadth, futuresData
      });

      const dirIcon = direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
      let stateText = tf5m.hasActiveSetup ? `🔥 <b>${tf5m.setupType}</b>` : "⏳ منتظر تشکیل ستاپ در کندل ۵ دقیقه";
      if (tf5m.isFlatChop) stateText = "⚠️ بازار بدون نوسان (Flat)";
      else if (tf5m.isOverextended) stateText = "🚫 کندل کشیده (صبر برای اصلاح به EMA9)";

      blocks.push(
        `🪙 <b>#${symbol}</b> • <code>${tf5m.close}</code>\n` +
        `├ <b>جهت و امتیاز:</b> ${dirIcon} | <b>${scoreData.score}/100</b> <i>(${scoreData.grade})</i>\n` +
        `├ <b>اندیکاتورها:</b> RSI: <code>${tf5m.rsi.toFixed(0)}</code> | Stoch: <code>${tf5m.stochRsi.toFixed(0)}%</code> | Taker: <code>${futuresData.takerBuyRatio}%</code>\n` +
        `└ <b>وضعیت:</b> ${stateText}`
      );
    }

    const msg = `
🔎 <b>اسکن زنده اسکلپ (v7.0 • 5m/15m)</b>
<blockquote>🌐 <b>روند BTC:</b> 5m: <b>${breadth.btcTrend5m}</b> | 15m: <b>${breadth.btcTrend15m}</b>
💧 <b>جریان ۳۰ دقیقه اخیر:</b> ${breadth.usdtFlow} (${breadth.btc30mChangePct}%)</blockquote>

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
📂 <b>پوزیشن‌های فعال اسکلپ (v7.0)</b>
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
  const coin = symbol.replace("USDT", "");
  const [klines5m, klines15m, breadth, futuresData] = await Promise.all([
    fetchKlines(symbol, "5m", 120),
    fetchKlines(symbol, "15m", 100),
    analyzeLiveMarketBreadth(),
    fetchOKXFuturesData(coin)
  ]);

  if (klines5m.length < 60 || klines15m.length < 60) {
    await sendTelegramRaw(env, chatId, `❌ خطا در دریافت دیتای کندل برای #${symbol}`);
    return;
  }

  const tf5m = analyzeProScalper(klines5m);
  const tf15m = analyzeProScalper(klines15m);
  const direction = tf5m.setupDirection;
  const scoreData = evaluateProScalpScore({
    symbol, direction, tf5m, tf15m, breadth, futuresData
  });
  const targets = calculateScalpTargets(tf5m, direction);
  const dec = tf5m.close > 100 ? 2 : 3;

  const text = `
🔬 <b>کالبدشکافی اسکلپ (v7.0 • 5m/15m)</b> | <b>#${symbol}</b>
💰 <b>قیمت لحظه‌ای:</b> <code>${tf5m.close}</code>
⭐️ <b>امتیاز فعلی:</b> <b>${scoreData.score}/100</b> <i>(حد نصاب: ${FIXED_MIN_SCORE})</i>
<code>${buildScoreBar(scoreData.score)}</code>

⚡ <b>وضعیت ۴ موتور اسکلپ</b>
├ <b>ستاپ فعال:</b> ${tf5m.setupType}
├ <b>ریبون EMA 9/21:</b> <code>${tf5m.ema9.toFixed(dec)}</code> / <code>${tf5m.ema21.toFixed(dec)}</code>
├ <b>موقعیت VWAP:</b> <code>${tf5m.vwap.toFixed(dec)}</code> (${tf5m.close >= tf5m.vwap ? "🟢 بالای VWAP" : "🔴 زیر VWAP"})
├ <b>مومنتوم:</b> RSI: <code>${tf5m.rsi.toFixed(1)}</code> | StochRSI: <code>${tf5m.stochRsi.toFixed(0)}%</code>
└ <b>سفارشات Taker فیوچرز:</b> <code>${futuresData.takerBuyRatio}%</code> (${futuresData.flowBias})

<blockquote>🎯 <b>سطوح اسکلپ در صورت ورود (${direction}):</b>
⚡️ <b>TP1:</b> <code>${targets.tp1}</code> | 🔥 <b>TP2:</b> <code>${targets.tp2}</code> | 🛡️ <b>SL:</b> <code>${targets.sl}</code></blockquote>
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
  let stats = { wins: 0, losses: 0, netPct: 0 };
  if (env.SIGNAL_KV) {
    const raw = await env.SIGNAL_KV.get("BOT_STATS");
    if (raw) { try { stats = JSON.parse(raw); } catch {} }
  }
  const total = stats.wins + stats.losses;
  const winRate = total > 0 ? ((stats.wins / total) * 100).toFixed(1) : "0.0";

  const text = `
📈 <b>کارنامه و آمار عملکرد بات (v7.0)</b>
<blockquote>├ ✅ <b>تارگت‌های موفق (Wins):</b> ${stats.wins}
├ 🛑 <b>استاپ‌ها (Losses):</b> ${stats.losses}
├ 🏆 <b>نرخ برد (Win-Rate):</b> <b>${winRate}%</b>
└ 💰 <b>برآیند خالص (بدون اهرم):</b> <b>${stats.netPct >= 0 ? "+" : ""}${stats.netPct.toFixed(2)}%</b></blockquote>
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
    for (const sym of SYMBOLS) {
      await env.SIGNAL_KV.delete(`POS_${sym}`);
      await env.SIGNAL_KV.delete(`COOLDOWN_${sym}`);
    }
  }
  await sendTelegramRaw(env, chatId, "🗑️ <b>پاکسازی پوزیشن‌ها انجام شد</b>\n└ تمام پوزیشن‌های فعال و قفل‌های زمانی بسته شدند.");
}

async function handleResetCommand(env, chatId) {
  if (env.SIGNAL_KV) {
    await Promise.all([
      env.SIGNAL_KV.put("BOT_STATS", JSON.stringify({ wins: 0, losses: 0, netPct: 0 })),
      env.SIGNAL_KV.put("SIGNAL_HISTORY", JSON.stringify([])),
      env.SIGNAL_KV.put("LAST_SIGNAL_ID", "1000"),
      ...SYMBOLS.map(sym => env.SIGNAL_KV.delete(`POS_${sym}`)),
      ...SYMBOLS.map(sym => env.SIGNAL_KV.delete(`COOLDOWN_${sym}`))
    ]);
  }

  const msg = `
🔄 <b>ریست کامل کارنامه و حافظه بات انجام شد!</b>
<blockquote>├ 📊 <b>آمار برد و باخت (/stats):</b> صفر شد (0 Win / 0 Loss)
├ 📜 <b>تاریخچه معاملات (/history):</b> پاکسازی شد
├ 📂 <b>پوزیشن‌های باز و قفل‌ها:</b> پاکسازی شد
└ 🔢 <b>شمارنده سیگنال‌ها:</b> بازنشانی به <code>#SIG-1000</code></blockquote>
✅ <i>از این لحظه فقط عملکرد نسخه سریع <b>v7.0 (5m/15m)</b> ثبت خواهد شد.</i>
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
    if (takerBuyRatio >= 51.5) flowBias = "LONG";
    else if (takerBuyRatio <= 48.5) flowBias = "SHORT";
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

// محاسبه مکدی سریع مخصوص اسکلپ کریپتو: Fast MACD (8, 21, 5)
function calcFastMACD(closes, fast = 8, slow = 21, sig = 5) {
  const eFast = calcEMASeries(closes, fast);
  const eSlow = calcEMASeries(closes, slow);
  const macdLine = eFast.map((v, i) => v - eSlow[i]);
  const sigLine = calcEMASeries(macdLine, sig);
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
  let sum = 0;
  for (let i = klines.length - period; i < klines.length; i++) sum += Math.max(klines[i].high - klines[i].low, Math.abs(klines[i].high - klines[i - 1].close), Math.abs(klines[i].low - klines[i - 1].close));
  return sum / period;
}

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