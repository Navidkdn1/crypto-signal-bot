/**
 * 🚀 Crypto Scalping Signal Bot v2.4 (Smart Money OB + RSI Divergence Edition)
 * Coins: BTC, ETH, SOL, BNB | Timeframes: 5m & 15m
 * Features: Multi-Exchange Anti-Block, Supertrend, VWAP, Order Blocks, RSI Divergence, Macro & News
 */

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"];
const MAX_OPEN_POSITIONS = 2;
const POSITION_TTL_SECONDS = 2700; // ۴۵ دقیقه

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Accept": "application/json"
};

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runBotEngine(env, false));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/diag") {
      const testKlines = await fetchKlines("BTCUSDT", "5m", 100);
      const testMacro = await fetchMacroData();
      return new Response(JSON.stringify({
        ok: true,
        version: "2.4 (OrderBlock + RSI Divergence)",
        candlesFetched: testKlines.length,
        sampleLastPrice: testKlines.length ? testKlines[testKlines.length - 1].close : null,
        macroData: testMacro
      }, null, 2), { headers: { "Content-Type": "application/json; charset=utf-8" } });
    }

    if (url.pathname === "/test") {
      const res = await sendTelegramGlobal(env, "✅ <b>بات نسخه 2.4 (مجهز به Order Block و واگرایی RSI) فعال شد!</b>\nحالا در تلگرام دستور /scan یا /force را بفرستید.");
      return new Response(JSON.stringify(res, null, 2), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      try {
        const update = await request.json();
        if (update.message && update.message.text) {
          const chatId = update.message.chat.id;
          const text = update.message.text.trim().split("@")[0].toLowerCase();

          if (text === "/status") {
            await handleStatusCommand(env, chatId);
          } else if (text === "/scan") {
            await sendTelegramRaw(env, chatId, "⏳ در حال اسکن کندل‌ها، نواحی Order Block و واگرایی RSI...");
            await handleScanCommand(env, chatId);
          } else if (text === "/force") {
            await sendTelegramRaw(env, chatId, "⚡ در حال استخراج بهترین موقعیت فعلی بازار...");
            await runBotEngine(env, true, chatId);
          } else {
            const reply = `
🟢 <b>بات سیگنال‌دهی هوشمند آنلاین است (v2.4)</b>
━━━━━━━━━━━━━━━━━━
🧠 <b>موتور تحلیلی:</b> Supertrend + VWAP + Order Blocks + RSI Divergence
📋 <b>دستورات قابل استفاده:</b>
🔹 /scan — اسکن لحظه‌ای ۴ ارز (همراه با وضعیت OB و واگرایی)
🔹 /status — وضعیت دامیننس‌ها و پوزیشن‌های باز
🔹 /force — صدور فوری بهترین سیگنال فعلی بازار
`.trim();
            await sendTelegramRaw(env, chatId, reply);
          }
        }
      } catch (err) {
        console.error("Webhook Error:", err);
      }
      return new Response("OK", { status: 200 });
    }

    return new Response("🤖 Crypto Signal Bot v2.4 is Running!", { status: 200 });
  }
};

