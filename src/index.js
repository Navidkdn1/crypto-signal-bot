/**
 * 🚀 Crypto Scalping Signal Bot v2.0 (Cloudflare Worker)
 * Coins: BTC, ETH, SOL, BNB
 * Indicators: Supertrend (7,2 on 5m & 10,3 on 15m), VWAP, EMA 9/20, BB Squeeze, ADX, RSI, ATR
 * Features: Macro Filter (BTC.D, USDT.D, TOTAL), News Sentiment & Auto TP/SL Tracker
 */

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"];
const MAX_OPEN_POSITIONS = 2;
const POSITION_TTL_SECONDS = 2700; // حداکثر ۴۵ دقیقه زمان مجاز برای پوزیشن کوتاه‌مدت

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runBotEngine(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/test") {
      await runBotEngine(env);
      return new Response("✅ اسکن بازار و بررسی پوزیشن‌ها با موفقیت انجام شد!", { status: 200 });
    }
    return new Response("🤖 Crypto Signal Bot v2.0 is Active!", { status: 200 });
  }
};

async function runBotEngine(env) {
  try {
    // ۱. بررسی پوزیشن‌های باز قبلی (اعلام تاچ شدن TP یا SL در تلگرام)
    let activePositions = await checkActivePositions(env);

    if (activePositions >= MAX_OPEN_POSITIONS) {
      console.log(`⚠️ حداکثر پوزیشن مجاز (${activePositions}) فعال است.`);
      return;
    }

    // ۲. دریافت داده‌های کلان (BTC.D, USDT.D, TOTAL)
    const macroData = await fetchMacroData();

    // ۳. اسکن ۴ ارز اصلی
    for (const symbol of SYMBOLS) {
      if (activePositions >= MAX_OPEN_POSITIONS) break;

      const existingPos = await env.SIGNAL_KV?.get(`POS_${symbol}`);
      if (existingPos) continue; // این ارز در حال حاضر پوزیشن باز دارد

      const [klines5m, klines15m] = await Promise.all([
        fetchKlines(symbol, "5m", 120),
        fetchKlines(symbol, "15m", 100)
      ]);

      if (klines5m.length < 60 || klines15m.length < 60) continue;

      // تحلیل تایم‌فریم ۵ دقیقه با Supertrend (7, 2) و ۱۵ دقیقه با Supertrend (10, 3)
      const tf5m = analyzeIndicators(klines5m, 7, 2.0);
      const tf15m = analyzeIndicators(klines15m, 10, 3.0);

      // فیلتر اول: حذف بازار رنج (فشردگی بولینگر یا ADX ضعیف)
      if (tf5m.isRanging) continue;

      const direction = tf5m.supertrend.direction; // 'LONG' or 'SHORT'

      // ماشه ورود: چرخش سوپرترند ۵ دقیقه یا تقاطع EMA 9/20 در جهت سوپرترند
      const triggerSignal = tf5m.supertrend.justFlipped || tf5m.emaCrossInTrend;
      if (!triggerSignal) continue;

      // دریافت سنتیمنت اخبار
      const coin = symbol.replace("USDT", "");
      const news = await fetchNewsSentiment(coin, env.CRYPTOPANIC_API_KEY);

      // محاسبه امتیاز از ۱۰۰
      const scoreData = evaluateSignalScore({ direction, tf5m, tf15m, macroData, news });

      // ارسال فقط سیگنال‌های با امتیاز ۷۰ به بالا
      if (scoreData.score >= 70) {
        const targets = calculateTargets(tf5m.close, tf5m.atr, direction);

        await sendSignalMessage(env, {
          symbol,
          direction,
          entry: tf5m.close,
          targets,
          scoreData,
          tf5m,
          macroData
        });

        // ذخیره پوزیشن در KV برای ردیابی تارگت و جلوگیری از سیگنال تکراری
        if (env.SIGNAL_KV) {
          const posState = {
            symbol,
            direction,
            entry: tf5m.close,
            tp1: parseFloat(targets.tp1),
            tp2: parseFloat(targets.tp2),
            sl: parseFloat(targets.sl),
            tp1Hit: false
          };
          await env.SIGNAL_KV.put(`POS_${symbol}`, JSON.stringify(posState), {
            expirationTtl: POSITION_TTL_SECONDS
          });
        }
        activePositions++;
      }
    }
  } catch (error) {
    console.error("❌ Bot Engine Error:", error);
  }
}

