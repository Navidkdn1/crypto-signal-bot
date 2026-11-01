/**
 * 🚀 Crypto Signal Bot v6.1 (Pure Institutional Price Action & Orderflow + Reset Command)
 * ---------------------------------------------------------------------------------------
 * 🔄 دستور جدید /reset (و دکمه شیشه‌ای) برای صفر کردن کامل آمار، تاریخچه و شمارنده سیگنال‌ها
 * ❌ حذف کامل دیتای تاخیردار ۲۴ ساعته دامیننس و جایگزینی با جریان پول زنده کندلی (Live Breadth)
 * ❌ حذف کامل منوی تنظیمات (/settings) و قفل شدن روی یک استاندارد ثابت و دقیق (Score >= 80)
 * 🎯 ماشه ورود: پولبک به EMA20/VWAP/OB در تایم ۱۵ دقیقه + شکست قطعی سقف/کف کندل قبلی
 * 📐 فرمول دقیق ریاضی Wilder's ADX + فیلتر شیب میانگین (EMA Slope) برای حذف بازار رنج
 * ⏱ زمان تنفس ۴ ساعته متناسب با موج‌های تایم ۱۵ دقیقه و ۱ ساعت
 */

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"];
const MAX_OPEN_POSITIONS = 2;
const FIXED_MIN_SCORE = 80;
const MAX_TRADE_DURATION_MIN = 240; // ۴ ساعت
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
        version: "6.1 Pure Institutional Edition + Reset",
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

    return new Response("🤖 Crypto Signal Bot v6.1 is Active!", { status: 200 });
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
   ۳. رصد لحظه‌ای TP1 / TP2 / TP3 / SL با مهلت ۴ ساعته
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
      await env.SIGNAL_KV.put(`POS_${symbol}`, JSON.stringify(pos), { expirationTtl: 14400 });
      activeCount++;
      continue;
    }

    // ۴. بررسی برخورد با تارگت اول (TP1)
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
      await env.SIGNAL_KV.put(`POS_${symbol}`, JSON.stringify(pos), { expirationTtl: 14400 });
      activeCount++;
      continue;
    }

    // ۵. خروج زمانی پس از ۴ ساعت (۲۴۰ دقیقه)
    if (durationMin >= MAX_TRADE_DURATION_MIN) {
      const livePnl = (((isLong ? currentPrice - pos.entry : pos.entry - currentPrice) / pos.entry) * 100).toFixed(2);
      const msg = `
⏳ <b>اتمام مهلت زمانی پوزیشن (Time-Stop)</b>
<blockquote>🔖 <b>سیگنال:</b> <code>${sigTag}</code> | <b>#${symbol}</b> (${pos.direction})
├ <b>ورود:</b> <code>${pos.entry}</code> | <b>فعلی:</b> <code>${currentPrice.toFixed(dec)}</code>
├ <b>برآیند لحظه‌ای:</b> <b>${livePnl >= 0 ? "+" : ""}${livePnl}%</b>
└ <b>علت:</b> گذشت ۴ ساعت و خروج از فاز کوتاه‌مدت</blockquote>
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
   ۴. تحلیل زنده جریان کل بازار (Live Market Breadth)
========================================================= */
async function analyzeLiveMarketBreadth() {
  try {
    const [btc15m, btc1h, eth15m] = await Promise.all([
      fetchKlines("BTCUSDT", "15m", 60),
      fetchKlines("BTCUSDT", "1h", 60),
      fetchKlines("ETHUSDT", "15m", 60)
    ]);

    if (btc15m.length < 50 || btc1h.length < 50) {
      return { regime: "NEUTRAL", btcTrend15m: "NEUTRAL", btcTrend1h: "NEUTRAL", usdtFlow: "خنثی", rsEthBtc: 0 };
    }

    const btcCloses15 = btc15m.slice(0, -1).map(k => k.close);
    const btcCloses1h = btc1h.slice(0, -1).map(k => k.close);
    const ethCloses15 = eth15m.slice(0, -1).map(k => k.close);

    const btcEma20_15 = calcEMA(btcCloses15, 20);
    const btcEma50_15 = calcEMA(btcCloses15, 50);
    const btcEma20_1h = calcEMA(btcCloses1h, 20);
    const btcEma50_1h = calcEMA(btcCloses1h, 50);

    const lastBtc = btcCloses15[btcCloses15.length - 1];
    const prev4Btc = btcCloses15[btcCloses15.length - 5];
    const btc1hChangePct = ((lastBtc - prev4Btc) / prev4Btc) * 100;

    const lastEth = ethCloses15[ethCloses15.length - 1];
    const prev4Eth = ethCloses15[ethCloses15.length - 5];
    const eth1hChangePct = ((lastEth - prev4Eth) / prev4Eth) * 100;

    const btcTrend15m = lastBtc > btcEma20_15 && btcEma20_15 >= btcEma50_15 ? "LONG" : lastBtc < btcEma20_15 && btcEma20_15 <= btcEma50_15 ? "SHORT" : "NEUTRAL";
    const btcTrend1h = lastBtc > btcEma20_1h && btcEma20_1h >= btcEma50_1h ? "LONG" : lastBtc < btcEma20_1h && btcEma20_1h <= btcEma50_1h ? "SHORT" : "NEUTRAL";

    let regime = "NEUTRAL";
    let usdtFlow = "متعادل ⚪";
    if (btcTrend15m === "LONG" && btc1hChangePct > 0.15) {
      regime = "RISK_ON_BULL";
      usdtFlow = "ورود پول (کاهش USDT.D) 🟢";
    } else if (btcTrend15m === "SHORT" && btc1hChangePct < -0.15) {
      regime = "RISK_OFF_BEAR";
      usdtFlow = "خروج پول (افزایش USDT.D) 🔴";
    }

    return {
      regime,
      btcTrend15m,
      btcTrend1h,
      btc1hChangePct: btc1hChangePct.toFixed(2),
      eth1hChangePct: eth1hChangePct.toFixed(2),
      usdtFlow
    };
  } catch {
    return { regime: "NEUTRAL", btcTrend15m: "NEUTRAL", btcTrend1h: "NEUTRAL", btc1hChangePct: "0.00", usdtFlow: "متعادل ⚪" };
  }
}

/* =========================================================
   ۵. موتور اسکن اصلی نسخه v6.1
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
      const [klines15m, klines1h, futuresData] = await Promise.all([
        fetchKlines(symbol, "15m", 120),
        fetchKlines(symbol, "1h", 100),
        fetchOKXFuturesData(coin)
      ]);
      if (klines15m.length < 70 || klines1h.length < 60) continue;

      const tf15m = analyzePurePriceAction(klines15m);
      const tf1h = analyzePurePriceAction(klines1h);
      const direction = tf15m.setupDirection;

      const scoreData = evaluateInstitutionalSetup({
        symbol, direction, tf15m, tf1h, breadth, futuresData
      });

      const candidate = {
        symbol, direction, entry: tf15m.close, tf15m, tf1h, breadth, futuresData, scoreData
      };

      if (!bestCandidate || scoreData.score > bestCandidate.scoreData.score) {
        bestCandidate = candidate;
      }

      if (
        !forceBest &&
        !tf15m.isRanging &&
        !tf15m.isOverextended &&
        scoreData.hardFiltersPassed &&
        tf15m.hasConfirmedTrigger &&
        scoreData.score >= FIXED_MIN_SCORE
      ) {
        const signalId = await getNextSignalId(env);
        const targets = calculateSwingTargets(tf15m, direction);
        const sentMsgId = await sendProSignalMessage(env, { ...candidate, targets, signalId }, customChatId);

        if (env.SIGNAL_KV) {
          const posState = {
            signalId,
            messageId: sentMsgId,
            symbol,
            direction,
            entry: tf15m.close,
            tp1: parseFloat(targets.tp1),
            tp2: parseFloat(targets.tp2),
            tp3: parseFloat(targets.tp3),
            sl: parseFloat(targets.sl),
            leverage: targets.leverage,
            tp1Hit: false,
            tp2Hit: false,
            openedAt: Date.now()
          };
          await env.SIGNAL_KV.put(`POS_${symbol}`, JSON.stringify(posState), { expirationTtl: 14400 });
          await env.SIGNAL_KV.put(`COOLDOWN_${symbol}`, "1", { expirationTtl: 2700 });
        }
        activePositions++;
      }
    }

    if (forceBest && bestCandidate) {
      const signalId = await getNextSignalId(env);
      const targets = calculateSwingTargets(bestCandidate.tf15m, bestCandidate.direction);
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
          await env.SIGNAL_KV.put(`POS_${bestCandidate.symbol}`, JSON.stringify(posState), { expirationTtl: 14400 });
        }
      }
    }
  } catch (error) {
    console.error("Bot Engine Error:", error);
  }
}

/* =========================================================
   ۶. موتور پرایس اکشن خالص (EMA Slope + Candle Break + Wilder's ADX)
========================================================= */
function analyzePurePriceAction(klines) {
  const closedKlines = klines.slice(0, -1);
  const closes = closedKlines.map(k => k.close);
  const liveCandle = klines[klines.length - 1];
  const c0 = closedKlines[closedKlines.length - 1];
  const c1 = closedKlines[closedKlines.length - 2];
  const c2 = closedKlines[closedKlines.length - 3];

  const ema9Series = calcEMASeries(closes, 9);
  const ema20Series = calcEMASeries(closes, 20);
  const ema50Series = calcEMASeries(closes, 50);

  const ema9 = ema9Series[ema9Series.length - 1];
  const ema20 = ema20Series[ema20Series.length - 1];
  const ema50 = ema50Series[ema50Series.length - 1];

  const ema20Prev4 = ema20Series[ema20Series.length - 5] || ema20;
  const ema20SlopePct = ((ema20 - ema20Prev4) / ema20Prev4) * 100;

  const rsiSeries = calcRSISeries(closes, 14);
  const rsi = rsiSeries[rsiSeries.length - 1];
  const prevRsi = rsiSeries[rsiSeries.length - 2];

  const atr = calcATR(closedKlines, 14);
  const adx = calcWilderADX(closedKlines, 14);
  const vwapData = calcVWAPBands(closedKlines.slice(-48));
  const macd = calcMACD(closes);
  const supertrend = calcSupertrend(closedKlines, 10, 2.5);
  const orderBlock = detectOrderBlocks(closedKlines, atr, 45);

  const closePrev4 = closes[closes.length - 5] || c0.close;
  const change1hPct = ((c0.close - closePrev4) / closePrev4) * 100;

  const recent16 = closedKlines.slice(-16);
  const swingLow = Math.min(...recent16.map(k => k.low));
  const swingHigh = Math.max(...recent16.map(k => k.high));

  const bullTrendStructure = c0.close > ema20 && ema20 >= ema50 && ema20SlopePct > 0.04;
  const bearTrendStructure = c0.close < ema20 && ema20 <= ema50 && ema20SlopePct < -0.04;

  const candleRange = (c0.high - c0.low) || 1;
  const candleBody = Math.abs(c0.close - c0.open);
  const bodyRatio = candleBody / candleRange;
  const strongBullCandle = c0.close > c0.open && bodyRatio >= 0.45 && c0.close > c1.high;
  const strongBearCandle = c0.close < c0.open && bodyRatio >= 0.45 && c0.close < c1.low;

  const pulledBackToBullZone =
    c1.low <= ema20 + atr * 0.35 ||
    c2.low <= ema20 + atr * 0.35 ||
    c1.low <= vwapData.vwap + atr * 0.30 ||
    orderBlock.inBullishOB;

  const bullPullbackTrigger =
    bullTrendStructure &&
    pulledBackToBullZone &&
    strongBullCandle &&
    macd.histogram >= macd.prevHistogram;

  const pulledBackToBearZone =
    c1.high >= ema20 - atr * 0.35 ||
    c2.high >= ema20 - atr * 0.35 ||
    c1.high >= vwapData.vwap - atr * 0.30 ||
    orderBlock.inBearishOB;

  const bearPullbackTrigger =
    bearTrendStructure &&
    pulledBackToBearZone &&
    strongBearCandle &&
    macd.histogram <= macd.prevHistogram;

  const prior12 = closedKlines.slice(-14, -2);
  const priorLow = Math.min(...prior12.map(k => k.low));
  const priorHigh = Math.max(...prior12.map(k => k.high));

  const bullSweepTrigger =
    (c1.low < priorLow || c0.low < priorLow) &&
    c0.close > priorLow &&
    strongBullCandle &&
    rsi > prevRsi;

  const bearSweepTrigger =
    (c1.high > priorHigh || c0.high > priorHigh) &&
    c0.close < priorHigh &&
    strongBearCandle &&
    rsi < prevRsi;

  const avgVol = closedKlines.slice(-21, -1).reduce((s, k) => s + k.volume, 0) / 20;
  const volRatio = c0.volume / (avgVol || 1);

  const isRanging = adx < 20 || Math.abs(ema20SlopePct) < 0.03;

  const distFromEma20Atr = Math.abs(liveCandle.close - ema20) / (atr || 1);
  const isOverextended = distFromEma20Atr > 1.65 || candleBody > atr * 1.85;

  let hasConfirmedTrigger = false;
  let setupType = "منتظر پولبک و شکست سقف/کف کندل";
  let setupDirection = bullTrendStructure ? "LONG" : bearTrendStructure ? "SHORT" : supertrend.direction;

  if (bullPullbackTrigger) {
    hasConfirmedTrigger = true;
    setupType = "🎯 پولبک به EMA20/VWAP + شکست سقف کندل";
    setupDirection = "LONG";
  } else if (bearPullbackTrigger) {
    hasConfirmedTrigger = true;
    setupType = "🎯 پولبک به EMA20/VWAP + شکست کف کندل";
    setupDirection = "SHORT";
  } else if (bullSweepTrigger) {
    hasConfirmedTrigger = true;
    setupType = "🧲 جمع‌آوری نقدینگی کف (Sweep) + کندل پوشا";
    setupDirection = "LONG";
  } else if (bearSweepTrigger) {
    hasConfirmedTrigger = true;
    setupType = "🧲 جمع‌آوری نقدینگی سقف (Sweep) + کندل پوشا";
    setupDirection = "SHORT";
  }

  return {
    close: liveCandle.close,
    ema9, ema20, ema50, ema20SlopePct,
    vwap: vwapData.vwap, vwapBands: vwapData,
    rsi, prevRsi, macd, atr, adx, supertrend, orderBlock,
    swingLow, swingHigh, change1hPct,
    volRatio, isRanging, distFromEma20Atr, isOverextended,
    bullTrendStructure, bearTrendStructure,
    hasConfirmedTrigger, setupType, setupDirection
  };
}

/* =========================================================
   ۷. امتیازدهی واحد و سخت‌گیرانه (نسخه v6.1)
========================================================= */
function evaluateInstitutionalSetup({ symbol, direction, tf15m, tf1h, breadth, futuresData }) {
  let score = 0;
  let reasons = [];

  const rsiHealthy =
    (direction === "LONG" && tf15m.rsi >= 48 && tf15m.rsi <= 65 && tf15m.rsi >= tf15m.prevRsi) ||
    (direction === "SHORT" && tf15m.rsi <= 52 && tf15m.rsi >= 35 && tf15m.rsi <= tf15m.prevRsi);

  const h1Aligned =
    (direction === "LONG" && tf1h.close >= tf1h.ema20 && tf1h.supertrend.direction === "LONG") ||
    (direction === "SHORT" && tf1h.close <= tf1h.ema20 && tf1h.supertrend.direction === "SHORT");

  const btcAligned =
    symbol === "BTCUSDT" ||
    (direction === "LONG" && breadth.btcTrend15m !== "SHORT") ||
    (direction === "SHORT" && breadth.btcTrend15m !== "LONG");

  const hardFiltersPassed = rsiHealthy && h1Aligned && btcAligned;

  if (h1Aligned && ((direction === "LONG" && tf15m.bullTrendStructure) || (direction === "SHORT" && tf15m.bearTrendStructure))) {
    score += 25;
    reasons.push("• هم‌جهتی کامل روند در تایم 15m و 1H ✅");
  } else if (h1Aligned) {
    score += 15;
  } else {
    score += 4;
  }

  if (tf15m.hasConfirmedTrigger) {
    score += 25;
    reasons.push(`• ${tf15m.setupType}`);
  } else {
    score += 8;
  }

  const vwapOk = (direction === "LONG" && tf15m.close > tf15m.vwap) || (direction === "SHORT" && tf15m.close < tf15m.vwap);
  if (vwapOk && !tf15m.isOverextended) {
    score += 15;
    reasons.push(`• تثبیت در سمت درست VWAP (فاصله از EMA20: ${tf15m.distFromEma20Atr.toFixed(1)}x ATR) 🎯`);
  } else {
    score += 5;
  }

  const strongerThanBtc =
    symbol === "BTCUSDT" ||
    (direction === "LONG" && tf15m.change1hPct >= parseFloat(breadth.btc1hChangePct)) ||
    (direction === "SHORT" && tf15m.change1hPct <= parseFloat(breadth.btc1hChangePct));

  if (btcAligned && strongerThanBtc) {
    score += 15;
    reasons.push(`• قدرت نسبی برتر نسبت به بیت‌کوین (${breadth.usdtFlow}) 👑`);
  } else if (btcAligned) {
    score += 10;
  } else {
    score += 2;
  }

  if (futuresData.flowBias === direction && tf15m.volRatio >= 1.05) {
    score += 20;
    reasons.push(`• ورود سفارشات Market در فیوچرز (Taker Buy: ${futuresData.takerBuyRatio}%) 📊`);
  } else if (futuresData.flowBias === direction || tf15m.volRatio >= 1.15) {
    score += 14;
    reasons.push(`• تایید حجم معاملات (${tf15m.volRatio.toFixed(1)}x میانگین) 📊`);
  } else {
    score += 7;
  }

  let grade = "در انتظار تایید ⏳";
  if (score >= 88) grade = "Institutional VIP A+ 💎";
  else if (score >= 80) grade = "Confirmed Grade A 🔥";

  return {
    score: Math.min(100, score),
    grade,
    reasons,
    hardFiltersPassed,
    rsiHealthy,
    h1Aligned,
    btcAligned
  };
}

/* =========================================================
   ۸. محاسبه تارگت‌ها و حد ضرر ساختاری (مناسب موج ۱۵ دقیقه)
========================================================= */
function calculateSwingTargets(tf15m, direction) {
  const price = tf15m.close;
  const atr = tf15m.atr;
  const dec = price > 100 ? 2 : 3;
  const isLong = direction === "LONG";
  const m = isLong ? 1 : -1;

  let structuralSL;
  if (isLong) {
    const obBottom = tf15m.orderBlock.bullOB ? tf15m.orderBlock.bullOB.bottom : tf15m.swingLow;
    structuralSL = Math.min(tf15m.swingLow, obBottom) - (atr * 0.40);
  } else {
    const obTop = tf15m.orderBlock.bearOB ? tf15m.orderBlock.bearOB.top : tf15m.swingHigh;
    structuralSL = Math.max(tf15m.swingHigh, obTop) + (atr * 0.40);
  }

  let riskDist = Math.abs(price - structuralSL);
  const minRisk = atr * 1.50;
  const maxRisk = atr * 2.60;
  if (riskDist < minRisk) riskDist = minRisk;
  if (riskDist > maxRisk) riskDist = maxRisk;

  const slPrice = price - m * riskDist;

  const tp1Price = price + m * (riskDist * 0.85);
  const tp2Price = price + m * (riskDist * 1.70);
  const tp3Price = price + m * (riskDist * 2.80);

  const zoneLow = (price - m * (atr * 0.25)).toFixed(dec);
  const zoneHigh = price.toFixed(dec);

  const slPct = ((riskDist / price) * 100).toFixed(2);
  const tp1Pct = ((Math.abs(tp1Price - price) / price) * 100).toFixed(2);
  const tp2Pct = ((Math.abs(tp2Price - price) / price) * 100).toFixed(2);
  const tp3Pct = ((Math.abs(tp3Price - price) / price) * 100).toFixed(2);

  const rawLev = Math.round(5 / Math.max(0.4, parseFloat(slPct)));
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
   ۹. قالب پیام سیگنال، منوها و دستور جدید /reset
========================================================= */
function buildScoreBar(score) {
  const filled = Math.min(10, Math.max(0, Math.round(score / 10)));
  return "🟩".repeat(filled) + "⬜".repeat(10 - filled);
}

async function sendProSignalMessage(env, data, customChatId = null) {
  const { signalId, symbol, direction, entry, targets, scoreData, tf15m, breadth, futuresData, isForced } = data;
  const isLong = direction === "LONG";
  const sigTag = `#SIG-${signalId}`;
  const dirTitle = isLong ? "🟢 <b>LONG (خرید تاییدشده)</b>" : "🔴 <b>SHORT (فروش تاییدشده)</b>";
  const modeTag = isForced ? "⚡️ <i>سیگنال درخواستی (/force)</i>\n" : "";

  const text = `
${modeTag}${dirTitle} | <b>#${symbol}</b> • <code>15m / 1H</code>
🔖 <b>کد سیگنال:</b> <code>${sigTag}</code>
⭐️ <b>اعتبار سیگنال:</b> <b>${scoreData.score}/100</b> <i>(${scoreData.grade})</i>
<code>${buildScoreBar(scoreData.score)}</code>

🎯 <b>ستاپ ورود و مدیریت ریسک</b>
├ <b>ماشه ورود:</b> ${tf15m.setupType}
├ <b>قیمت ورود:</b> <code>${entry}</code> <i>(محدوده: ${targets.entryZone})</i>
└ <b>اهرم و حجم:</b> <code>Isolated ${targets.leverage}x</code> <i>(${targets.marginPct}% Wallet)</i>

💰 <b>تارگت‌ها و حد ضرر ساختاری</b> <i>(با لمس کپی می‌شود)</i>
├ ⚡️ <b>TP 1:</b> <code>${targets.tp1}</code> <i>(+${targets.tp1Pct}% | ریسک‌فری)</i>
├ 🔥 <b>TP 2:</b> <code>${targets.tp2}</code> <i>(+${targets.tp2Pct}%)</i>
├ 🚀 <b>TP 3:</b> <code>${targets.tp3}</code> <i>(+${targets.tp3Pct}%)</i>
└ 🛡️ <b>SL:</b> <code>${targets.sl}</code> <i>(-${targets.slPct}%)</i>

<blockquote>📊 <b>ساختار لحظه‌ای بازار (v6.1):</b>
• <b>جریان نقدینگی:</b> ${breadth.usdtFlow}
• <b>ADX:</b> ${tf15m.adx.toFixed(0)} | <b>RSI:</b> ${tf15m.rsi.toFixed(0)} | <b>Taker Buy:</b> ${futuresData.takerBuyRatio}%
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
🤖 <b>پنل هوشمند پرایس‌اکشن و اردرفلو</b> • <code>v6.1</code>

<blockquote>🛡️ <b>مشخصات موتور تحلیلی نسخه 6.1:</b>
├ <b>تایم‌فریم استراتژی:</b> ۱۵ دقیقه + تایید روند ۱ ساعته ✅
├ <b>ماشه ورود:</b> پولبک به EMA20/VWAP + شکست کندل ✅
├ <b>جریان نقدینگی:</b> محاسبه زنده کندلی (حذف دیتای ۲۴ ساعته) ✅
├ <b>استاندارد امتیاز:</b> <b>${FIXED_MIN_SCORE}/100</b> (ثابت و بدون خطا)
└ <b>آخرین کد سیگنال:</b> <code>#SIG-${lastId}</code></blockquote>

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
      const [klines15m, klines1h, futuresData] = await Promise.all([
        fetchKlines(symbol, "15m", 120),
        fetchKlines(symbol, "1h", 100),
        fetchOKXFuturesData(coin)
      ]);

      if (klines15m.length < 70 || klines1h.length < 60) {
        blocks.push(`🔸 <b>#${symbol}</b>: ⚠️ خطا در دریافت کندل`);
        continue;
      }

      const tf15m = analyzePurePriceAction(klines15m);
      const tf1h = analyzePurePriceAction(klines1h);
      const direction = tf15m.setupDirection;
      const scoreData = evaluateInstitutionalSetup({
        symbol, direction, tf15m, tf1h, breadth, futuresData
      });

      const dirIcon = direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
      let stateText = "⏳ منتظر پولبک و شکست سقف/کف کندل";
      if (tf15m.isRanging) stateText = `⚠️ بازار رِنج (ADX: ${tf15m.adx.toFixed(0)})`;
      else if (!scoreData.h1Aligned) stateText = "⏳ ناهماهنگ با روند ۱ ساعته";
      else if (!scoreData.btcAligned) stateText = "🚫 خلاف جهت لحظه‌ای BTC";
      else if (!scoreData.rsiHealthy) stateText = `🚫 مومنتوم RSI نامناسب (${tf15m.rsi.toFixed(0)})`;
      else if (tf15m.isOverextended) stateText = "🚫 دور از EMA20 (صبر برای اصلاح)";
      else if (tf15m.hasConfirmedTrigger && scoreData.score >= FIXED_MIN_SCORE) stateText = "🔥 <b>تایید نهایی (آماده ورود!)</b>";

      blocks.push(
        `🪙 <b>#${symbol}</b> • <code>${tf15m.close}</code> <i>(1h: ${tf15m.change1hPct >= 0 ? "+" : ""}${tf15m.change1hPct.toFixed(2)}%)</i>\n` +
        `├ <b>جهت و امتیاز:</b> ${dirIcon} | <b>${scoreData.score}/100</b>\n` +
        `├ <b>فلو:</b> ADX: <code>${tf15m.adx.toFixed(0)}</code> | RSI: <code>${tf15m.rsi.toFixed(0)}</code> | Taker: <code>${futuresData.takerBuyRatio}%</code>\n` +
        `└ <b>وضعیت:</b> ${stateText}`
      );
    }

    const msg = `
🔎 <b>اسکن زنده پرایس‌اکشن (v6.1 • 15m/1H)</b>
<blockquote>🌐 <b>روند زنده BTC:</b> 15m: <b>${breadth.btcTrend15m}</b> | 1H: <b>${breadth.btcTrend1h}</b>
💧 <b>جریان نقدینگی ۱ ساعت اخیر:</b> ${breadth.usdtFlow}</blockquote>

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
          `└ <b>زمان سپری‌شده:</b> ${ageMin} دقیقه (مهلت: ۴ ساعت)</blockquote>`
        );
      }
    }
  }

  const posText = activeCards.length > 0
    ? activeCards.join("\n")
    : "<blockquote>🟢 هیچ پوزیشن بازی در حال حاضر وجود ندارد.</blockquote>";

  const report = `