/* =========================================================
   ۱. سیستم چندلایه دریافت کندل (OKX -> Gate.io -> KuCoin -> Binance)
========================================================= */
async function fetchKlines(symbol, interval, limit = 100) {
  const coin = symbol.replace("USDT", "");

  // ۱. صرافی OKX
  try {
    const okxBar = interval === "5m" ? "5m" : "15m";
    const okxUrl = `https://www.okx.com/api/v5/market/candles?instId=${coin}-USDT&bar=${okxBar}&limit=${limit}`;
    const res = await fetch(okxUrl, { headers: BROWSER_HEADERS });
    if (res.ok) {
      const json = await res.json();
      if (json.data && json.data.length >= 50) {
        return json.data.reverse().map(d => ({
          open: parseFloat(d[1]),
          high: parseFloat(d[2]),
          low: parseFloat(d[3]),
          close: parseFloat(d[4]),
          volume: parseFloat(d[5])
        }));
      }
    }
  } catch (e) {}

  // ۲. صرافی Gate.io
  try {
    const gateUrl = `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${coin}_USDT&interval=${interval}&limit=${limit}`;
    const res = await fetch(gateUrl, { headers: BROWSER_HEADERS });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length >= 50) {
        return data.map(d => ({
          open: parseFloat(d[5]),
          high: parseFloat(d[3]),
          low: parseFloat(d[4]),
          close: parseFloat(d[2]),
          volume: parseFloat(d[6])
        }));
      }
    }
  } catch (e) {}

  // ۳. صرافی KuCoin
  try {
    const kcType = interval === "5m" ? "5min" : "15min";
    const kcUrl = `https://api.kucoin.com/api/v1/market/candles?type=${kcType}&symbol=${coin}-USDT`;
    const res = await fetch(kcUrl, { headers: BROWSER_HEADERS });
    if (res.ok) {
      const json = await res.json();
      if (json.data && json.data.length >= 50) {
        return json.data.slice(0, limit).reverse().map(d => ({
          open: parseFloat(d[1]),
          close: parseFloat(d[2]),
          high: parseFloat(d[3]),
          low: parseFloat(d[4]),
          volume: parseFloat(d[5])
        }));
      }
    }
  } catch (e) {}

  // ۴. سرورهای Binance
  const binanceHosts = ["https://data-api.binance.vision", "https://api4.binance.com", "https://api1.binance.com"];
  for (const host of binanceHosts) {
    try {
      const res = await fetch(`${host}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, { headers: BROWSER_HEADERS });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length >= 50) {
          return data.map(d => ({
            open: parseFloat(d[1]),
            high: parseFloat(d[2]),
            low: parseFloat(d[3]),
            close: parseFloat(d[4]),
            volume: parseFloat(d[5])
          }));
        }
      }
    } catch (e) {}
  }

  return [];
}

/* =========================================================
   ۲. دریافت دامیننس‌های واقعی (CoinGecko -> CoinLore Fallback)
========================================================= */
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
      const globalArr = await globalRes.json();
      const g = globalArr[0];
      const totalMcap = parseFloat(g.total_mcap) || 2500000000000;
      const btcD = parseFloat(g.btc_d) || 55;
      const total24h = parseFloat(g.mcap_change) || 0;

      let usdtD = 5.2;
      if (usdtRes.ok) {
        const usdtArr = await usdtRes.json();
        if (usdtArr[0]?.market_cap_usd) {
          usdtD = (parseFloat(usdtArr[0].market_cap_usd) / totalMcap) * 100;
        }
      }

      let bias = "NEUTRAL";
      if (total24h > 0.5) bias = "BULLISH";
      else if (total24h < -0.5) bias = "BEARISH";

      return { btcD: btcD.toFixed(2), usdtD: usdtD.toFixed(2), total24h: total24h.toFixed(2), bias };
    }
  } catch (e) {}

  return { btcD: "55.10", usdtD: "5.10", total24h: "0.10", bias: "NEUTRAL" };
}

/* =========================================================
   ۳. اسکن لحظه‌ای بازار با دستور /scan
========================================================= */
async function handleScanCommand(env, chatId) {
  try {
    const macroData = await fetchMacroData();
    let lines = [];

    for (const symbol of SYMBOLS) {
      const [klines5m, klines15m] = await Promise.all([
        fetchKlines(symbol, "5m", 100),
        fetchKlines(symbol, "15m", 100)
      ]);

      if (klines5m.length < 50 || klines15m.length < 50) {
        lines.push(`• <b>#${symbol}</b>: ⚠️ خطا در دریافت کندل`);
        continue;
      }

      const tf5m = analyzeIndicators(klines5m, 7, 2.0);
      const tf15m = analyzeIndicators(klines15m, 10, 3.0);
      const direction = tf5m.supertrend.direction;
      const scoreData = evaluateSignalScore({
        direction,
        tf5m,
        tf15m,
        macroData,
        news: { bias: "NEUTRAL", label: "متعادل" }
      });

      const rangeStatus = tf5m.isRanging ? "⚠️ رِنج" : "✅ رونددار";
      const dirEmoji = direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";

      // نمایش وضعیت Order Block و واگرایی در اسکن
      const obLabel = tf5m.orderBlock.inBullishOB
        ? "🟦 درون Bullish OB"
        : tf5m.orderBlock.inBearishOB
        ? "🟥 درون Bearish OB"
        : tf5m.orderBlock.nearBullishOB
        ? "🔹 نزدیک Bullish OB"
        : tf5m.orderBlock.nearBearishOB
        ? "🔸 نزدیک Bearish OB"
        : "⚪ بدون OB فعال";

      const divLabel = tf5m.divergence.bullish
        ? "🟢 واگرایی مثبت (+RD)"
        : tf5m.divergence.bearish
        ? "🔴 واگرایی منفی (-RD)"
        : "⚪ بدون واگرایی";

      lines.push(
        `🔹 <b>#${symbol}</b> | قیمت: <code>${tf5m.close}</code>\n` +
        `   جهت: <b>${dirEmoji}</b> | امتیاز کل: <b>${scoreData.score}/100</b>\n` +
        `   وضعیت: ${rangeStatus} | RSI: ${tf5m.rsi.toFixed(1)} | ADX: ${tf5m.adx.toFixed(1)}\n` +
        `   📦 <b>OB:</b> ${obLabel}\n` +
        `   📐 <b>واگرایی:</b> ${divLabel}`
      );
    }

    const msg = `
🔎 <b>نتیجه اسکن لحظه‌ای بازار (v2.4 Smart Money)</b>
━━━━━━━━━━━━━━━━━━
🌐 <b>BTC.D:</b> ${macroData.btcD}% | <b>USDT.D:</b> ${macroData.usdtD}% | <b>TOTAL:</b> ${macroData.total24h}%

${lines.join("\n\n")}

💡 <i>برای دریافت فوری بهترین سیگنال فعلی، دستور /force را بفرستید.</i>
`.trim();

    await sendTelegramRaw(env, chatId, msg);
  } catch (e) {
    await sendTelegramRaw(env, chatId, `❌ خطا در اسکن بازار: ${e.message}`);
  }
}

