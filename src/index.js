/**
 * 🚀 Crypto Signal Bot v8.1 (Day-Trading Edition - 1H / 4H) — نسخه بهبود‌یافته
 * -----------------------------------------------------------------------
 * متغیرهای محیطی (Secrets / Vars):
 *   TELEGRAM_BOT_TOKEN   توکن بات (Secret)
 *   TELEGRAM_CHAT_ID     آیدی کانال/گروه سیگنال‌ها
 *   ADMIN_USER_IDS       آیدی عددی ادمین‌ها، جدا شده با کاما (برای /force /clear /reset و بستن دستی)
 *   WEBHOOK_SECRET       همان مقداری که در setWebhook به‌صورت secret_token می‌دهید
 *   ADMIN_KEY            کلید دسترسی به /diag و /test  (مثلاً /diag?key=...)
 *   CRYPTOPANIC_API_KEY  اختیاری
 *   SIGNAL_KV            KV Namespace Binding
 *
 * تغییرات مهم نسبت به v8.0:
 *   • امنیت: تأیید secret وبهوک، احراز هویت چت/ادمین، محافظت از /diag و /test، اعتبارسنجی ورودی دکمه‌ها
 *   • حذف نوشتن توکن در KV روی هر درخواست (سهمیه نوشتن KV را می‌سوزاند)
 *   • پاسخ فوری به وبهوک + پردازش در ctx.waitUntil (جلوگیری از Retry تلگرام)
 *   • Timeout روی همه fetchها + کش کوتاه‌مدت درون‌حافظه‌ای (کاهش subrequest و خطا)
 *   • ۲۵۰ کندل برای EMA200 واقعی، EMA با seed درست، Supertrend استاندارد (Wilder ATR)
 *   • PDH/PDL و VWAP بر اساس روز UTC واقعی (قبلاً ۲۴ کندل متحرک بود)
 *   • آمار دقیق‌تر: ثبت نتیجه نهایی هر معامله (با احتساب ۵۰٪ خروج در TP1)، ثبت Time-Stop و بستن دستی
 *   • رفع باگ‌ها: پیام اشتباه «Break-Even» بعد از TP2، شرط TOTAL2 در بازار نزولی، TTL پوزیشن، فیلد undefined در اسکن و ...
 */

const VERSION = "8.2";
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"];

const CONFIG = Object.freeze({
  MAX_OPEN_POSITIONS: 2,           // ارزها هم‌بسته‌اند؛ ۲ پوزیشن هم‌زمان کافی است
  MIN_SCORE: 70,                  // امتیازها دیگر «هدیه» نیستند؛ آستانه را با بک‌تست کالیبره کنید
  MAX_TRADE_DURATION_MIN: 1080,   // ۱۸ ساعت
  POSITION_TTL_SEC: 86400,        // بیشتر از مهلت معامله تا Time-Stop همیشه فرصت اجرا داشته باشد
  COOLDOWN_SEC: 7200,
  COOLDOWN_AFTER_SL_SEC: 21600,   // بعد از استاپ ۶ ساعت روی همان ارز سیگنال نده
  ADX_MIN: 20,                    // زیر این مقدار = بازار رنج
  MIN_ATR_PCT: 0.20,              // نوسان ۱H کمتر از ۰.۲٪ = تارگت‌ها به کارمزد می‌خورند
  MAX_STALE_ATR: 0.5,             // فاصله قیمت لحظه‌ای تا بسته‌شدن کندل ستاپ
  SL_ATR_MIN: 1.2,
  SL_ATR_MAX: 2.0,
  TP_R: [1.0, 2.0, 3.0],          // TP1 / TP2 / TP3 بر حسب R
  MONITOR_TICKS: 3,
  MONITOR_INTERVAL_MS: 15000,
  FETCH_TIMEOUT_MS: 8000,
  KLINE_LIMIT: 250,
  MIN_CANDLES_1H: 65,
  MIN_CANDLES_4H: 55,
  HISTORY_SIZE: 10,
  TP1_CLOSE_FRACTION: 0.5,        // سهم بسته‌شده در TP1
  BREAKEVEN_FEE_BUFFER: 0.12      // بافر کارمزد روی نقطه ریسک‌فری (نسبت به فاصله TP1)
});

const TTL = Object.freeze({
  klines: 20_000,
  prices: 5_000,
  macro: 60_000,
  global: 300_000,
  futures: 60_000,
  news: 300_000
});

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Accept": "application/json"
};

const DAY_MS = 86_400_000;

/* =========================================================
   ۰. ابزارهای کمکی
========================================================= */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sum = (arr) => arr.reduce((a, b) => a + b, 0);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const signed = (n, d = 2) => `${n >= 0 ? "+" : ""}${n.toFixed(d)}`;
const decimalsFor = (price) => (price >= 100 ? 2 : price >= 1 ? 3 : 5);
const pctMove = (entry, exit, isLong) => ((isLong ? exit - entry : entry - exit) / entry) * 100;
const parseIdList = (v) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const tree = (lines) => lines.map((l, i) => `${i === lines.length - 1 ? "└" : "├"} ${l}`).join("\n");
const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function formatDuration(min) {
  return min >= 60 ? `${Math.floor(min / 60)} ساعت و ${min % 60} دقیقه` : `${min} دقیقه`;
}

/* =========================================================
   ۱. شبکه و کش درون‌حافظه‌ای
========================================================= */
async function fetchWithTimeout(url, options = {}, timeoutMs = CONFIG.FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options = {}, timeoutMs) {
  try {
    const res = await fetchWithTimeout(url, { headers: BROWSER_HEADERS, ...options }, timeoutMs);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const memo = new Map();
const isEmptyValue = (v) =>
  v == null ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);

/** کش با TTL + جلوگیری از درخواست‌های هم‌زمان تکراری (نتیجه‌های خالی کش نمی‌شوند) */
function cached(key, ttlMs, loader) {
  const now = Date.now();
  const hit = memo.get(key);
  if (hit && hit.exp > now) return hit.promise;
  const promise = Promise.resolve()
    .then(loader)
    .then(
      (v) => { if (isEmptyValue(v)) memo.delete(key); return v; },
      (e) => { memo.delete(key); throw e; }
    );
  memo.set(key, { promise, exp: now + ttlMs });
  return promise;
}

/* =========================================================
   ۲. دریافت دیتای بازار (کندل‌ها، قیمت لحظه‌ای، فیوچرز، اخبار)
========================================================= */
const INTERVALS = { "1h": { okx: "1H", kucoin: "1hour" }, "4h": { okx: "4H", kucoin: "4hour" } };
const isGoodCandle = (c) => [c.time, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite);

async function candlesFromOKX(coin, interval) {
  const j = await fetchJson(`https://www.okx.com/api/v5/market/candles?instId=${coin}-USDT&bar=${INTERVALS[interval].okx}&limit=${CONFIG.KLINE_LIMIT}`);
  return j?.data?.map((d) => ({ time: Number(d[0]), open: +d[1], high: +d[2], low: +d[3], close: +d[4], volume: +d[5] }));
}

async function candlesFromGate(coin, interval) {
  const j = await fetchJson(`https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${coin}_USDT&interval=${interval}&limit=${CONFIG.KLINE_LIMIT}`);
  // [ts, quoteVol, close, high, low, open, baseVol]
  return Array.isArray(j) ? j.map((d) => ({ time: Number(d[0]) * 1000, open: +d[5], high: +d[3], low: +d[4], close: +d[2], volume: +d[6] })) : null;
}

async function candlesFromKuCoin(coin, interval) {
  const j = await fetchJson(`https://api.kucoin.com/api/v1/market/candles?type=${INTERVALS[interval].kucoin}&symbol=${coin}-USDT`);
  // [ts, open, close, high, low, volume, turnover]
  return j?.data?.map((d) => ({ time: Number(d[0]) * 1000, open: +d[1], close: +d[2], high: +d[3], low: +d[4], volume: +d[5] }));
}

async function loadKlines(symbol, interval) {
  const coin = symbol.replace("USDT", "");
  for (const source of [candlesFromOKX, candlesFromGate, candlesFromKuCoin]) {
    try {
      const raw = await source(coin, interval);
      const candles = (raw || []).filter(isGoodCandle).sort((a, b) => a.time - b.time);
      if (candles.length >= 50) return candles.slice(-CONFIG.KLINE_LIMIT);
    } catch { /* منبع بعدی */ }
  }
  return [];
}

async function fetchKlines(symbol, interval, limit = CONFIG.KLINE_LIMIT) {
  const all = await cached(`kl:${symbol}:${interval}`, TTL.klines, () => loadKlines(symbol, interval));
  return all.slice(-limit);
}

function fetchLivePrices() {
  return cached("prices", TTL.prices, async () => {
    const prices = {};
    const j = await fetchJson("https://www.okx.com/api/v5/market/tickers?instType=SPOT");
    for (const item of j?.data ?? []) {
      const sym = item.instId.replace("-", "");
      const p = Number(item.last);
      if (SYMBOLS.includes(sym) && p > 0) prices[sym] = p;
    }
    for (const sym of SYMBOLS) {
      if (!prices[sym]) {
        const kl = await fetchKlines(sym, "1h");
        if (kl.length) prices[sym] = kl[kl.length - 1].close;
      }
    }
    return prices;
  });
}

function fetchOKXFuturesData(coin) {
  return cached(`fut:${coin}`, TTL.futures, async () => {
    let fundingRate = 0, takerBuyRatio = 50, flowBias = "NEUTRAL";
    const [fund, taker] = await Promise.all([
      fetchJson(`https://www.okx.com/api/v5/public/funding-rate?instId=${coin}-USDT-SWAP`),
      fetchJson(`https://www.okx.com/api/v5/rubik/stat/taker-volume?ccy=${coin}&instType=CONTRACTS&period=1H`)
    ]);
    const fr = parseFloat(fund?.data?.[0]?.fundingRate);
    if (Number.isFinite(fr)) fundingRate = fr * 100;
    const latest = taker?.data?.[0];
    if (latest) {
      const sellVol = parseFloat(latest[1]) || 1, buyVol = parseFloat(latest[2]) || 1;
      takerBuyRatio = (buyVol / (buyVol + sellVol)) * 100;
    }
    if (takerBuyRatio >= 51.5 && fundingRate < 0.05) flowBias = "LONG";
    else if (takerBuyRatio <= 48.5 && fundingRate > -0.05) flowBias = "SHORT";
    return { fundingRate, fundingRateStr: `${signed(fundingRate, 4)}%`, takerBuyRatio: parseFloat(takerBuyRatio.toFixed(1)), flowBias };
  });
}

function fetchNewsSentiment(coin, apiKey) {
  const neutral = { bias: "NEUTRAL", label: "متعادل ⚪" };
  if (!apiKey) return Promise.resolve(neutral);
  return cached(`news:${coin}`, TTL.news, async () => {
    const data = await fetchJson(`https://cryptopanic.com/api/v1/posts/?auth_token=${encodeURIComponent(apiKey)}&currencies=${coin}&filter=important`);
    let pos = 0, neg = 0;
    for (const p of (data?.results || []).slice(0, 6)) {
      pos += (p.votes?.positive || 0) + (p.votes?.liked || 0);
      neg += (p.votes?.negative || 0) + (p.votes?.disliked || 0);
    }
    if (pos > neg * 1.25) return { bias: "LONG", label: "مثبت (Bullish) 🟢" };
    if (neg > pos * 1.25) return { bias: "SHORT", label: "منفی (Bearish) 🔴" };
    return neutral;
  });
}

let lastGlobal = { btcD: 55.0, usdtD: 5.0 };
function fetchGlobalMarket() {
  return cached("global", TTL.global, async () => {
    const j = await fetchJson("https://api.coingecko.com/api/v3/global");
    const pct = j?.data?.market_cap_percentage;
    if (pct?.btc) lastGlobal = { btcD: pct.btc, usdtD: pct.usdt ?? lastGlobal.usdtD };
    return lastGlobal; // در صورت خطا آخرین مقدار معتبر
  });
}

/* =========================================================
   ۳. اندیکاتورها
========================================================= */
const trueRange = (k, prev) =>
  Math.max(k.high - k.low, Math.abs(k.high - prev.close), Math.abs(k.low - prev.close));

/** EMA با seed میانگین ساده (برای اندیس‌های قبل از period میانگین تجمعی) */
function calcEMASeries(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length);
  let acc = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < period) { acc += values[i]; out[i] = acc / (i + 1); }
    else out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}