📂 <b>پوزیشن‌های فعال تحت رصد (v6.1)</b>
💧 <b>جریان نقدینگی زنده:</b> ${breadth.usdtFlow}

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
  const [klines15m, klines1h, breadth, futuresData] = await Promise.all([
    fetchKlines(symbol, "15m", 120),
    fetchKlines(symbol, "1h", 100),
    analyzeLiveMarketBreadth(),
    fetchOKXFuturesData(coin)
  ]);

  if (klines15m.length < 70 || klines1h.length < 60) {
    await sendTelegramRaw(env, chatId, `❌ خطا در دریافت دیتای کندل برای #${symbol}`);
    return;
  }

  const tf15m = analyzePurePriceAction(klines15m);
  const tf1h = analyzePurePriceAction(klines1h);
  const direction = tf15m.setupDirection;
  const scoreData = evaluateInstitutionalSetup({
    symbol, direction, tf15m, tf1h, breadth, futuresData
  });
  const targets = calculateSwingTargets(tf15m, direction);

  const text = `
🔬 <b>کالبدشکافی پرایس‌اکشن (v6.1)</b> | <b>#${symbol}</b>
💰 <b>قیمت لحظه‌ای:</b> <code>${tf15m.close}</code>
⭐️ <b>امتیاز فعلی:</b> <b>${scoreData.score}/100</b> <i>(حد نصاب ثابت: ${FIXED_MIN_SCORE})</i>
<code>${buildScoreBar(scoreData.score)}</code>

🧭 <b>چک‌لیست فیلترهای اجباری (Hard Filters)</b>
├ <b>هم‌جهتی با روند ۱ ساعته:</b> ${scoreData.h1Aligned ? "✅ تایید شده" : "🚫 ناهماهنگ با 1H"}
├ <b>هم‌جهتی با رهبر بازار (BTC):</b> ${scoreData.btcAligned ? "✅ تایید شده" : "🚫 خلاف جهت BTC"}
├ <b>سلامت مومنتوم RSI:</b> ${scoreData.rsiHealthy ? `✅ عالی (${tf15m.rsi.toFixed(1)})` : `🚫 نامناسب (${tf15m.rsi.toFixed(1)})`}
├ <b>قدرت روند (Wilder ADX):</b> <code>${tf15m.adx.toFixed(1)}</code> ${tf15m.isRanging ? "⚠️ (رنج)" : "✅ (رونددار)"}
└ <b>سفارشات Taker فیوچرز:</b> <code>${futuresData.takerBuyRatio}%</code> (${futuresData.flowBias})

<blockquote>🎯 <b>سطوح ساختاری در صورت ورود (${direction}):</b>
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
📈 <b>کارنامه و آمار عملکرد بات (v6.1)</b>
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

// دستور جدید /reset برای صفر کردن آمار برد و باخت، تاریخچه و شمارنده سیگنال‌ها
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
✅ <i>از این لحظه فقط عملکرد خالص استراتژی <b>v6.1</b> ثبت خواهد شد.</i>
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
   ۱۰. توابع دریافت دیتا و محاسبات دقیق ریاضی (Wilder's ADX)
========================================================= */
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
    if (takerBuyRatio >= 52.0 && fundingRate < 0.045) flowBias = "LONG";
    else if (takerBuyRatio <= 48.0 && fundingRate > -0.045) flowBias = "SHORT";
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

function calcWilderADX(klines, period = 14) {
  if (klines.length < period * 2) return 20;
  let tr = [], pdm = [], mdm = [];

  for (let i = 1; i < klines.length; i++) {
    const up = klines[i].high - klines[i - 1].high;
    const down = klines[i - 1].low - klines[i].low;
    pdm.push(up > down && up > 0 ? up : 0);
    mdm.push(down > up && down > 0 ? down : 0);
    tr.push(Math.max(
      klines[i].high - klines[i].low,
      Math.abs(klines[i].high - klines[i - 1].close),
      Math.abs(klines[i].low - klines[i - 1].close)
    ));
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
  for (let i = period; i < dxList.length; i++) {
    adx = ((adx * (period - 1)) + dxList[i]) / period;
  }
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
  let varianceSum = 0;
  for (const k of klines) {
    const tp = (k.high + k.low + k.close) / 3;
    varianceSum += k.volume * Math.pow(tp - vwap, 2);
  }
  const stdDev = vol === 0 ? 0 : Math.sqrt(varianceSum / vol);
  return { vwap, upper1: vwap + stdDev * 1.28, lower1: vwap - stdDev * 1.28 };
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
  const inBearishOB = Boolean(bearOB && current.high >= bearOB.bottom - buf && current.close <= bearOB.top);
  return { bullOB, bearOB, inBullishOB, inBearishOB };
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