/* =========================================================
   ۴. موتور اصلی اسکن خودکار و صدور سیگنال
========================================================= */
async function runBotEngine(env, forceBest = false, customChatId = null) {
  try {
    let activePositions = await checkActivePositions(env);
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
        fetchKlines(symbol, "5m", 100),
        fetchKlines(symbol, "15m", 100)
      ]);
      if (klines5m.length < 50 || klines15m.length < 50) continue;

      const tf5m = analyzeIndicators(klines5m, 7, 2.0);
      const tf15m = analyzeIndicators(klines15m, 10, 3.0);

      // اگر واگرایی قوی + برخورد به Order Block رخ داده باشد، حتی قبل از چرخش سوپرترند هم جهت را تشخیص می‌دهد
      let direction = tf5m.supertrend.direction;
      if (tf5m.divergence.bullish && tf5m.orderBlock.inBullishOB) direction = "LONG";
      if (tf5m.divergence.bearish && tf5m.orderBlock.inBearishOB) direction = "SHORT";

      const coin = symbol.replace("USDT", "");
      const news = await fetchNewsSentiment(coin, env.CRYPTOPANIC_API_KEY);
      const scoreData = evaluateSignalScore({ direction, tf5m, tf15m, macroData, news });

      const candidate = { symbol, direction, entry: tf5m.close, tf5m, scoreData, macroData };
      if (!bestCandidate || scoreData.score > bestCandidate.scoreData.score) {
        bestCandidate = candidate;
      }

      if (!forceBest && !tf5m.isRanging && tf5m.hasEntryTrigger && scoreData.score >= 65) {
        const targets = calculateTargets(tf5m.close, tf5m.atr, direction);
        await sendSignalMessage(env, { ...candidate, targets }, customChatId);

        if (env.SIGNAL_KV) {
          const posState = {
            symbol, direction,
            entry: tf5m.close,
            tp1: parseFloat(targets.tp1),
            tp2: parseFloat(targets.tp2),
            sl: parseFloat(targets.sl),
            tp1Hit: false
          };
          await env.SIGNAL_KV.put(`POS_${symbol}`, JSON.stringify(posState), { expirationTtl: POSITION_TTL_SECONDS });
        }
        activePositions++;
      }
    }

    if (forceBest && bestCandidate) {
      const targets = calculateTargets(bestCandidate.entry, bestCandidate.tf5m.atr, bestCandidate.direction);
      await sendSignalMessage(env, { ...bestCandidate, targets }, customChatId);
    }
  } catch (error) {
    console.error("Bot Engine Error:", error);
  }
}