/* =========================================================
   ردیابی خودکار پوزیشن‌های باز (اعلام TP1 / TP2 / SL)
========================================================= */
async function checkActivePositions(env) {
  if (!env.SIGNAL_KV) return 0;
  let count = 0;

  for (const symbol of SYMBOLS) {
    const raw = await env.SIGNAL_KV.get(`POS_${symbol}`);
    if (!raw) continue;

    const pos = JSON.parse(raw);
    const klines = await fetchKlines(symbol, "5m", 2);
    if (!klines.length) {
      count++;
      continue;
    }

    const lastCandle = klines[klines.length - 1];
    const { high, low, close } = lastCandle;
    const isLong = pos.direction === "LONG";

    // بررسی برخورد با حد ضرر (SL)
    const slHit = isLong ? low <= pos.sl : high >= pos.sl;
    // بررسی برخورد با تارگت دوم (TP2 - خروج کامل)
    const tp2Hit = isLong ? high >= pos.tp2 : low <= pos.tp2;
    // بررسی برخورد با تارگت اول (TP1)
    const tp1Hit = isLong ? high >= pos.tp1 : low <= pos.tp1;

    if (slHit) {
      await sendTelegramText(env, `🛑 <b>بسته شدن پوزیشن #${symbol}</b>\nپوزیشن ${pos.direction} به حد ضرر (<code>${pos.sl}</code>) برخورد کرد و بسته شد.`);
      await env.SIGNAL_KV.delete(`POS_${symbol}`);
    } else if (tp2Hit) {
      await sendTelegramText(env, `🎯🔥 <b>فول تارگت #${symbol}!</b>\nپوزیشن ${pos.direction} به تارگت دوم (<code>${pos.tp2}</code>) رسید و کامل بسته شد.`);
      await env.SIGNAL_KV.delete(`POS_${symbol}`);
    } else if (tp1Hit && !pos.tp1Hit) {
      pos.tp1Hit = true;
      await sendTelegramText(env, `✅ <b>تارگت اول #${symbol} تاچ شد!</b>\nقیمت به <code>${pos.tp1}</code> رسید. سیو سود کنید و استاپ را به نقطه ورود (<code>${pos.entry}</code>) منتقل کنید (ریسک‌فری).`);
      await env.SIGNAL_KV.put(`POS_${symbol}`, JSON.stringify(pos), { expirationTtl: 1800 });
      count++;
    } else {
      count++;
    }
  }
  return count;
}

/* =========================================================
   دریافت اطلاعات قیمت، دامیننس‌ها و اخبار
========================================================= */
async function fetchKlines(symbol, interval, limit = 100) {
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return data.map(d => ({
    open: parseFloat(d[1]),
    high: parseFloat(d[2]),
    low: parseFloat(d[3]),
    close: parseFloat(d[4]),
    volume: parseFloat(d[5])
  }));
}

async function fetchMacroData() {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/global", {
      headers: { "Accept": "application/json", "User-Agent": "CF-Worker-Bot" }
    });
    if (!res.ok) throw new Error("CG Error");
    const { data } = await res.json();

    const btcD = data.market_cap_percentage.btc || 50;
    const usdtD = data.market_cap_percentage.usdt || 5;
    const total24h = data.market_cap_change_percentage_24h_usd || 0;

    let bias = "NEUTRAL";
    if (total24h > 0.6 && usdtD < 6.8) bias = "BULLISH";
    else if (total24h < -0.6) bias = "BEARISH";

    return { btcD: btcD.toFixed(2), usdtD: usdtD.toFixed(2), total24h: total24h.toFixed(2), bias };
  } catch {
    return { btcD: "N/A", usdtD: "N/A", total24h: "0.00", bias: "NEUTRAL" };
  }
}