const calcEMA = (values, period) => calcEMASeries(values, period).at(-1);

function calcMACD(closes, fast = 12, slow = 26, sig = 9) {
  const eFast = calcEMASeries(closes, fast);
  const eSlow = calcEMASeries(closes, slow);
  const macdLine = eFast.map((v, i) => v - eSlow[i]);
  const sigLine = calcEMASeries(macdLine, sig);
  const n = closes.length;
  return {
    macd: macdLine[n - 1],
    signal: sigLine[n - 1],
    histogram: macdLine[n - 1] - sigLine[n - 1],
    prevHistogram: macdLine[n - 2] - sigLine[n - 2]
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
  rsiArr[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    rsiArr[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsiArr;
}

function calcATR(klines, period = 14) {
  let s = 0, n = 0;
  for (let i = Math.max(1, klines.length - period); i < klines.length; i++) {
    s += trueRange(klines[i], klines[i - 1]);
    n++;
  }
  return n ? s / n : 0;
}

function calcWilderADX(klines, period = 14) {
  if (klines.length < period * 2 + 1) return 20;
  const tr = [], pdm = [], mdm = [];
  for (let i = 1; i < klines.length; i++) {
    const up = klines[i].high - klines[i - 1].high;
    const down = klines[i - 1].low - klines[i].low;
    pdm.push(up > down && up > 0 ? up : 0);
    mdm.push(down > up && down > 0 ? down : 0);
    tr.push(trueRange(klines[i], klines[i - 1]));
  }
  let sTR = sum(tr.slice(0, period)), sPDM = sum(pdm.slice(0, period)), sMDM = sum(mdm.slice(0, period));
  const dx = [];
  const pushDx = () => {
    const pDI = sTR === 0 ? 0 : (sPDM / sTR) * 100;
    const mDI = sTR === 0 ? 0 : (sMDM / sTR) * 100;
    const total = pDI + mDI;
    dx.push(total === 0 ? 0 : (Math.abs(pDI - mDI) / total) * 100);
  };
  pushDx();
  for (let i = period; i < tr.length; i++) {
    sTR = sTR - sTR / period + tr[i];
    sPDM = sPDM - sPDM / period + pdm[i];
    sMDM = sMDM - sMDM / period + mdm[i];
    pushDx();
  }
  if (dx.length < period) return dx.at(-1) ?? 20;
  let adx = sum(dx.slice(0, period)) / period;
  for (let i = period; i < dx.length; i++) adx = (adx * (period - 1) + dx[i]) / period;
  return adx;
}

/** Supertrend استاندارد (معادل Pine Script با ATR به روش Wilder) */
function calcSupertrend(klines, period = 10, multiplier = 3.0) {
  const n = klines.length;
  if (n < period + 2) return { direction: "LONG", justFlipped: false };
  const tr = [klines[0].high - klines[0].low];
  for (let i = 1; i < n; i++) tr.push(trueRange(klines[i], klines[i - 1]));
  let atr = sum(tr.slice(1, period + 1)) / period;
  let trend = 1, prevTrend = 1, lower = 0, upper = 0;
  for (let i = period; i < n; i++) {
    if (i > period) atr = (atr * (period - 1) + tr[i]) / period;
    const hl2 = (klines[i].high + klines[i].low) / 2;
    let lb = hl2 - multiplier * atr, ub = hl2 + multiplier * atr;
    if (i === period) { lower = lb; upper = ub; }
    const prevLower = lower, prevUpper = upper, prevClose = klines[i - 1].close;
    lb = prevClose > prevLower ? Math.max(lb, prevLower) : lb;
    ub = prevClose < prevUpper ? Math.min(ub, prevUpper) : ub;
    prevTrend = trend;
    if (trend === -1 && klines[i].close > prevUpper) trend = 1;
    else if (trend === 1 && klines[i].close < prevLower) trend = -1;
    lower = lb; upper = ub;
  }
  return { direction: trend === 1 ? "LONG" : "SHORT", justFlipped: trend !== prevTrend };
}

function calcVWAP(klines) {
  let pv = 0, vol = 0;
  for (const k of klines) {
    pv += ((k.high + k.low + k.close) / 3) * k.volume;
    vol += k.volume;
  }
  return vol === 0 ? klines[klines.length - 1].close : pv / vol;
}

/** سقف/کف روز قبل (UTC) و VWAP سشن جاری؛ در صورت کمبود دیتا به پنجره متحرک برمی‌گردد */
function sessionLevels(closed) {
  const last = closed[closed.length - 1];
  const dayStart = Math.floor(last.time / DAY_MS) * DAY_MS;
  const prevDay = closed.filter((k) => k.time >= dayStart - DAY_MS && k.time < dayStart);
  const today = closed.filter((k) => k.time >= dayStart);
  const prevSlice = prevDay.length >= 3 && closed.length > 30 && prevDay.length >= Math.min(12, closed.length / 2)
    ? prevDay : closed.slice(-26, -2);
  const vwapSlice = today.length >= 3 ? today : closed.slice(-24);
  return {
    pdh: Math.max(...prevSlice.map((k) => k.high)),
    pdl: Math.min(...prevSlice.map((k) => k.low)),
    vwap: calcVWAP(vwapSlice)
  };
}

function detectOrderBlocks(klines, atr, lookback = 40) {
  const len = klines.length, current = klines[len - 1], start = Math.max(2, len - lookback);
  let bullOB = null, bearOB = null;
  for (let i = start; i < len - 3; i++) {
    const c = klines[i], n1 = klines[i + 1], n2 = klines[i + 2];
    if (c.close < c.open && ((n1.close - c.open) > atr * 1.2 || ((n2.close - c.open) > atr * 1.5 && n1.close > c.high))) {
      let inv = false;
      for (let j = i + 3; j < len - 1; j++) if (klines[j].close < c.low) { inv = true; break; }
      if (!inv) bullOB = { bottom: c.low, top: Math.max(c.open, c.high) };
    }
    if (c.close > c.open && ((c.open - n1.close) > atr * 1.2 || ((c.open - n2.close) > atr * 1.5 && n1.close < c.low))) {
      let inv = false;
      for (let j = i + 3; j < len - 1; j++) if (klines[j].close > c.high) { inv = true; break; }
      if (!inv) bearOB = { bottom: Math.min(c.open, c.low), top: c.high };
    }
  }
  const buf = atr * 0.35;
  return {
    bullOB, bearOB,
    inBullishOB: Boolean(bullOB && current.low <= bullOB.top + buf && current.close >= bullOB.bottom),
    inBearishOB: Boolean(bearOB && current.high >= bearOB.bottom - buf && current.close <= bearOB.top)
  };
}

function detectRSIDivergence(klines, rsiSeries, lookback = 30) {
  const len = klines.length, start = Math.max(5, len - lookback);
  const lows = [], highs = [];
  for (let i = start; i < len - 1; i++) {
    const k = klines[i];
    if (k.low <= klines[i - 1].low && k.low <= klines[i - 2].low && k.low <= klines[i + 1].low) lows.push({ index: i, price: k.low, rsi: rsiSeries[i] });
    if (k.high >= klines[i - 1].high && k.high >= klines[i - 2].high && k.high >= klines[i + 1].high) highs.push({ index: i, price: k.high, rsi: rsiSeries[i] });
  }
  let bullish = false, bearish = false, bullType = "", bearType = "";
  if (lows.length >= 2) {
    const l = lows.at(-1), p = lows.at(-2), fresh = len - 1 - l.index <= 6;
    if (fresh && l.price < p.price && l.rsi > p.rsi + 1.5 && l.rsi < 48) { bullish = true; bullType = "واگرایی مثبت (+RD)"; }
    else if (fresh && l.price > p.price && l.rsi < p.rsi - 1.5 && l.rsi < 55) { bullish = true; bullType = "واگرایی مخفی مثبت (+HD)"; }
  }
  if (highs.length >= 2) {
    const l = highs.at(-1), p = highs.at(-2), fresh = len - 1 - l.index <= 6;
    if (fresh && l.price > p.price && l.rsi < p.rsi - 1.5 && l.rsi > 52) { bearish = true; bearType = "واگرایی منفی (-RD)"; }
    else if (fresh && l.price < p.price && l.rsi > p.rsi + 1.5 && l.rsi > 45) { bearish = true; bearType = "واگرایی مخفی منفی (-HD)"; }
  }
  return { bullish, bearish, bullType, bearType };
}

/* =========================================================
   ۴. قطب‌نمای کلان (USDT.D / BTC.D snapshot + پروکسی TOTAL2)
   توجه: TOTAL2 یک پروکسی از سبد ETH/SOL/BNB است و جهت USDT.D استنباطی است.
========================================================= */
const neutralMacro = (extra = {}) => ({
  btcD: "55.00", usdtD: "5.00", total2SharePct: "40.0",
  usdtTrend: "NEUTRAL", total2Trend: "NEUTRAL",
  total2Change4h: "0.00", btc4hChg: "0.00",
  btcTrend1h: "NEUTRAL", btcTrend4h: "NEUTRAL",
  macroSummary: "متعادل ⚪", ...extra
});

const analyzeDailyMacro = () => cached("macro", TTL.macro, computeMacro);

async function computeMacro() {
  try {
    const [btc1h, btc4h, eth1h, sol1h, bnb1h, global] = await Promise.all([
      fetchKlines("BTCUSDT", "1h"), fetchKlines("BTCUSDT", "4h"),
      fetchKlines("ETHUSDT", "1h"), fetchKlines("SOLUSDT", "1h"), fetchKlines("BNBUSDT", "1h"),
      fetchGlobalMarket()
    ]);
    const { btcD, usdtD } = global;
    const base = { btcD: btcD.toFixed(2), usdtD: usdtD.toFixed(2), total2SharePct: Math.max(10, 100 - btcD - usdtD).toFixed(1) };

    if (btc1h.length < 50 || eth1h.length < 50 || btc4h.length < 30) return neutralMacro(base);

    const change4h = (kl) => (kl.length >= 6 ? pctMove(kl.at(-5).close, kl.at(-1).close, true) : null);
    const btc4hChg = change4h(btc1h);
    const eth4hChg = change4h(eth1h);
    const sol4hChg = change4h(sol1h) ?? eth4hChg;
    const bnb4hChg = change4h(bnb1h) ?? eth4hChg;
    const total2Change4h = eth4hChg * 0.50 + sol4hChg * 0.25 + bnb4hChg * 0.25;

    const closes1h = btc1h.slice(0, -1).map((k) => k.close);
    const closes4h = btc4h.slice(0, -1).map((k) => k.close);
    const e21_1h = calcEMA(closes1h, 21), e50_1h = calcEMA(closes1h, 50), e21_4h = calcEMA(closes4h, 21);
    const lastBtc = closes1h.at(-1);
    const btcTrend1h = lastBtc >= e21_1h && e21_1h >= e50_1h ? "LONG" : lastBtc <= e21_1h && e21_1h <= e50_1h ? "SHORT" : "NEUTRAL";
    const btcTrend4h = lastBtc >= e21_4h ? "LONG" : "SHORT";

    let usdtTrend = "NEUTRAL", total2Trend = "NEUTRAL", macroSummary = "فاز خنثی / تراکم ⚪";
    if (total2Change4h > 0.35 && btc4hChg > 0.15) {
      usdtTrend = "FALLING"; total2Trend = "BULLISH";
      macroSummary = "ورود پول به بازار (USDT.D 📉 | TOTAL2 📈) 🟢";
    } else if (total2Change4h < -0.35 && btc4hChg < -0.15) {
      usdtTrend = "RISING"; total2Trend = "BEARISH";
      macroSummary = "خروج پول به سمت تتر (USDT.D 📈 | TOTAL2 📉) 🔴";
    } else if (total2Change4h > 0.20 && total2Change4h > btc4hChg + 0.30) {
      // فقط وقتی TOTAL2 واقعاً مثبت است (قبلاً «افت کمتر» هم صعودی حساب می‌شد)
      total2Trend = "BULLISH";
      macroSummary = "قدرت برتر آلت‌کوین‌ها (TOTAL2 Outperforming) 🔥";
    }

    return {
      ...base, usdtTrend, total2Trend,
      total2Change4h: signed(total2Change4h), btc4hChg: signed(btc4hChg),
      btcTrend1h, btcTrend4h, macroSummary
    };
  } catch (e) {
    console.error("Macro Error:", e);
    return neutralMacro();
  }
}

/* =========================================================
   ۵. تحلیل چارت، امتیازدهی و تارگت‌ها
========================================================= */
/** تحلیل سبک برای تایم ۴ ساعته: تشخیص روند (Supertrend + EMA50) */
function analyzeTrend(klines) {
  const closed = klines.slice(0, -1);
  const closes = closed.map((k) => k.close);
  const close = klines.at(-1).close;
  const ema21 = calcEMA(closes, 21), ema50 = calcEMA(closes, 50), ema200 = calcEMA(closes, 200);
  const supertrend = calcSupertrend(closed, 10, 3.0);
  const trend =
    supertrend.direction === "LONG" && close > ema50 ? "LONG" :
    supertrend.direction === "SHORT" && close < ema50 ? "SHORT" : null;
  return { close, ema21, ema50, ema200, supertrend, trend };
}

/**
 * تحلیل ۱ ساعته. bias = روند ۴ ساعته؛ فقط ستاپ‌های هم‌جهت با آن بررسی می‌شوند
 * (معاملات خلاف روند اصلی حذف شده‌اند).
 */
function analyzeDayTradingChart(klines, bias = null) {
  const closedKlines = klines.slice(0, -1);
  const closes = closedKlines.map((k) => k.close);
  const liveCandle = klines.at(-1);
  const c0 = closedKlines.at(-1), c1 = closedKlines.at(-2);

  const ema21 = calcEMA(closes, 21), ema50 = calcEMA(closes, 50), ema200 = calcEMA(closes, 200);
  const supertrend = calcSupertrend(closedKlines, 10, 3.0);
  const macd = calcMACD(closes, 12, 26, 9);
  const rsiSeries = calcRSISeries(closes, 14);
  const rsi = rsiSeries.at(-1), prevRsi = rsiSeries.at(-2);
  const atr = calcATR(closedKlines, 14);
  const adx = calcWilderADX(closedKlines, 14);
  const { pdh, pdl, vwap } = sessionLevels(closedKlines);

  const recent10 = closedKlines.slice(-10);
  const swingLow = Math.min(...recent10.map((k) => k.low));
  const swingHigh = Math.max(...recent10.map((k) => k.high));

  const orderBlock = detectOrderBlocks(closedKlines, atr, 40);
  const divergence = detectRSIDivergence(closedKlines, rsiSeries, 30);

  const avgVol = sum(closedKlines.slice(-21, -1).map((k) => k.volume)) / 20;
  const volRatio = Math.max(c0.volume, liveCandle.volume) / (avgVol || 1);
  const isBull = c0.close > c0.open, isBear = c0.close < c0.open;
  const bodyRatio = Math.abs(c0.close - c0.open) / (c0.high - c0.low || 1e-9);
  const adxOk = adx >= CONFIG.ADX_MIN;

  const setups = {
    LONG: [
      {
        type: "🎯 پولبک به EMA21 / VWAP / OB در روند صعودی ۴H",
        ok: ema21 > ema50 &&
          (c0.low <= ema21 + atr * 0.25 || c0.low <= vwap + atr * 0.20 || orderBlock.inBullishOB) &&
          c0.close > ema21 && isBull && bodyRatio >= 0.4 &&
          rsi >= 40 && rsi <= 62 && macd.histogram >= macd.prevHistogram
      },
      {
        type: divergence.bullish ? `📐 ${divergence.bullType} + Sweep کف روز قبل` : "🏛️ Sweep کف روز قبل و بازگشت (PDL Reclaim)",
        ok: c0.low <= pdl + atr * 0.20 && c0.close > pdl && isBull && bodyRatio >= 0.4 && rsi > prevRsi
      },
      {
        type: "🚀 شکست تاییدشده سقف روز قبل با حجم (PDH Breakout)",
        ok: c1.close <= pdh && c0.close > pdh && volRatio >= 1.3 && adxOk && bodyRatio >= 0.5
      },
      {
        type: "🌊 شروع موج صعودی ۱H هم‌جهت با ۴H",
        ok: (supertrend.justFlipped && supertrend.direction === "LONG" && adxOk) ||
          (supertrend.direction === "LONG" && macd.histogram > 0 && macd.prevHistogram <= 0 && c0.close > ema21 && adx >= 22)
      }
    ],
    SHORT: [
      {
        type: "🎯 پولبک نزولی به EMA21 / VWAP / OB در روند نزولی ۴H",
        ok: ema21 < ema50 &&
          (c0.high >= ema21 - atr * 0.25 || c0.high >= vwap - atr * 0.20 || orderBlock.inBearishOB) &&
          c0.close < ema21 && isBear && bodyRatio >= 0.4 &&
          rsi >= 38 && rsi <= 60 && macd.histogram <= macd.prevHistogram
      },
      {
        type: divergence.bearish ? `📐 ${divergence.bearType} + Sweep سقف روز قبل` : "🏛️ Sweep سقف روز قبل و ریجکت (PDH Reject)",
        ok: c0.high >= pdh - atr * 0.20 && c0.close < pdh && isBear && bodyRatio >= 0.4 && rsi < prevRsi
      },
      {
        type: "🔻 شکست تاییدشده کف روز قبل با حجم (PDL Breakdown)",
        ok: c1.close >= pdl && c0.close < pdl && volRatio >= 1.3 && adxOk && bodyRatio >= 0.5
      },
      {
        type: "🌊 شروع موج نزولی ۱H هم‌جهت با ۴H",
        ok: (supertrend.justFlipped && supertrend.direction === "SHORT" && adxOk) ||
          (supertrend.direction === "SHORT" && macd.histogram < 0 && macd.prevHistogram >= 0 && c0.close < ema21 && adx >= 22)
      }
    ]
  };

  const found = bias ? setups[bias].find((x) => x.ok) : null;
  const hasDaySetup = Boolean(found);
  const setupDirection = bias ?? supertrend.direction;
  const setupType = found
    ? found.type
    : bias ? "در انتظار ستاپ ۱ ساعته هم‌جهت با روند ۴H" : "روند ۴ ساعته نامشخص (بدون معامله)";

  const distFromEma21Atr = Math.abs(liveCandle.close - ema21) / (atr || 1);
  const atrPct = (atr / liveCandle.close) * 100;
  const isChop = !adxOk;
  const isLowVol = atrPct < CONFIG.MIN_ATR_PCT;
  const isStale = Math.abs(liveCandle.close - c0.close) > atr * CONFIG.MAX_STALE_ATR;
  const isOverextended =
    distFromEma21Atr > 1.5 ||
    (setupDirection === "LONG" && rsi > 66) ||
    (setupDirection === "SHORT" && rsi < 34);

  return {
    close: liveCandle.close,
    ema21, ema50, ema200, vwap, pdh, pdl, swingLow, swingHigh,
    rsi, macd, atr, atrPct, adx, supertrend, orderBlock, divergence,
    volRatio, bodyRatio, isChop, isLowVol, isStale, distFromEma21Atr, isOverextended,
    hasDaySetup, setupType, setupDirection, trendBias: bias
  };
}

function evaluateDayTradeScore({ symbol, direction, tf1h, tf4h, macro, futuresData, news }) {
  const isLong = direction === "LONG";
  let score = 0;
  const reasons = [];
  const add = (pts, reason) => { score += pts; if (reason) reasons.push(reason); };

  // ۱. هم‌جهتی روند (۲۵) — فقط در صورت تأیید واقعی امتیاز می‌گیرد
  if (tf4h.trend === direction) add(15, "• روند ۴ ساعته (Supertrend + EMA50) هم‌جهت است ✅");
  const stackFull = isLong
    ? tf1h.ema21 > tf1h.ema50 && tf1h.ema50 > tf1h.ema200
    : tf1h.ema21 < tf1h.ema50 && tf1h.ema50 < tf1h.ema200;
  const stackHalf = isLong ? tf1h.ema21 > tf1h.ema50 : tf1h.ema21 < tf1h.ema50;
  if (stackFull) add(10, "• چینش کامل EMA 21/50/200 در ۱ ساعته 📚");
  else if (stackHalf) add(5);

  // ۲. کیفیت ستاپ (۲۰)
  if (tf1h.hasDaySetup) {
    add(12, `• ${tf1h.setupType}`);
    if (tf1h.volRatio >= 1.2) add(4, `• حجم بالاتر از میانگین (${tf1h.volRatio.toFixed(1)}x) 📈`);
    if (isLong ? tf1h.divergence.bullish : tf1h.divergence.bearish) add(4, "• هم‌پوشانی با واگرایی RSI 📐");
  }

  // ۳. قطب‌نمای کلان (۲۰)
  const macroBull = macro.total2Trend === "BULLISH" || macro.btcTrend1h === "LONG";
  const macroBear = macro.total2Trend === "BEARISH" || macro.btcTrend1h === "SHORT";
  const macroConflict =
    symbol !== "BTCUSDT" &&
    ((isLong && macro.total2Trend === "BEARISH" && macro.btcTrend1h === "SHORT") ||
     (!isLong && macro.total2Trend === "BULLISH" && macro.btcTrend1h === "LONG"));
  const macroAligned = isLong ? macroBull && !macroBear : macroBear && !macroBull;
  const macroAgainst = isLong ? macroBear && !macroBull : macroBull && !macroBear;
  if (macroAligned) add(20, `• تایید قطب‌نمای کلان (TOTAL2: ${macro.total2Change4h}% | USDT.D: ${macro.usdtD}%) 🌐`);
  else if (!macroAgainst) add(8);

  // ۴. موقعیت قیمت (۱۵)
  const vwapSide = isLong ? tf1h.close >= tf1h.vwap : tf1h.close <= tf1h.vwap;
  const inOB = isLong ? tf1h.orderBlock.inBullishOB : tf1h.orderBlock.inBearishOB;
  if (vwapSide) add(8, "• قیمت در سمت درست VWAP سشن 🏛️");
  if (inOB) add(7, "• واکنش از ناحیه Order Block 🧱");

  // ۵. جریان سفارشات و قدرت روند (۱۰)
  if (futuresData.flowBias === direction) add(5, `• جریان فیوچرز هم‌جهت (Taker Buy: ${futuresData.takerBuyRatio}%) 📊`);
  if (tf1h.adx >= 25) add(5, `• روند قوی (ADX: ${tf1h.adx.toFixed(0)}) 💪`);
  else if (tf1h.adx >= CONFIG.ADX_MIN) add(3);

  // ۶. اخبار (۱۰)
  if (news.bias === direction) add(10, `• حمایت سنتیمنت اخبار (${news.label}) 📰`);
  else if (news.bias === "NEUTRAL") add(5);

  if (tf1h.isChop) score -= 10;
  if (tf1h.isOverextended) score -= 15;

  let grade = "در انتظار تایید ⏳";
  if (score >= 85) grade = "Day-Trade VIP A+ 💎";
  else if (score >= CONFIG.MIN_SCORE) grade = "Day-Trade Grade A 🔥";

  return { score: clamp(score, 0, 100), grade, reasons, macroConflict };
}

function calculateDayTradeTargets(tf1h, direction) {
  const price = tf1h.close, atr = tf1h.atr;
  const dec = decimalsFor(price);
  const isLong = direction === "LONG";
  const m = isLong ? 1 : -1;
  const round = (v) => Number(v.toFixed(dec));

  const ob = isLong ? tf1h.orderBlock.bullOB : tf1h.orderBlock.bearOB;
  const structuralSL = isLong
    ? Math.min(tf1h.swingLow, ob ? ob.bottom : tf1h.swingLow) - atr * 0.40
    : Math.max(tf1h.swingHigh, ob ? ob.top : tf1h.swingHigh) + atr * 0.40;
  const riskDist = clamp(Math.abs(price - structuralSL), atr * CONFIG.SL_ATR_MIN, atr * CONFIG.SL_ATR_MAX);

  const sl = round(price - m * riskDist);
  const tp1 = round(price + m * riskDist * CONFIG.TP_R[0]);
  const tp2 = round(price + m * riskDist * CONFIG.TP_R[1]);
  const tp3 = round(price + m * riskDist * CONFIG.TP_R[2]);

  const zoneEdge = price - m * atr * 0.25;
  const entryZone = `${Math.min(zoneEdge, price).toFixed(dec)} ~ ${Math.max(zoneEdge, price).toFixed(dec)}`;
  const pct = (level) => ((Math.abs(level - price) / price) * 100).toFixed(2);
  const slPct = pct(sl);

  const rawLev = Math.round(4.5 / Math.max(0.5, parseFloat(slPct)));
  const leverage = clamp(rawLev, 3, 8);
  const slWithLev = parseFloat(slPct) * leverage;
  const marginPct = clamp(Math.round((1.5 / Math.max(1, slWithLev)) * 100), 5, 20);

  return { dec, sl, tp1, tp2, tp3, slPct, tp1Pct: pct(tp1), tp2Pct: pct(tp2), tp3Pct: pct(tp3), entryZone, leverage, marginPct };
}

async function analyzeSymbol(env, symbol, macro) {
  const coin = symbol.replace("USDT", "");
  const [k1h, k4h, futuresData, news] = await Promise.all([
    fetchKlines(symbol, "1h"),
    fetchKlines(symbol, "4h"),
    fetchOKXFuturesData(coin),
    fetchNewsSentiment(coin, env.CRYPTOPANIC_API_KEY)
  ]);
  if (k1h.length < CONFIG.MIN_CANDLES_1H || k4h.length < CONFIG.MIN_CANDLES_4H) return { symbol, error: true };

  const tf4h = analyzeTrend(k4h);
  const tf1h = analyzeDayTradingChart(k1h, tf4h.trend);
  const direction = tf1h.setupDirection;
  const scoreData = evaluateDayTradeScore({ symbol, direction, tf1h, tf4h, macro, futuresData, news });
  return { symbol, direction, entry: tf1h.close, tf1h, tf4h, macro, futuresData, news, scoreData };
}

const isSignalWorthy = (c, minScore = CONFIG.MIN_SCORE) =>
  c.tf1h.hasDaySetup && c.tf4h.trend === c.direction &&
  !c.tf1h.isChop && !c.tf1h.isLowVol && !c.tf1h.isStale && !c.tf1h.isOverextended &&
  !c.scoreData.macroConflict && c.scoreData.score >= minScore;

/* =========================================================
   ۶. مدیریت پوزیشن (ذخیره‌سازی، ارزیابی، نهایی‌سازی)
========================================================= */
const RESULT_LABELS = {
  SL: "SL 🛑", BE: "BE 🛡️", LOCK: "TP1-Lock 🔒", TP3: "TP3 🚀", TIME: "Time ⏳", MANUAL: "Manual ✋"
};

async function kvGetJson(env, key, fallback) {
  if (!env.SIGNAL_KV) return fallback;
  try { return (await env.SIGNAL_KV.get(key, "json")) ?? fallback; } catch { return fallback; }
}

async function getNextSignalId(env) {
  if (!env.SIGNAL_KV) return Math.floor(1000 + Math.random() * 9000);
  const current = parseInt((await env.SIGNAL_KV.get("LAST_SIGNAL_ID")) || "1000", 10);
  const next = (Number.isFinite(current) ? current : 1000) + 1;
  await env.SIGNAL_KV.put("LAST_SIGNAL_ID", String(next));
  return next;
}

/** سازگاری با پوزیشن‌های ذخیره‌شده در نسخه ۸.۰ */
function normalizePosition(pos) {
  const p = { ...pos };
  p.dec = p.dec ?? decimalsFor(p.entry);
  p.initialSl = p.initialSl ?? p.sl;
  p.leverage = p.leverage || 5;
  if (p.remaining == null) p.remaining = p.tp1Hit ? 1 - CONFIG.TP1_CLOSE_FRACTION : 1;
  if (p.realizedPct == null) {
    p.realizedPct = p.tp1Hit ? CONFIG.TP1_CLOSE_FRACTION * pctMove(p.entry, p.tp1, p.direction === "LONG") : 0;
  }
  return p;
}

function createPosition({ signalId, messageId, chatId, symbol, direction, entry, targets }) {
  return {
    signalId, messageId, chatId, symbol, direction, entry,
    dec: targets.dec, tp1: targets.tp1, tp2: targets.tp2, tp3: targets.tp3,
    sl: targets.sl, initialSl: targets.sl, leverage: targets.leverage,
    tp1Hit: false, tp2Hit: false, remaining: 1, realizedPct: 0, openedAt: Date.now()
  };
}

async function loadPosition(env, symbol) {
  const raw = await kvGetJson(env, `POS_${symbol}`, null);
  return raw ? normalizePosition(raw) : null;
}

async function loadPositions(env) {
  if (!env.SIGNAL_KV) return [];
  return (await Promise.all(SYMBOLS.map((s) => loadPosition(env, s)))).filter(Boolean);
}

const savePosition = (env, pos) =>
  env.SIGNAL_KV.put(`POS_${pos.symbol}`, JSON.stringify(pos), { expirationTtl: CONFIG.POSITION_TTL_SEC });

const computeFinalPct = (pos, exitPrice) =>
  pos.realizedPct + pos.remaining * pctMove(pos.entry, exitPrice, pos.direction === "LONG");

function applyTp1Partial(p) {
  p.tp1Hit = true;
  p.remaining = 1 - CONFIG.TP1_CLOSE_FRACTION;
  p.realizedPct = CONFIG.TP1_CLOSE_FRACTION * pctMove(p.entry, p.tp1, p.direction === "LONG");
}

/** تابع خالص: بررسی یک پوزیشن با قیمت جاری. در هر نوبت حداکثر یک رویداد برمی‌گرداند. */
function evaluatePosition(pos, price, now = Date.now()) {
  const isLong = pos.direction === "LONG";
  const reached = (level) => (isLong ? price >= level : price <= level);
  const stopped = isLong ? price <= pos.sl : price >= pos.sl;
  const elapsedMin = Math.max(1, Math.round((now - (pos.openedAt || now)) / 60000));
  const next = { ...pos };

  if (stopped) {
    const action = pos.tp2Hit ? "LOCK" : pos.tp1Hit ? "BE" : "SL";
    return { action, closed: true, exitPrice: pos.sl, pos: next, elapsedMin };
  }
  if (reached(pos.tp3)) return { action: "TP3", closed: true, exitPrice: pos.tp3, pos: next, elapsedMin };

  if (reached(pos.tp2) && !pos.tp2Hit) {
    if (!next.tp1Hit) applyTp1Partial(next);
    next.tp2Hit = true;
    next.sl = pos.tp1;
    return { action: "TP2", closed: false, pos: next, elapsedMin };
  }
  if (reached(pos.tp1) && !pos.tp1Hit) {
    applyTp1Partial(next);
    next.sl = Number((pos.entry + (pos.tp1 - pos.entry) * CONFIG.BREAKEVEN_FEE_BUFFER).toFixed(pos.dec));
    return { action: "TP1", closed: false, pos: next, elapsedMin };
  }
  if (elapsedMin >= CONFIG.MAX_TRADE_DURATION_MIN) return { action: "TIME", closed: true, exitPrice: price, pos: next, elapsedMin };
  return null;
}

async function recordTradeStat(env, { signalId, symbol, direction, result, pct }) {
  if (!env.SIGNAL_KV) return;
  const [stats, history] = await Promise.all([
    kvGetJson(env, "BOT_STATS", { wins: 0, losses: 0, netPct: 0 }),
    kvGetJson(env, "SIGNAL_HISTORY", [])
  ]);
  if (pct >= 0) stats.wins += 1; else stats.losses += 1;
  stats.netPct += pct;
  history.unshift({ signalId: signalId || 1000, symbol, direction, result, pct, closedAt: Date.now() });
  await Promise.all([
    env.SIGNAL_KV.put("BOT_STATS", JSON.stringify(stats)),
    env.SIGNAL_KV.put("SIGNAL_HISTORY", JSON.stringify(history.slice(0, CONFIG.HISTORY_SIZE)))
  ]);
}

/** بستن معامله: حذف پوزیشن (اول) و ثبت آمار با نتیجه نهایی وزنی */
async function finalizeTrade(env, pos, action, exitPrice) {
  const finalPct = computeFinalPct(pos, exitPrice);
  await env.SIGNAL_KV.delete(`POS_${pos.symbol}`);
  try {
    await recordTradeStat(env, {
      signalId: pos.signalId, symbol: pos.symbol, direction: pos.direction,
      result: RESULT_LABELS[action] || action, pct: finalPct
    });
    if (action === "SL") {
      await env.SIGNAL_KV.put(`COOLDOWN_${pos.symbol}`, "1", { expirationTtl: CONFIG.COOLDOWN_AFTER_SL_SEC });
    }
  } catch (e) { console.error("Stat Error:", e); }
  return finalPct;
}

async function checkActivePositions(env) {
  if (!env.SIGNAL_KV) return 0;
  const open = await loadPositions(env);
  if (!open.length) return 0;

  const prices = await fetchLivePrices();
  let active = 0;
  for (const pos of open) {
    const price = prices[pos.symbol];
    if (!price) { active++; continue; }

    const res = evaluatePosition(pos, price);
    if (!res) { active++; continue; }

    let finalPct = null;
    if (res.closed) finalPct = await finalizeTrade(env, res.pos, res.action, res.exitPrice);
    else { await savePosition(env, res.pos); active++; }

    const text = buildPositionMessage(res.action, res.pos, { price, elapsedMin: res.elapsedMin, finalPct });
    await sendTelegramRaw(env, pos.chatId, text, null, pos.messageId);
  }
  return active;
}

async function runRealTimeSchedule(env) {
  await runBotEngine(env);
  for (let tick = 0; tick < CONFIG.MONITOR_TICKS; tick++) {
    await sleep(CONFIG.MONITOR_INTERVAL_MS);
    if ((await checkActivePositions(env)) === 0) break;
  }
}

/* =========================================================
   ۷. موتور اسکن اصلی
========================================================= */
async function openSignal(env, candidate, { chatId = null, isForced = false } = {}) {
  const signalId = await getNextSignalId(env);
  const targets = calculateDayTradeTargets(candidate.tf1h, candidate.direction);
  const sent = await sendProSignalMessage(env, { ...candidate, targets, signalId, isForced }, chatId);
  if (!sent.ok) {
    console.error("Signal not delivered; position not tracked:", candidate.symbol);
    return false;
  }
  if (env.SIGNAL_KV) {
    await savePosition(env, createPosition({
      signalId, messageId: sent.messageId, chatId: sent.chatId,
      symbol: candidate.symbol, direction: candidate.direction, entry: candidate.entry, targets
    }));
    if (!isForced) await env.SIGNAL_KV.put(`COOLDOWN_${candidate.symbol}`, "1", { expirationTtl: CONFIG.COOLDOWN_SEC });
  }
  return true;
}

async function runBotEngine(env, { force = false, chatId = null } = {}) {
  try {
    if (!force && !env.SIGNAL_KV) {
      console.warn("SIGNAL_KV binding is missing: auto-signals disabled to avoid duplicate spam.");
      return;
    }
    let active = await checkActivePositions(env);
    if (!force && active >= CONFIG.MAX_OPEN_POSITIONS) return;

    const eligible = [];
    for (const symbol of SYMBOLS) {
      if (env.SIGNAL_KV) {
        const [pos, cooldown] = await Promise.all([
          env.SIGNAL_KV.get(`POS_${symbol}`),
          force ? null : env.SIGNAL_KV.get(`COOLDOWN_${symbol}`)
        ]);
        if (pos || cooldown) continue;
      }
      eligible.push(symbol);
    }
    if (!eligible.length) {
      if (force) await sendTelegramRaw(env, chatId, "ℹ️ برای همه ارزها پوزیشن باز وجود دارد؛ سیگنال جدیدی صادر نشد.");
      return;
    }

    const macro = await analyzeDailyMacro();
    const analyses = (await Promise.all(eligible.map((s) => analyzeSymbol(env, s, macro))))
      .filter((a) => !a.error)
      .sort((a, b) => b.scoreData.score - a.scoreData.score);

    if (force) {
      if (!analyses.length) {
        await sendTelegramRaw(env, chatId, "❌ دریافت دیتای بازار ناموفق بود؛ کمی بعد دوباره تلاش کنید.");
        return;
      }
      await openSignal(env, analyses[0], { chatId, isForced: true });
      return;
    }

    for (const candidate of analyses) {
      if (active >= CONFIG.MAX_OPEN_POSITIONS) break;
      if (isSignalWorthy(candidate) && (await openSignal(env, candidate))) active++;
    }
  } catch (error) {
    console.error("Bot Engine Error:", error);
  }
}

/* =========================================================
   ۸. تلگرام (ارسال، Retry، Fallback متن ساده)
========================================================= */
async function getTelegramCredentials(env) {
  // خواندن از KV فقط برای سازگاری با نسخه قبل است؛ دیگر هیچ مقداری در KV نوشته نمی‌شود.
  const token = env.TELEGRAM_BOT_TOKEN || (env.SIGNAL_KV ? await env.SIGNAL_KV.get("SAVED_BOT_TOKEN").catch(() => null) : null);
  const chatId = env.TELEGRAM_CHAT_ID || (env.SIGNAL_KV ? await env.SIGNAL_KV.get("SAVED_CHAT_ID").catch(() => null) : null) || null;
  return { token, chatId };
}

async function telegramApi(env, method, payload) {
  const { token } = await getTelegramCredentials(env);
  if (!token) return { ok: false, description: "Missing Bot Token" };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchWithTimeout(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }, 10_000);
      const data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
      if (data.ok) return data;
      if (data.error_code === 429 && attempt === 0) {
        await sleep(clamp(data.parameters?.retry_after ?? 1, 1, 5) * 1000);
        continue;
      }
      console.error(`Telegram ${method} failed:`, data.description);
      return data;
    } catch (e) {
      if (attempt === 1) { console.error(`Telegram ${method} error:`, String(e)); return { ok: false, description: String(e) }; }
    }
  }
  return { ok: false, description: "Unknown error" };
}