/* =========================================================
   ۵. مدیریت دستور /status و ردیابی پوزیشن‌ها
========================================================= */
async function handleStatusCommand(env, chatId) {
  const macro = await fetchMacroData();
  let activeSummary = [];

  if (env.SIGNAL_KV) {
    for (const symbol of SYMBOLS) {
      const raw = await env.SIGNAL_KV.get(`POS_${symbol}`);
      if (raw) {
        const p = JSON.parse(raw);
        activeSummary.push(`• <b>#${symbol}</b> (${p.direction}) | ورود: <code>${p.entry}</code> | SL: <code>${p.sl}</code>`);
      }
    }
  }

  const positionsText = activeSummary.length > 0 ? activeSummary.join("\n") : "هیچ پوزیشن بازی وجود ندارد. 🟢";
  const report = `
📊 <b>گزارش وضعیت لحظه‌ای بات (v2.4)</b>
━━━━━━━━━━━━━━━━━━
🌐 <b>وضعیت کلان بازار:</b>
• <b>BTC.D:</b> ${macro.btcD}% | <b>USDT.D:</b> ${macro.usdtD}%
• <b>تغییرات TOTAL:</b> ${macro.total24h}% (${macro.bias})

📂 <b>پوزیشن‌های فعال:</b>
${positionsText}
`.trim();

  await sendTelegramRaw(env, chatId, report);
}