async function fetchNewsSentiment(coin, apiKey) {
  if (!apiKey) return { bias: "NEUTRAL", label: "خنثی (بدون API)" };
  try {
    const res = await fetch(`https://cryptopanic.com/api/v1/posts/?auth_token=${apiKey}&currencies=${coin}&filter=important`);
    if (!res.ok) return { bias: "NEUTRAL", label: "خنثی" };
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
    return { bias: "NEUTRAL", label: "خنثی ⚪" };
  }
}

/* =========================================================
   محاسبات اندیکاتورهای اصلاح‌شده (VWAP, BB Squeeze, Supertrend)
========================================================= */
function analyzeIndicators(klines, stPeriod, stMult) {
  const closes = klines.map(k => k.close);
  const current = klines[klines.length - 1];

  const ema9 = calcEMA(closes, 9);
  const ema20 = calcEMA(closes, 20);
  const prevCloses = closes.slice(0, -1);
  const prevEma9 = calcEMA(prevCloses, 9);
  const prevEma20 = calcEMA(prevCloses, 20);

  const rsi = calcRSI(closes, 14);
  const atr = calcATR(klines, 14);
  const adx = calcADX(klines, 14);
  const vwap = calcVWAP(klines.slice(-48)); // VWAP چهار ساعت اخیر برای اسکلپ
  const bb = calcBollingerBands(closes, 20, 2);
  const supertrend = calcSupertrend(klines, stPeriod, stMult);

  const avgVol = klines.slice(-21, -1).reduce((s, k) => s + k.volume, 0) / 20;
  const volRatio = current.volume / (avgVol || 1);

  // تشخیص رنج: ADX زیر 20 یا فشردگی شدید باند بولینگر (Squeeze)
  const isRanging = adx < 20 || bb.bandwidth < 0.004;

  // تقاطع EMA 9 و EMA 20 هم‌جهت با سوپرترند
  const bullCross = prevEma9 <= prevEma20 && ema9 > ema20 && supertrend.direction === "LONG";
  const bearCross = prevEma9 >= prevEma20 && ema9 < ema20 && supertrend.direction === "SHORT";

  return {
    close: current.close,
    ema9,
    ema20,
    vwap,
    rsi,
    atr,
    adx,
    bb,
    supertrend,
    volRatio,
    isRanging,
    emaCrossInTrend: bullCross || bearCross
  };
}