async function sendTelegramRaw(env, chatId, text, replyMarkup = null, replyToMessageId = null) {
  const { chatId: defaultChatId } = await getTelegramCredentials(env);
  const target = chatId || defaultChatId;
  if (!target) return { ok: false, description: "Missing chat id" };

  const payload = { chat_id: target, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  if (replyToMessageId) payload.reply_parameters = { message_id: replyToMessageId, allow_sending_without_reply: true };

  let res = await telegramApi(env, "sendMessage", payload);
  if (!res.ok && /parse entities/i.test(res.description || "")) {
    const { parse_mode, ...plain } = payload;
    res = await telegramApi(env, "sendMessage", { ...plain, text: text.replace(/<[^>]+>/g, "") });
  }
  return res;
}

const answerCallback = (env, id, text = "", alert = false) =>
  telegramApi(env, "answerCallbackQuery", { callback_query_id: id, text, show_alert: alert });

/* =========================================================
   ۹. قالب پیام‌ها
========================================================= */
function buildScoreBar(score) {
  const filled = clamp(Math.round(score / 10), 0, 10);
  return "🟩".repeat(filled) + "⬜".repeat(10 - filled);
}

function buildPositionMessage(action, pos, { price, elapsedMin, finalPct }) {
  const isLong = pos.direction === "LONG";
  const lev = pos.leverage || 5;
  const fp = (x) => Number(x).toFixed(pos.dec);
  const levText = (p) => `${signed(p * lev, 1)}%`;
  const dur = formatDuration(elapsedMin);
  const head = `🔖 <b>سیگنال:</b> <code>#SIG-${pos.signalId ?? "1000"}</code> | <b>#${pos.symbol}</b> (${pos.direction})`;
  const box = (lines) => `<blockquote>${head}\n${tree(lines)}</blockquote>`;
  const gain = (level) => pctMove(pos.entry, level, isLong);
  const totalLine = () => `<b>برآیند کل پوزیشن:</b> <b>${signed(finalPct)}%</b> <i>(با اهرم: ${levText(finalPct)})</i>`;

  switch (action) {
    case "SL":
      return `🛑 <b>برخورد با حد ضرر روزانه (Stop-Loss)</b>\n${box([
        `<b>قیمت ورود:</b> <code>${fp(pos.entry)}</code>`,
        `<b>قیمت استاپ:</b> <code>${fp(pos.sl)}</code>`,
        `<b>نتیجه:</b> <b>${signed(finalPct)}%</b> <i>(با اهرم: ${levText(finalPct)})</i>`,
        `<b>مدت معامله:</b> ${dur}`
      ])}`;
    case "BE":
      return `🛡️ <b>بسته شدن در نقطه ریسک‌فری (Break-Even)</b>\n${box([
        `<b>نقطه خروج:</b> <code>${fp(pos.sl)}</code>`,
        `<b>وضعیت قبلی:</b> تارگت ۱ قبلاً با سود بسته شده ✅`,
        totalLine(),
        `<b>مدت معامله:</b> ${dur}`
      ])}`;
    case "LOCK":
      return `🔒 <b>خروج با سود از قفل TP1</b>\n${box([
        `<b>نقطه خروج:</b> <code>${fp(pos.sl)}</code>`,
        `<b>وضعیت قبلی:</b> تارگت ۲ قبلاً تاچ شده ✅`,
        totalLine(),
        `<b>مدت معامله:</b> ${dur}`
      ])}`;
    case "TP3":
      return `🚀💎 <b>فول تارگت روزانه (TP3 Hit!)</b>\n${box([
        `<b>قیمت ورود:</b> <code>${fp(pos.entry)}</code>`,
        `<b>تارگت ۳:</b> <code>${fp(pos.tp3)}</code>`,
        `<b>سود موج تا TP3:</b> <b>${signed(gain(pos.tp3))}%</b> <i>(با اهرم ${lev}x: <b>${levText(gain(pos.tp3))}</b>)</i>`,
        totalLine(),
        `<b>مدت معامله:</b> ${dur}`
      ])}\n🏆 <i>معامله روزانه با موفقیت کامل بسته شد!</i>`;
    case "TP2":
      return `🎯🔥 <b>تارگت دوم روزانه تاچ شد (TP2 Hit!)</b>\n${box([
        `<b>قیمت ورود:</b> <code>${fp(pos.entry)}</code>`,
        `<b>قیمت فعلی:</b> <code>${fp(price)}</code>`,
        `<b>سود فعلی:</b> <b>${signed(gain(pos.tp2))}%</b> <i>(با اهرم ${lev}x: <b>${levText(gain(pos.tp2))}</b>)</i>`,
        `<b>مدت زمان:</b> ${dur}`
      ])}\n🛡️ <b>قفل سود:</b> حد ضرر خودکار به <b>TP1 (<code>${fp(pos.tp1)}</code>)</b> منتقل شد.`;
    case "TP1":
      return `✅⚡️ <b>تارگت اول روزانه تاچ شد (TP1 Hit!)</b>\n${box([
        `<b>قیمت ورود:</b> <code>${fp(pos.entry)}</code>`,
        `<b>قیمت فعلی:</b> <code>${fp(price)}</code>`,
        `<b>سود فعلی:</b> <b>${signed(gain(pos.tp1))}%</b> <i>(با اهرم ${lev}x: <b>${levText(gain(pos.tp1))}</b>)</i>`,
        `<b>مدت زمان:</b> ${dur}`
      ])}\n🛡️ <b>ریسک‌فری فعال شد:</b> ${Math.round(CONFIG.TP1_CLOSE_FRACTION * 100)}٪ سیو سود کنید؛ استاپ به <code>${fp(pos.sl)}</code> منتقل شد.`;
    case "TIME":
      return `⏳ <b>اتمام چرخه روزانه پوزیشن (Daily Time-Stop)</b>\n${box([
        `<b>ورود:</b> <code>${fp(pos.entry)}</code> | <b>فعلی:</b> <code>${fp(price)}</code>`,
        totalLine(),
        `<b>علت:</b> پایان سیکل ${Math.round(CONFIG.MAX_TRADE_DURATION_MIN / 60)} ساعته Day-Trade`
      ])}`;
    default:
      return box([`<b>رویداد:</b> ${escapeHtml(action)}`]);
  }
}

function buildSignalMessage(data) {
  const { signalId, symbol, direction, entry, targets: t, scoreData, tf1h, macro, news, isForced } = data;
  const isLong = direction === "LONG";
  const fp = (x) => Number(x).toFixed(t.dec);
  const dirTitle = isLong ? "🟢 <b>LONG (معامله روزانه / خرید)</b>" : "🔴 <b>SHORT (معامله روزانه / فروش)</b>";
  const modeTag = isForced ? "⚡️ <i>سیگنال درخواستی (/force)</i>\n" : "";

  return `
${modeTag}${dirTitle} | <b>#${symbol}</b> • <code>1H / 4H</code>
🔖 <b>کد سیگنال:</b> <code>#SIG-${signalId}</code>
⭐️ <b>اعتبار روزانه:</b> <b>${scoreData.score}/100</b> <i>(${scoreData.grade})</i>
<code>${buildScoreBar(scoreData.score)}</code>

🎯 <b>ستاپ ورود و مدیریت ریسک روزانه</b>
├ <b>ستاپ ۱ ساعته:</b> ${tf1h.setupType}
├ <b>قیمت ورود:</b> <code>${fp(entry)}</code> <i>(محدوده پله‌ای: ${t.entryZone})</i>
└ <b>اهرم و حجم:</b> <code>Isolated ${t.leverage}x</code> <i>(${t.marginPct}% Wallet)</i>

💰 <b>تارگت‌های موج روزانه و حد ضرر</b> <i>(با لمس کپی می‌شود)</i>
├ ⚡️ <b>TP 1:</b> <code>${fp(t.tp1)}</code> <i>(+${t.tp1Pct}% | ریسک‌فری)</i>
├ 🔥 <b>TP 2:</b> <code>${fp(t.tp2)}</code> <i>(+${t.tp2Pct}% | تارگت اصلی روز)</i>
├ 🚀 <b>TP 3:</b> <code>${fp(t.tp3)}</code> <i>(+${t.tp3Pct}% | تارگت ۴ ساعته)</i>
└ 🛡️ <b>SL:</b> <code>${fp(t.sl)}</code> <i>(-${t.slPct}% | پشت سوئینگ 1H)</i>

<blockquote>🌐 <b>قطب‌نمای کلان و اخبار (v${VERSION}):</b>
• <b>USDT.D:</b> ${macro.usdtD}% | <b>TOTAL2 (4h):</b> <b>${macro.total2Change4h}%</b> | <b>اخبار:</b> ${news.label}
• <b>سقف/کف روز قبل:</b> PDH: <code>${fp(tf1h.pdh)}</code> | PDL: <code>${fp(tf1h.pdl)}</code>
${scoreData.reasons.slice(0, 4).join("\n")}</blockquote>
`.trim();
}

async function sendProSignalMessage(env, data, customChatId = null) {
  const { signalId, symbol } = data;
  const replyMarkup = {
    inline_keyboard: [
      [{ text: `📈 چارت 1H #${symbol} در TradingView`, url: `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol}&interval=60` }],
      [
        { text: "🔄 بروزرسانی ارز", callback_data: `coin_${symbol}` },
        { text: `❌ بستن #SIG-${signalId}`, callback_data: `close_${symbol}` }
      ],
      [
        { text: "📂 پوزیشن‌های باز", callback_data: "cmd_positions" },
        { text: "📜 تاریخچه", callback_data: "cmd_history" }
      ]
    ]
  };
  const { chatId: defaultChatId } = await getTelegramCredentials(env);
  const target = customChatId || defaultChatId;
  const res = await sendTelegramRaw(env, target, buildSignalMessage(data), replyMarkup);
  return { ok: Boolean(res?.ok), messageId: res?.result?.message_id ?? null, chatId: res?.result?.chat?.id ?? target };
}

const COIN_BUTTONS = [
  { text: "🟡 BTC", callback_data: "coin_BTCUSDT" },
  { text: "🔵 ETH", callback_data: "coin_ETHUSDT" },
  { text: "🟣 SOL", callback_data: "coin_SOLUSDT" },
  { text: "🟠 BNB", callback_data: "coin_BNBUSDT" }
];

async function sendMainMenu(env, chatId) {
  const lastId = (await env.SIGNAL_KV?.get("LAST_SIGNAL_ID")) || "1000";
  const text = `
🤖 <b>پنل دیلی تریدینگ هوشمند کریپتو</b> • <code>v${VERSION} Day-Trader</code>

<blockquote>🏛️ <b>معماری استراتژی روزانه (1H / 4H):</b>
├ <b>۱. قطب‌نمای کلان:</b> دامیننس تتر (USDT.D) + شاخص TOTAL2 ✅
├ <b>۲. سطوح روزانه:</b> سقف/کف روز قبل (PDH/PDL) + Order Block 1H ✅
├ <b>۳. روند و مومنتوم:</b> EMA 21/50/200 + Supertrend + MACD ✅
├ <b>۴. سنتیمنت و فیوچرز:</b> اخبار CryptoPanic + سفارشات OKX ✅
└ <b>حد نصاب ثابت:</b> <b>${CONFIG.MIN_SCORE}/100</b> (آخرین کد: <code>#SIG-${lastId}</code>)</blockquote>

👇 <b>عملیات مورد نظر را انتخاب کنید:</b>
`.trim();

  return sendTelegramRaw(env, chatId, text, {
    inline_keyboard: [
      [
        { text: "🔎 اسکن روزانه بازار (/scan)", callback_data: "cmd_scan" },
        { text: "📂 پوزیشن‌های باز (/positions)", callback_data: "cmd_positions" }
      ],
      COIN_BUTTONS,
      [
        { text: "📜 تاریخچه (/history)", callback_data: "cmd_history" },
        { text: "📈 آمار وین‌ریت (/stats)", callback_data: "cmd_stats" }
      ],
      [
        { text: "🔄 ریست آمار (/reset)", callback_data: "cmd_reset" },
        { text: "⚡️ سیگنال فوری (/force)", callback_data: "cmd_force" }
      ]
    ]
  });
}

/* =========================================================
   ۱۰. دستورات ربات
========================================================= */
function buildScanBlock(c) {
  const { symbol, direction, tf1h, scoreData, news } = c;
  const dirIcon = direction === "LONG" ? "🟢 LONG" : "🔴 SHORT";
  let state = tf1h.hasDaySetup ? `🔥 <b>${tf1h.setupType}</b>` : "⏳ در انتظار پولبک به EMA21 / سطح روزانه";
  if (!tf1h.trendBias) state = "⏳ روند ۴ ساعته نامشخص؛ بدون معامله";
  if (tf1h.isChop) state = "⚠️ بازار بدون روند (ADX پایین)";
  else if (tf1h.isLowVol) state = "💤 نوسان خیلی کم؛ تارگت‌ها به کارمزد می‌خورند";
  else if (tf1h.isOverextended) state = "🚫 اشباع کندل ۱ ساعته (صبر برای اصلاح)";
  else if (tf1h.isStale) state = "⌛ قیمت از کندل ستاپ فاصله گرفته (ورود دیرهنگام)";
  return (
    `🪙 <b>#${symbol}</b> • <code>${tf1h.close}</code>\n` +
    `├ <b>جهت (1H/4H):</b> ${dirIcon} | <b>امتیاز: ${scoreData.score}/100</b>\n` +
    `├ <b>شاخص‌ها:</b> RSI: <code>${tf1h.rsi.toFixed(0)}</code> | ADX: <code>${tf1h.adx.toFixed(0)}</code> | اخبار: ${news.label}\n` +
    `└ <b>وضعیت:</b> ${state}`
  );
}

async function handleScanCommand(env, chatId) {
  try {
    const macro = await analyzeDailyMacro();
    const results = await Promise.all(SYMBOLS.map((s) => analyzeSymbol(env, s, macro)));
    const blocks = results.map((r) => (r.error ? `🔸 <b>#${r.symbol}</b>: ⚠️ خطا در دریافت کندل` : buildScanBlock(r)));

    const msg = `
🔎 <b>اسکن دیلی تریدینگ بازار (v${VERSION} • 1H/4H)</b>
<blockquote>🌐 <b>USDT.D:</b> <code>${macro.usdtD}%</code> | <b>BTC.D:</b> <code>${macro.btcD}%</code>
📊 <b>شاخص TOTAL2 (4h):</b> <b>${macro.total2Change4h}%</b> | <b>BTC (4h):</b> <b>${macro.btc4hChg}%</b>
🧭 <b>وضعیت کلان:</b> ${macro.macroSummary}</blockquote>

${blocks.join("\n\n")}
`.trim();

    await sendTelegramRaw(env, chatId, msg, {
      inline_keyboard: [COIN_BUTTONS, [
        { text: "🔄 رفرش اسکن", callback_data: "cmd_scan" },
        { text: "🏠 منوی اصلی", callback_data: "cmd_menu" }
      ]]
    });
  } catch (e) {
    await sendTelegramRaw(env, chatId, `❌ خطا در اسکن بازار: ${escapeHtml(e.message)}`);
  }
}

async function handlePositionsCommand(env, chatId) {
  const [macro, prices, positions] = await Promise.all([analyzeDailyMacro(), fetchLivePrices(), loadPositions(env)]);

  const cards = positions.map((p) => {
    const isLong = p.direction === "LONG";
    const cur = prices[p.symbol] || p.entry;
    const pnl = pctMove(p.entry, cur, isLong);
    const ageMin = Math.max(1, Math.round((Date.now() - (p.openedAt || Date.now())) / 60000));
    const age = ageMin >= 60 ? `${Math.floor(ageMin / 60)}h ${ageMin % 60}m` : `${ageMin}m`;
    return (
      `<blockquote>🔖 <b>#SIG-${p.signalId || "1000"}</b> | <b>#${p.symbol}</b> • ${isLong ? "🟢 LONG" : "🔴 SHORT"} (${p.leverage}x)\n` +
      `├ <b>ورود:</b> <code>${p.entry}</code> ➔ <b>فعلی:</b> <code>${cur}</code>\n` +
      `├ <b>سود/ضرر:</b> ${pnl >= 0 ? "🟢" : "🔴"} <b>${signed(pnl)}%</b> <i>(با اهرم: ${signed(pnl * p.leverage, 1)}%)</i>\n` +
      `├ <b>اهداف:</b> TP1: <code>${p.tp1}</code> ${p.tp1Hit ? "✅" : "⏳"} | SL: <code>${p.sl}</code>\n` +
      `└ <b>مدت باز بودن:</b> ${age}</blockquote>`
    );
  });

  const body = cards.length ? cards.join("\n") : "<blockquote>🟢 هیچ پوزیشن روزانه فعالی در حال حاضر باز نیست.</blockquote>";
  const report = `
📂 <b>پوزیشن‌های روزانه تحت رصد (v${VERSION})</b>
🌐 <code>USDT.D: ${macro.usdtD}% | TOTAL2 (4h): ${macro.total2Change4h}%</code>

${body}
`.trim();

  await sendTelegramRaw(env, chatId, report, {
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
  });
}

async function handleSingleCoinCommand(env, chatId, symbol) {
  const macro = await analyzeDailyMacro();
  const c = await analyzeSymbol(env, symbol, macro);
  if (c.error) {
    await sendTelegramRaw(env, chatId, `❌ خطا در دریافت دیتای کندل برای #${symbol}`);
    return;
  }
  const { direction, tf1h, tf4h, scoreData, news, futuresData } = c;
  const targets = calculateDayTradeTargets(tf1h, direction);
  const dec = targets.dec;

  const text = `
🔬 <b>کالبدشکافی دیلی تریدینگ (v${VERSION} • 1H/4H)</b> | <b>#${symbol}</b>
💰 <b>قیمت لحظه‌ای:</b> <code>${tf1h.close}</code>
⭐️ <b>امتیاز روزانه:</b> <b>${scoreData.score}/100</b> <i>(حد نصاب: ${CONFIG.MIN_SCORE})</i>
<code>${buildScoreBar(scoreData.score)}</code>

🏛️ <b>ساختار روزانه و سطوح کلیدی</b>
├ <b>ستاپ ۱ ساعته:</b> ${tf1h.setupType}
├ <b>روند 1H / 4H:</b> ${direction === "LONG" ? "🟢 صعودی" : "🔴 نزولی"} / ${tf4h.supertrend.direction === "LONG" ? "🟢 صعودی" : "🔴 نزولی"}
├ <b>سقف و کف روز قبل:</b> PDH: <code>${tf1h.pdh.toFixed(dec)}</code> | PDL: <code>${tf1h.pdl.toFixed(dec)}</code>
├ <b>میانگین‌های 1H:</b> EMA21: <code>${tf1h.ema21.toFixed(dec)}</code> | EMA200: <code>${tf1h.ema200.toFixed(dec)}</code>
└ <b>اخبار و فیوچرز:</b> اخبار: ${news.label} | Taker Buy: <code>${futuresData.takerBuyRatio}%</code>

<blockquote>🎯 <b>سطوح موج روزانه در صورت ورود (${direction}):</b>
⚡️ <b>TP1:</b> <code>${targets.tp1.toFixed(dec)}</code> (+${targets.tp1Pct}%) | 🔥 <b>TP2:</b> <code>${targets.tp2.toFixed(dec)}</code> (+${targets.tp2Pct}%) | 🛡️ <b>SL:</b> <code>${targets.sl.toFixed(dec)}</code></blockquote>
`.trim();

  await sendTelegramRaw(env, chatId, text, {
    inline_keyboard: [
      [
        { text: "🔄 رفرش تحلیل", callback_data: `coin_${symbol}` },
        { text: "📈 چارت 1H در TradingView", url: `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol}&interval=60` }
      ],
      [{ text: "🔎 بازگشت به اسکن کل بازار", callback_data: "cmd_scan" }]
    ]
  });
}

async function handleHistoryCommand(env, chatId) {
  const history = await kvGetJson(env, "SIGNAL_HISTORY", []);
  const lines = history.length
    ? history.map((i) => `├ <code>#SIG-${i.signalId || "1000"}</code> • <b>#${i.symbol}</b> (${i.direction}) ➔ ${i.result} (<b>${signed(i.pct)}%</b>)`).join("\n")
    : "└ هنوز سیگنالی در این دوره ثبت نشده است.";

  await sendTelegramRaw(env, chatId, `📜 <b>تاریخچه ${CONFIG.HISTORY_SIZE} سیگنال آخر بات</b>\n<blockquote>${lines}</blockquote>`, {
    inline_keyboard: [
      [
        { text: "📈 آمار وین‌ریت (/stats)", callback_data: "cmd_stats" },
        { text: "🔄 ریست تاریخچه (/reset)", callback_data: "cmd_reset" }
      ],
      [{ text: "🏠 بازگشت به منوی اصلی", callback_data: "cmd_menu" }]
    ]
  });
}

async function handleStatsCommand(env, chatId) {
  const stats = await kvGetJson(env, "BOT_STATS", { wins: 0, losses: 0, netPct: 0 });
  const total = stats.wins + stats.losses;
  const winRate = total > 0 ? ((stats.wins / total) * 100).toFixed(1) : "0.0";

  const text = `
📈 <b>کارنامه و آمار عملکرد بات (v${VERSION} Day-Trading)</b>
<blockquote>├ ✅ <b>معاملات سودده (Wins):</b> ${stats.wins}
├ 🛑 <b>معاملات زیان‌ده (Losses):</b> ${stats.losses}
├ 🏆 <b>نرخ برد (Win-Rate):</b> <b>${winRate}%</b>
└ 💰 <b>برآیند خالص (بدون اهرم):</b> <b>${signed(stats.netPct)}%</b></blockquote>
`.trim();

  await sendTelegramRaw(env, chatId, text, {
    inline_keyboard: [
      [
        { text: "📜 تاریخچه سیگنال‌ها (/history)", callback_data: "cmd_history" },
        { text: "🔄 صفر کردن آمار (/reset)", callback_data: "cmd_reset" }
      ],
      [{ text: "🏠 بازگشت به منوی اصلی", callback_data: "cmd_menu" }]
    ]
  });
}

function askConfirm(env, chatId, name, question) {
  return sendTelegramRaw(env, chatId, `⚠️ <b>${question}</b>\nاین عملیات قابل بازگشت نیست. مطمئن هستید؟`, {
    inline_keyboard: [[
      { text: "✅ بله، انجام شود", callback_data: `cmd_${name}_yes` },
      { text: "❌ انصراف", callback_data: "cmd_menu" }
    ]]
  });
}

async function handleClearCommand(env, chatId) {
  if (env.SIGNAL_KV) {
    await Promise.all(SYMBOLS.flatMap((s) => [env.SIGNAL_KV.delete(`POS_${s}`), env.SIGNAL_KV.delete(`COOLDOWN_${s}`)]));
  }
  await sendTelegramRaw(env, chatId, "🗑️ <b>پاکسازی پوزیشن‌ها انجام شد</b>\n└ تمام پوزیشن‌های فعال و قفل‌های زمانی بسته شدند.");
}

async function handleResetCommand(env, chatId) {
  if (env.SIGNAL_KV) {
    await Promise.all([
      env.SIGNAL_KV.put("BOT_STATS", JSON.stringify({ wins: 0, losses: 0, netPct: 0 })),
      env.SIGNAL_KV.put("SIGNAL_HISTORY", JSON.stringify([])),
      env.SIGNAL_KV.put("LAST_SIGNAL_ID", "1000"),
      ...SYMBOLS.flatMap((s) => [env.SIGNAL_KV.delete(`POS_${s}`), env.SIGNAL_KV.delete(`COOLDOWN_${s}`)])
    ]);
  }
  const msg = `
🔄 <b>ریست کامل کارنامه و حافظه بات انجام شد!</b>
<blockquote>├ 📊 <b>آمار برد و باخت (/stats):</b> صفر شد (0 Win / 0 Loss)
├ 📜 <b>تاریخچه معاملات (/history):</b> پاکسازی شد
├ 📂 <b>پوزیشن‌های باز و قفل‌ها:</b> پاکسازی شد
└ 🔢 <b>شمارنده سیگنال‌ها:</b> بازنشانی به <code>#SIG-1000</code></blockquote>
✅ <i>از این لحظه فقط عملکرد نسخه <b>v${VERSION} (1H/4H)</b> ثبت خواهد شد.</i>
`.trim();
  await sendTelegramRaw(env, chatId, msg, {
    inline_keyboard: [[
      { text: "🔎 اسکن بازار (/scan)", callback_data: "cmd_scan" },
      { text: "🏠 منوی اصلی", callback_data: "cmd_menu" }
    ]]
  });
}

async function handleManualClose(env, chatId, symbol) {
  const pos = await loadPosition(env, symbol);
  if (!pos) {
    await sendTelegramRaw(env, chatId, `ℹ️ پوزیشن بازی برای <b>#${symbol}</b> وجود ندارد.`);
    return;
  }
  const price = (await fetchLivePrices())[symbol];
  let resultLine = "از لیست رصد خارج شد ✅";
  if (price) {
    const pct = await finalizeTrade(env, pos, "MANUAL", price);
    resultLine = `برآیند نهایی: <b>${signed(pct)}%</b> (ثبت در آمار) ✅`;
  } else {
    await env.SIGNAL_KV.delete(`POS_${symbol}`);
  }
  await sendTelegramRaw(env, chatId, `🗑️ <b>بستن دستی پوزیشن روزانه</b>\n├ <b>سیگنال:</b> <code>#SIG-${pos.signalId}</code> (<b>#${symbol}</b>)\n└ <b>وضعیت:</b> ${resultLine}`);
}

/* =========================================================
   ۱۱. مسیریابی دستورات + احراز هویت
========================================================= */
const ROUTES = {
  menu:      { run: sendMainMenu },
  scan:      { run: handleScanCommand },
  positions: { run: handlePositionsCommand },
  stats:     { run: handleStatsCommand },
  history:   { run: handleHistoryCommand },
  force:     { run: (env, chatId) => runBotEngine(env, { force: true, chatId }), admin: true },
  clear:     { run: (env, chatId) => askConfirm(env, chatId, "clear", "بستن همه پوزیشن‌ها و قفل‌ها"), admin: true },
  clear_yes: { run: handleClearCommand, admin: true },
  reset:     { run: (env, chatId) => askConfirm(env, chatId, "reset", "ریست کامل آمار، تاریخچه و پوزیشن‌ها"), admin: true },
  reset_yes: { run: handleResetCommand, admin: true }
};

const TEXT_ALIASES = {
  start: "menu", menu: "menu", help: "menu", scan: "scan",
  status: "positions", positions: "positions", stats: "stats", history: "history",
  force: "force", clear: "clear", reset: "reset"
};

async function isAuthorized(env, chatId, userId) {
  if (parseIdList(env.ADMIN_USER_IDS).includes(String(userId))) return true;
  const { chatId: defaultChat } = await getTelegramCredentials(env);
  return defaultChat != null && String(defaultChat) === String(chatId);
}

function isAdmin(env, userId) {
  const admins = parseIdList(env.ADMIN_USER_IDS);
  return admins.length === 0 || admins.includes(String(userId)); // بدون ADMIN_USER_IDS، همه کاربران مجاز چت ادمین حساب می‌شوند
}

async function handleCallback(env, cb) {
  const chatId = cb.message?.chat?.id;
  const userId = cb.from?.id;
  if (!chatId) { await answerCallback(env, cb.id); return; }

  if (!(await isAuthorized(env, chatId, userId))) {
    await answerCallback(env, cb.id, "⛔ دسترسی ندارید", true);
    return;
  }
  const data = String(cb.data || "");
  const needsAdmin = data.startsWith("close_") || (data.startsWith("cmd_") && ROUTES[data.slice(4)]?.admin);
  if (needsAdmin && !isAdmin(env, userId)) {
    await answerCallback(env, cb.id, "⛔ فقط ادمین می‌تواند این کار را انجام دهد", true);
    return;
  }
  await answerCallback(env, cb.id, "⏳ در حال پردازش...");

  if (data.startsWith("cmd_")) {
    await ROUTES[data.slice(4)]?.run(env, chatId);
  } else if (data.startsWith("coin_")) {
    const sym = data.slice(5);
    if (SYMBOLS.includes(sym)) await handleSingleCoinCommand(env, chatId, sym);
  } else if (data.startsWith("close_")) {
    const sym = data.slice(6);
    if (SYMBOLS.includes(sym)) await handleManualClose(env, chatId, sym);
  }
}

async function handleMessage(env, msg) {
  const m = msg.text.trim().match(/^\/([a-z0-9_]+)(?:@\w+)?(?:\s|$)/i);
  if (!m) return;
  const chatId = msg.chat.id, userId = msg.from?.id;
  if (!(await isAuthorized(env, chatId, userId))) return;

  const cmd = m[1].toLowerCase();
  const routeName = TEXT_ALIASES[cmd];
  if (routeName) {
    const route = ROUTES[routeName];
    if (route.admin && !isAdmin(env, userId)) {
      await sendTelegramRaw(env, chatId, "⛔ فقط ادمین می‌تواند این دستور را اجرا کند.");
      return;
    }
    await route.run(env, chatId);
    return;
  }
  const sym = `${cmd.toUpperCase()}USDT`;
  if (SYMBOLS.includes(sym)) await handleSingleCoinCommand(env, chatId, sym);
}

async function handleUpdate(env, update) {
  if (update.callback_query) await handleCallback(env, update.callback_query);
  else if (update.message?.text) await handleMessage(env, update.message);
}

/* =========================================================
   ۱۲. Entry Point
========================================================= */
const hasAdminKey = (env, url) =>
  Boolean(env.ADMIN_KEY) && safeEqual(url.searchParams.get("key") || "", env.ADMIN_KEY);

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runRealTimeSchedule(env).catch((e) => console.error("Schedule Error:", e)));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook" && request.method === "POST") {
      if (env.WEBHOOK_SECRET) {
        const provided = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
        if (!safeEqual(provided, env.WEBHOOK_SECRET)) return new Response("Forbidden", { status: 403 });
      }
      let update;
      try { update = await request.json(); } catch { return new Response("Bad Request", { status: 400 }); }
      // پاسخ فوری به تلگرام؛ پردازش سنگین در پس‌زمینه
      ctx.waitUntil(handleUpdate(env, update).catch((err) => console.error("Webhook Error:", err)));
      return new Response("OK", { status: 200 });
    }

    if (url.pathname === "/diag" || url.pathname === "/test") {
      if (!hasAdminKey(env, url)) return new Response("Forbidden", { status: 403 });

      if (url.pathname === "/test") {
        const { chatId } = await getTelegramCredentials(env);
        return json(await sendMainMenu(env, chatId));
      }
      const [prices, macro, creds] = await Promise.all([fetchLivePrices(), analyzeDailyMacro(), getTelegramCredentials(env)]);
      return json({
        ok: true,
        version: VERSION,
        minScore: CONFIG.MIN_SCORE,
        hasToken: Boolean(creds.token),
        chatId: creds.chatId,
        hasKV: Boolean(env.SIGNAL_KV),
        webhookSecretConfigured: Boolean(env.WEBHOOK_SECRET),
        adminUsersConfigured: parseIdList(env.ADMIN_USER_IDS).length,
        livePrices: prices,
        macroData: macro
      });
    }

    return new Response(`🤖 Crypto Signal Bot v${VERSION} Day-Trading Edition is Running!`, { status: 200 });
  }
};