async function checkActivePositions(env) {
  if (!env.SIGNAL_KV) return 0;
  let count = 0;
  for (const symbol of SYMBOLS) {
    const raw = await env.SIGNAL_KV.get(`POS_${symbol}`);
    if (!raw) continue;
    const pos = JSON.parse(raw);
    const klines = await fetchKlines(symbol, "5m", 55);
    if (!klines.length) { count++; continue; }

    const last = klines[klines.length - 1];
    const isLong = pos.direction === "LONG";
    const slHit = isLong ? last.low <= pos.sl : last.high >= pos.sl;
    const tp2Hit = isLong ? last.high >= pos.tp2 : last.low <= pos.tp2;
    const tp1Hit = isLong ? last.high >= pos.tp1 : last.low <= pos.tp1;

    if (slHit) {
      await sendTelegramGlobal(env, `🛑 <b>بسته شدن پوزیشن #${symbol}</b>\nبرخورد با حد ضرر در <code>${pos.sl}</code>`);
      await env.SIGNAL_KV.delete(`POS_${symbol}`);
    } else if (tp2Hit) {
      await sendTelegramGlobal(env, `🎯🔥 <b>فول تارگت #${symbol}!</b>\nرسیدن به تارگت دوم در <code>${pos.tp2}</code>`);
      await env.SIGNAL_KV.delete(`POS_${symbol}`);
    } else if (tp1Hit && !pos.tp1Hit) {
      pos.tp1Hit = true;
      await sendTelegramGlobal(env, `✅ <b>تارگت اول #${symbol} تاچ شد!</b>\nقیمت به <code>${pos.tp1}</code> رسید. پوزیشن را ریسک‌فری کنید.`);
      await env.SIGNAL_KV.put(`POS_${symbol}`, JSON.stringify(pos), { expirationTtl: 1800 });
      count++;
    } else {
      count++;
    }
  }
  return count;
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
   ۶. محاسبات اندیکاتورها + واگرایی RSI + نواحی Order Block
========================================================= */
function analyzeIndicators(klines, stPeriod, stMult) {
  const closes = klines.map(k => k.close);
  const current = klines[klines.length - 1];
  const ema9 = calcEMA(closes, 9);
  const ema20 = calcEMA(closes, 20);
  const prevCloses = closes.slice(0, -1);
  const prevEma9 = calcEMA(prevCloses, 9);
  const prevEma20 = calcEMA(prevCloses, 20);

  const rsiSeries = calcRSISeries(closes, 14);
  const rsi = rsiSeries[rsiSeries.length - 1];
  const atr = calcATR(klines, 14);
  const adx = calcADX(klines, 14);
  const vwap = calcVWAP(klines.slice(-48));
  const bb = calcBollingerBands(closes, 20, 2);
  const supertrend = calcSupertrend(klines, stPeriod, stMult);

  // ۱. تشخیص واگرایی RSI (Divergence)
  const divergence = detectRSIDivergence(klines, rsiSeries, 30);

  // ۲. تشخیص نواحی Order Block (Smart Money)
  const orderBlock = detectOrderBlocks(klines, atr, 40);

  const avgVol = klines.slice(-21, -1).reduce((s, k) => s + k.volume, 0) / 20;
  const volRatio = current.volume / (avgVol || 1);

  const isRanging = adx < 18 && bb.bandwidth < 0.0035;
  const bullCross = prevEma9 <= prevEma20 && ema9 > ema20 && supertrend.direction === "LONG";
  const bearCross = prevEma9 >= prevEma20 && ema9 < ema20 && supertrend.direction === "SHORT";

  const trendContinuation =
    (supertrend.direction === "LONG" && current.close > ema9 && ema9 > ema20 && current.close > vwap) ||
    (supertrend.direction === "SHORT" && current.close < ema9 && ema9 < ema20 && current.close < vwap);

  // ماشه ورود اسمارت مانی: واکنش به اوردر بلاک یا واگرایی
  const smartMoneyTrigger =
    (orderBlock.inBullishOB && (divergence.bullish || supertrend.direction === "LONG")) ||
    (orderBlock.inBearishOB && (divergence.bearish || supertrend.direction === "SHORT"));

  const hasEntryTrigger = supertrend.justFlipped || bullCross || bearCross || trendContinuation || smartMoneyTrigger;

  return {
    close: current.close,
    ema9, ema20, vwap, rsi, atr, adx, bb, supertrend,
    volRatio, isRanging, hasEntryTrigger,
    divergence,
    orderBlock
  };
}

// الگوریتم محاسبه سری زمانی RSI (Wilder's Smoothing) برای دقت بالای واگرایی
function calcRSISeries(closes, period = 14) {
  const rsiArr = new Array(closes.length).fill(50);
  if (closes.length <= period) return rsiArr;

  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  rsiArr[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsiArr[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return rsiArr;
}

// الگوریتم تشخیص واگرایی معمولی و مخفی RSI (Regular & Hidden Divergence)
function detectRSIDivergence(klines, rsiSeries, lookback = 30) {
  const len = klines.length;
  const start = Math.max(5, len - lookback);
  let swingLows = [];
  let swingHighs = [];

  // یافتن پیوت‌های کف و سقف محلی
  for (let i = start; i < len - 1; i++) {
    const isLowPivot = klines[i].low <= klines[i - 1].low && klines[i].low <= klines[i - 2].low && klines[i].low <= klines[i + 1].low;
    const isHighPivot = klines[i].high >= klines[i - 1].high && klines[i].high >= klines[i - 2].high && klines[i].high >= klines[i + 1].high;

    if (isLowPivot) swingLows.push({ index: i, price: klines[i].low, rsi: rsiSeries[i] });
    if (isHighPivot) swingHighs.push({ index: i, price: klines[i].high, rsi: rsiSeries[i] });
  }

  let bullish = false, bearish = false, type = "NONE";

  // بررسی واگرایی مثبت صعودی (Bullish Divergence) در کف‌های اخیر
  if (swingLows.length >= 2) {
    const last = swingLows[swingLows.length - 1];
    const prev = swingLows[swingLows.length - 2];
    const isRecent = (len - 1 - last.index) <= 6; // واگرایی مربوط به کندل‌های اخیر باشد

    // واگرایی معمولی مثبت (+RD): کف قیمتی پایین‌تر ولی کف RSI بالاتر
    if (isRecent && last.price < prev.price && last.rsi > prev.rsi + 1.5 && last.rsi < 48) {
      bullish = true;
      type = "واگرایی مثبت معمولی (+RD)";
    }
    // واگرایی مخفی مثبت (+HD): کف قیمتی بالاتر ولی کف RSI پایین‌تر (ادامه‌دهنده روند)
    else if (isRecent && last.price > prev.price && last.rsi < prev.rsi - 1.5 && last.rsi < 55) {
      bullish = true;
      type = "واگرایی مثبت مخفی (+HD)";
    }
  }

  // بررسی واگرایی منفی نزولی (Bearish Divergence) در سقف‌های اخیر
  if (swingHighs.length >= 2) {
    const last = swingHighs[swingHighs.length - 1];
    const prev = swingHighs[swingHighs.length - 2];
    const isRecent = (len - 1 - last.index) <= 6;

    // واگرایی معمولی منفی (-RD): سقف قیمتی بالاتر ولی سقف RSI پایین‌تر
    if (isRecent && last.price > prev.price && last.rsi < prev.rsi - 1.5 && last.rsi > 52) {
      bearish = true;
      type = "واگرایی منفی معمولی (-RD)";
    }
    // واگرایی مخفی منفی (-HD): سقف قیمتی پایین‌تر ولی سقف RSI بالاتر
    else if (isRecent && last.price < prev.price && last.rsi > prev.rsi + 1.5 && last.rsi > 45) {
      bearish = true;
      type = "واگرایی منفی مخفی (-HD)";
    }
  }

  return { bullish, bearish, type };
}

// الگوریتم تشخیص نواحی Order Block (Smart Money / ICT)
function detectOrderBlocks(klines, atr, lookback = 40) {
  const len = klines.length;
  const current = klines[len - 1];
  const prevCandle = klines[len - 2];
  const start = Math.max(2, len - lookback);

  let bullOB = null;
  let bearOB = null;

  for (let i = start; i < len - 3; i++) {
    const c = klines[i];
    const next1 = klines[i + 1];
    const next2 = klines[i + 2];

    const isBearishCandle = c.close < c.open;
    const isBullishCandle = c.close > c.open;

    // حرکت ایمپالس صعودی بعد از کندل قرمز -> شکل‌گیری Bullish Order Block
    const bullImpulse = (next1.close - c.open) > (atr * 1.25) || ((next2.close - c.open) > (atr * 1.6) && next1.close > c.high);
    if (isBearishCandle && bullImpulse) {
      const zoneBottom = c.low;
      const zoneTop = Math.max(c.open, c.high);
      // بررسی اینکه آیا این اوردر بلاک بعداً شکسته شده (Invalidated) یا هنوز معتبر است
      let invalidated = false;
      for (let j = i + 3; j < len - 1; j++) {
        if (klines[j].close < zoneBottom) {
          invalidated = true;
          break;
        }
      }
      if (!invalidated) {
        bullOB = { bottom: zoneBottom, top: zoneTop };
      }
    }

    // حرکت ایمپالس نزولی بعد از کندل سبز -> شکل‌گیری Bearish Order Block
    const bearImpulse = (c.open - next1.close) > (atr * 1.25) || ((c.open - next2.close) > (atr * 1.6) && next1.close < c.low);
    if (isBullishCandle && bearImpulse) {
      const zoneBottom = Math.min(c.open, c.low);
      const zoneTop = c.high;
      let invalidated = false;
      for (let j = i + 3; j < len - 1; j++) {
        if (klines[j].close > zoneTop) {
          invalidated = true;
          break;
        }
      }
      if (!invalidated) {
        bearOB = { bottom: zoneBottom, top: zoneTop };
      }
    }
  }

  // بررسی اینکه آیا قیمت فعلی داخل یا در مجاورت نزدیک Order Block است
  const buffer = atr * 0.35;
  const inBullishOB = Boolean(bullOB && (current.low <= bullOB.top + buffer && current.close >= bullOB.bottom));
  const nearBullishOB = Boolean(bullOB && !inBullishOB && Math.abs(current.close - bullOB.top) <= atr * 0.8 && current.close > bullOB.top);

  const inBearishOB = Boolean(bearOB && (current.high >= bearOB.bottom - buffer && current.close <= bearOB.top));
  const nearBearishOB = Boolean(bearOB && !inBearishOB && Math.abs( bearOB.bottom - current.close) <= atr * 0.8 && current.close < bearOB.bottom);

  return {
    bullOB,
    bearOB,
    inBullishOB,
    nearBullishOB,
    inBearishOB,
    nearBearishOB
  };
}

function calcVWAP(klines) {
  let cumPV = 0, cumVol = 0;
  for (const k of klines) {
    cumPV += ((k.high + k.low + k.close) / 3) * k.volume;
    cumVol += k.volume;
  }
  return cumVol === 0 ? klines[klines.length - 1].close : cumPV / cumVol;
}

function calcBollingerBands(closes, period = 20, mult = 2) {
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  const upper = mean + mult * stdDev;
  const lower = mean - mult * stdDev;
  return { upper, middle: mean, lower, bandwidth: (upper - lower) / mean };
}

function calcSupertrend(klines, period = 7, multiplier = 2.0) {
  let trs = [0];
  for (let i = 1; i < klines.length; i++) {
    trs.push(Math.max(klines[i].high - klines[i].low, Math.abs(klines[i].high - klines[i - 1].close), Math.abs(klines[i].low - klines[i - 1].close)));
  }
  let upperBand = 0, lowerBand = 0, direction = "LONG", prevDir = "LONG";
  for (let i = period; i < klines.length; i++) {
    const atr = trs.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
    const hl2 = (klines[i].high + klines[i].low) / 2;
    const basicUpper = hl2 + multiplier * atr;
    const basicLower = hl2 - multiplier * atr;
    upperBand = (basicUpper < upperBand || klines[i - 1].close > upperBand) ? basicUpper : upperBand;
    lowerBand = (basicLower > lowerBand || klines[i - 1].close < lowerBand) ? basicLower : lowerBand;
    prevDir = direction;
    if (klines[i].close > upperBand) direction = "LONG";
    else if (klines[i].close < lowerBand) direction = "SHORT";
  }
  return { direction, justFlipped: direction !== prevDir };
}

function calcEMA(values, period) {
  const k = 2 / (period + 1);
  return values.reduce((ema, val, i) => (i === 0 ? val : val * k + ema * (1 - k)), values[0]);
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
    const up = klines[i].high - klines[i - 1].high;
    const down = klines[i - 1].low - klines[i].low;
    const plusDM = (up > down && up > 0) ? up : 0;
    const minusDM = (down > up && down > 0) ? down : 0;
    const tr = Math.max(klines[i].high - klines[i].low, Math.abs(klines[i].high - klines[i - 1].close), Math.abs(klines[i].low - klines[i - 1].close)) || 1;
    const pDI = (plusDM / tr) * 100;
    const mDI = (minusDM / tr) * 100;
    dx.push((Math.abs(pDI - mDI) / ((pDI + mDI) || 1)) * 100);
  }
  return dx.slice(-period).reduce((a, b) => a + b, 0) / period;
}

/* =========================================================
   ۷. تابع امتیازدهی ۱۰۰ امتیازی نسخه v2.4 (با OB و واگرایی)
========================================================= */
function evaluateSignalScore({ direction, tf5m, tf15m, macroData, news }) {
  let score = 0;
  let reasons = [];

  // ۱. هماهنگی سوپرترند ۵ دقیقه و ۱۵ دقیقه (۲۰ امتیاز)
  if (tf5m.supertrend.direction === tf15m.supertrend.direction) {
    score += 20;
    reasons.push("✅ هم‌جهتی کامل Supertrend در 5m و 15m");
  } else {
    score += 10;
  }

  // ۲. بررسی نواحی Order Block اسمارت مانی (۱۵ امتیاز)
  if (direction === "LONG" && tf5m.orderBlock.inBullishOB) {
    score += 15;
    reasons.push("🟦 واکنش مستقیم قیمت به ناحیه Bullish Order Block");
  } else if (direction === "SHORT" && tf5m.orderBlock.inBearishOB) {
    score += 15;
    reasons.push("🟥 واکنش مستقیم قیمت به ناحیه Bearish Order Block");
  } else if (
    (direction === "LONG" && tf5m.orderBlock.nearBullishOB) ||
    (direction === "SHORT" && tf5m.orderBlock.nearBearishOB)
  ) {
    score += 10;
    reasons.push("📦 حمایت توسط ناحیه Order Block نزدیک قیمت");
  } else {
    score += 5;
  }

  // ۳. بررسی واگرایی RSI و مومنتوم (۱۵ امتیاز)
  const hasAlignedDiv = (direction === "LONG" && tf5m.divergence.bullish) ||
                        (direction === "SHORT" && tf5m.divergence.bearish);
  const rsiHealthy = (direction === "LONG" && tf5m.rsi >= 45 && tf5m.rsi <= 74) ||
                     (direction === "SHORT" && tf5m.rsi <= 55 && tf5m.rsi >= 26);

  if (hasAlignedDiv) {
    score += 15;
    reasons.push(`📐 تایید ${tf5m.divergence.type} در اندیکاتور RSI`);
  } else if (rsiHealthy) {
    score += 11;
    reasons.push(`✅ مومنتوم استاندارد RSI (${tf5m.rsi.toFixed(1)})`);
  } else {
    score += 5;
  }

  // ۴. موقعیت قیمت نسبت به VWAP و EMA 9/20 (۱۵ امتیاز)
  const vwapOk = (direction === "LONG" && tf5m.close > tf5m.vwap && tf5m.ema9 > tf5m.ema20) ||
                 (direction === "SHORT" && tf5m.close < tf5m.vwap && tf5m.ema9 < tf5m.ema20);
  if (vwapOk) {
    score += 15;
    reasons.push("✅ تثبیت قیمت در سمت درست VWAP و EMA 9/20");
  } else {
    score += 7;
  }

  // ۵. قدرت روند ADX (۱۵ امتیاز)
  if (tf5m.adx >= 22) {
    score += 15;
    reasons.push(`✅ قدرت روند مناسب (ADX: ${tf5m.adx.toFixed(0)})`);
  } else {
    score += 8;
  }

  // ۶. حجم معاملات (۱۰ امتیاز)
  if (tf5m.volRatio >= 1.15) {
    score += 10;
    reasons.push(`✅ ورود حجم پول هوشمند (${tf5m.volRatio.toFixed(1)}x میانگین)`);
  } else {
    score += 5;
  }

  // ۷. دامیننس‌ها و سنتیمنت اخبار (۱۰ امتیاز)
  if (((direction === "LONG" && macroData.bias === "BULLISH") || (direction === "SHORT" && macroData.bias === "BEARISH")) || news.bias === direction) {
    score += 10;
    reasons.push("✅ هم‌سویی با جریان نقدینگی کلان (TOTAL/USDT.D)");
  } else {
    score += 5;
  }

  let grade = "⚡ متوسط (B)";
  if (score >= 85) grade = "💎 عالی (VIP A+)";
  else if (score >= 75) grade = "🔥 قوی (A)";

  return { score, grade, reasons, newsLabel: news.label };
}

function calculateTargets(price, atr, direction) {
  const dec = price > 100 ? 2 : 3;
  const m = direction === "LONG" ? 1 : -1;
  return {
    sl: (price - m * (atr * 1.5)).toFixed(dec),
    tp1: (price + m * (atr * 1.5)).toFixed(dec),
    tp2: (price + m * (atr * 2.5)).toFixed(dec)
  };
}

async function sendSignalMessage(env, data, customChatId = null) {
  const { symbol, direction, entry, targets, scoreData, tf5m, macroData } = data;
  const dirLabel = direction === "LONG" ? "🟢 LONG (خرید)" : "🔴 SHORT (فروش)";
  const dec = entry > 100 ? 2 : 3;

  // نمایش ناحیه دقیق Order Block در پیام سیگنال
  let obZoneText = "ندارد";
  if (direction === "LONG" && tf5m.orderBlock.bullOB) {
    obZoneText = `<code>${tf5m.orderBlock.bullOB.bottom.toFixed(dec)}</code> تا <code>${tf5m.orderBlock.bullOB.top.toFixed(dec)}</code>`;
  } else if (direction === "SHORT" && tf5m.orderBlock.bearOB) {
    obZoneText = `<code>${tf5m.orderBlock.bearOB.bottom.toFixed(dec)}</code> تا <code>${tf5m.orderBlock.bearOB.top.toFixed(dec)}</code>`;
  }

  const divText = tf5m.divergence.type !== "NONE" ? tf5m.divergence.type : "ندارد (حالت عادی روند)";

  const text = `
🚨 <b>سیگنال اسکلپ هوشمند (v2.4) | #${symbol}</b>
━━━━━━━━━━━━━━━━━━
🧭 <b>نوع پوزیشن:</b> ${dirLabel}
⭐ <b>امتیاز اعتبار:</b> <b>${scoreData.score}/100</b> (${scoreData.grade})
⏱ <b>تایم‌فریم:</b> ۵ دقیقه (فیلتر ساختار ۱۵ دقیقه)

🎯 <b>نقاط ورود و تارگت‌ها:</b>
🔹 <b>ورود (Entry):</b> <code>${entry}</code>
✅ <b>تارگت اول (TP1):</b> <code>${targets.tp1}</code>
🚀 <b>تارگت دوم (TP2):</b> <code>${targets.tp2}</code>
🛑 <b>حد ضرر (SL):</b> <code>${targets.sl}</code>

🧠 <b>داده‌های اسمارت مانی و تکنیکال:</b>
• <b>ناحیه Order Block:</b> ${obZoneText}
• <b>وضعیت واگرایی RSI:</b> ${divText}
• <b>VWAP:</b> <code>${tf5m.vwap.toFixed(dec)}</code> | <b>RSI:</b> ${tf5m.rsi.toFixed(1)}
• <b>BTC.D:</b> ${macroData.btcD}% | <b>USDT.D:</b> ${macroData.usdtD}%

📋 <b>چک‌لیست تاییدیه سیگنال:</b>
${scoreData.reasons.join("\n")}
`.trim();

  if (customChatId) {
    await sendTelegramRaw(env, customChatId, text);
  } else {
    await sendTelegramGlobal(env, text);
  }
}

async function sendTelegramGlobal(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return { ok: false };
  return await sendTelegramRaw(env, env.TELEGRAM_CHAT_ID, text);
}

async function sendTelegramRaw(env, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" })
  });
  return await res.json();
}