function calcVWAP(klines) {
  let cumPV = 0, cumVol = 0;
  for (const k of klines) {
    const typicalPrice = (k.high + k.low + k.close) / 3;
    cumPV += typicalPrice * k.volume;
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
  const bandwidth = (upper - lower) / mean;
  return { upper, middle: mean, lower, bandwidth };
}

function calcSupertrend(klines, period = 7, multiplier = 2.0) {
  let trs = [0];
  for (let i = 1; i < klines.length; i++) {
    trs.push(Math.max(
      klines[i].high - klines[i].low,
      Math.abs(klines[i].high - klines[i - 1].close),
      Math.abs(klines[i].low - klines[i - 1].close)
    ));
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

function calcRSI(closes, period = 14) {
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - (100 / (1 + rs));
}

function calcATR(klines, period = 14) {
  let sum = 0;
  for (let i = klines.length - period; i < klines.length; i++) {
    sum += Math.max(
      klines[i].high - klines[i].low,
      Math.abs(klines[i].high - klines[i - 1].close),
      Math.abs(klines[i].low - klines[i - 1].close)
    );
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
   سیستم امتیازدهی ۱۰۰ امتیازی و تارگت‌گذاری ATR
========================================================= */
function evaluateSignalScore({ direction, tf5m, tf15m, macroData, news }) {
  let score = 0;
  let reasons = [];

  // ۱. هماهنگی سوپرترند ۵ دقیقه و ۱۵ دقیقه (۲۵ امتیاز)
  if (tf5m.supertrend.direction === tf15m.supertrend.direction) {
    score += 25;
    reasons.push("✅ هم‌جهتی کامل Supertrend در 5m و 15m");
  } else {
    score += 10;
  }

  // ۲. موقعیت قیمت نسبت به VWAP و EMA 9/20 (۲۰ امتیاز)
  const vwapOk = (direction === "LONG" && tf5m.close > tf5m.vwap && tf5m.ema9 > tf5m.ema20) ||
                 (direction === "SHORT" && tf5m.close < tf5m.vwap && tf5m.ema9 < tf5m.ema20);
  if (vwapOk) {
    score += 20;
    reasons.push("✅ تثبیت قیمت در سمت درست VWAP و EMA 9/20");
  } else {
    score += 8;
  }

  // ۳. قدرت روند ADX و خروج از فشردگی بولینگر (۱۵ امتیاز)
  if (tf5m.adx >= 25) {
    score += 15;
    reasons.push(`✅ قدرت روند عالی (ADX: ${tf5m.adx.toFixed(0)})`);
  } else {
    score += 9;
  }

  // ۴. تایید مومنتوم RSI در ناحیه استاندارد اسکلپ (۱۵ امتیاز)
  const rsiOk = (direction === "LONG" && tf5m.rsi >= 50 && tf5m.rsi <= 74) ||
                (direction === "SHORT" && tf5m.rsi <= 50 && tf5m.rsi >= 26);
  if (rsiOk) {
    score += 15;
    reasons.push(`✅ مومنتوم استاندارد RSI (${tf5m.rsi.toFixed(1)})`);
  } else {
    score += 6;
  }

  // ۵. حجم معاملات کندل ورود (۱۵ امتیاز)
  if (tf5m.volRatio >= 1.25) {
    score += 15;
    reasons.push(`✅ تایید حجم پول هوشمند (${tf5m.volRatio.toFixed(1)}x میانگین)`);
  } else {
    score += 7;
  }

  // ۶. دامیننس‌ها (USDT.D / TOTAL) و اخبار (۱۰ امتیاز)
  const macroAligned = (direction === "LONG" && macroData.bias === "BULLISH") ||
                       (direction === "SHORT" && macroData.bias === "BEARISH");
  if (macroAligned || news.bias === direction) {
    score += 10;
    reasons.push("✅ هم‌سویی با جریان نقدینگی کلان و سنتیمنت");
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
    sl: (price - m * (atr * 1.5)).toFixed(dec),  // استاپ استاندارد 1.5 برابر ATR
    tp1: (price + m * (atr * 1.5)).toFixed(dec), // تارگت اول (ریسک به ریوارد ۱:۱)
    tp2: (price + m * (atr * 2.5)).toFixed(dec)  // تارگت دوم اسکلپ
  };
}

async function sendSignalMessage(env, { symbol, direction, entry, targets, scoreData, tf5m, macroData }) {
  const dirLabel = direction === "LONG" ? "🟢 LONG (خرید)" : "🔴 SHORT (فروش)";
  const text = `
🚨 <b>سیگنال اسکلپ هوشمند | #${symbol}</b>
━━━━━━━━━━━━━━━━━━
🧭 <b>نوع پوزیشن:</b> ${dirLabel}
⭐ <b>امتیاز اعتبار:</b> <b>${scoreData.score}/100</b> (${scoreData.grade})
⏱ <b>تایم‌فریم:</b> ۵ دقیقه (تایید ساختار ۱۵ دقیقه)

🎯 <b>نقاط ورود و خروج:</b>
🔹 <b>ورود (Entry):</b> <code>${entry}</code>
✅ <b>تارگت اول (TP1):</b> <code>${targets.tp1}</code>
🚀 <b>تارگت دوم (TP2):</b> <code>${targets.tp2}</code>
🛑 <b>حد ضرر (SL):</b> <code>${targets.sl}</code>

📊 <b>داده‌های تکنیکال و دامیننس:</b>
• <b>VWAP:</b> <code>${tf5m.vwap.toFixed(2)}</code> | <b>ADX:</b> ${tf5m.adx.toFixed(1)}
• <b>BTC.D:</b> ${macroData.btcD}% | <b>USDT.D:</b> ${macroData.usdtD}%
• <b>تغییرات ۲۴ ساعته TOTAL:</b> ${macroData.total24h}%
• <b>وضعیت اخبار:</b> ${scoreData.newsLabel}

📋 <b>چک‌لیست تاییدیه:</b>
${scoreData.reasons.join("\n")}
`.trim();

  await sendTelegramText(env, text);
}

async function sendTelegramText(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML"
    })
  });
}