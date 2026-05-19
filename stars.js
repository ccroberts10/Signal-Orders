/**
 * 0DTE Reversal Stars — SPY Scanner
 * Runs every 30 seconds during market hours
 * Detects reversal setups using:
 *   1. Liquidity sweep of prior swing high/low
 *   2. Rejection wick
 *   3. Stretch from VWAP / EMA
 *   4. Exhaustion scoring (RSI, volume spike, range expansion, MACD)
 *
 * Weighted scoring 0-10:
 *   Sweep:       2pts (hard gate)
 *   Rejection:   2pts (hard gate)
 *   VWAP/EMA:    1.5pts
 *   RSI:         1.5pts
 *   Volume:      1pt
 *   Range:       1pt
 *   MACD:        1pt
 *
 * Score >= 7.5 fires a signal
 */

const express = require('express');
const router  = express.Router();

// ─── State ────────────────────────────────────────────────────────────────────
let scannerState = {
  running:     false,
  lastScan:    null,
  currentScore: { call: 0, put: 0 },
  conditions:  { call: {}, put: {} },
  signals:     [],           // last 20 signals
  activeOrder: null,
  scanInterval: null,
};

const ALPACA_HEADERS = () => ({
  'APCA-API-KEY-ID':     process.env.ALPACA_KEY,
  'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET,
  'Accept': 'application/json',
});

const DATA_URL   = 'https://data.alpaca.markets';
const TRADE_URL  = process.env.PAPER_TRADING !== 'false'
  ? 'https://paper-api.alpaca.markets'
  : 'https://api.alpaca.markets';

const MAX_SPEND  = parseFloat(process.env.STARS_MAX_SPEND || '50');
const SCORE_MIN  = parseFloat(process.env.STARS_SCORE_MIN || '9.0');  // 100% WR at 9+
const COOLDOWN   = parseInt(process.env.STARS_COOLDOWN_MINS || '30') * 60 * 1000; // 30min cooldown
const CALLS_ONLY = process.env.STARS_CALLS_ONLY !== 'false'; // calls only by default
const MAX_TRADES_PER_WEEK = parseInt(process.env.STARS_MAX_WEEKLY_TRADES || '3'); // PDT limit

let lastSignalTime = 0;
let weeklyTrades   = { count: 0, weekStart: getWeekStart() };

function getWeekStart() {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now.setDate(diff));
  monday.setHours(0, 0, 0, 0);
  return monday.getTime();
}

function checkWeeklyLimit() {
  const currentWeekStart = getWeekStart();
  if (weeklyTrades.weekStart !== currentWeekStart) {
    weeklyTrades = { count: 0, weekStart: currentWeekStart };
  }
  return weeklyTrades.count < MAX_TRADES_PER_WEEK;
}

function recordWeeklyTrade() {
  const currentWeekStart = getWeekStart();
  if (weeklyTrades.weekStart !== currentWeekStart) {
    weeklyTrades = { count: 0, weekStart: currentWeekStart };
  }
  weeklyTrades.count++;
}

// ─── Data Fetching ────────────────────────────────────────────────────────────

async function fetchSPYBars(timeframe = '2Min', limit = 30) {
  const url = `${DATA_URL}/v2/stocks/SPY/bars?timeframe=${timeframe}&limit=${limit}&feed=iex&adjustment=split`;
  const res = await fetch(url, { headers: ALPACA_HEADERS() });
  if (!res.ok) throw new Error(`SPY bars ${res.status}`);
  const data = await res.json();
  return data.bars || [];
}

async function fetchVWAP() {
  try {
    const bars = await fetchSPYBars('1Min', 390);
    if (!bars.length) return null;
    let cumTPV = 0, cumVol = 0;
    for (const b of bars) {
      const tp = (b.h + b.l + b.c) / 3;
      cumTPV += tp * b.v;
      cumVol += b.v;
    }
    return cumVol > 0 ? cumTPV / cumVol : null;
  } catch (e) {
    console.warn('[STARS] VWAP fetch failed:', e.message);
    return null;
  }
}

async function fetchSPY15mBars() {
  return fetchSPYBars('15Min', 10);
}

// ─── Technical Indicators ─────────────────────────────────────────────────────

function calcEMA(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let val = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < values.length; i++) val = values[i] * k + val * (1 - k);
  return val;
}

function calcRSI(closes, period = 7) {
  if (closes.length < period + 1) return 50;
  const recent = closes.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < recent.length; i++) {
    const d = recent[i] - recent[i - 1];
    if (d >= 0) gains += d; else losses -= d;
  }
  const ag = gains / period, al = losses / period;
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function calcMACD(closes) {
  if (closes.length < 26) return { hist: 0 };
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  if (!ema12 || !ema26) return { hist: 0 };
  const line = ema12 - ema26;
  // Simple signal approximation
  const signals = [];
  for (let i = 26; i <= closes.length; i++) {
    const e12 = calcEMA(closes.slice(0, i), 12);
    const e26 = calcEMA(closes.slice(0, i), 26);
    if (e12 && e26) signals.push(e12 - e26);
  }
  const sig = signals.length >= 9 ? calcEMA(signals, 9) : line;
  return { hist: line - (sig || 0), line };
}

// ─── Scoring Logic ────────────────────────────────────────────────────────────

function scoreSetup(bars2m, bars15m, vwap) {
  if (bars2m.length < 10) return null;

  const lookback  = 6;
  const closes    = bars2m.map(b => b.c);
  const highs     = bars2m.map(b => b.h);
  const lows      = bars2m.map(b => b.l);
  const volumes   = bars2m.map(b => b.v);

  const last      = bars2m[bars2m.length - 1];
  const prev      = bars2m[bars2m.length - 2];
  const price     = last.c;
  const barRange  = last.h - last.l;
  const atr       = bars2m.slice(-14).reduce((s, b) => s + (b.h - b.l), 0) / 14;

  // 15m trend
  const closes15m = bars15m.map(b => b.c);
  const ema15m    = calcEMA(closes15m, 8);
  const trend15m  = ema15m ? (closes15m[closes15m.length - 1] > ema15m ? 'bull' : 'bear') : 'neutral';

  // EMA21 on 2m
  const ema21     = calcEMA(closes, 21);
  const rsi       = calcRSI(closes, 7);
  const macd      = calcMACD(closes);
  const avgVol    = volumes.slice(-20, -1).reduce((s, v) => s + v, 0) / 19;
  const volRatio  = avgVol > 0 ? last.v / avgVol : 1;

  // Prior swing high/low in lookback window
  const lookSlice = bars2m.slice(-lookback - 1, -1);
  const swingHigh = Math.max(...lookSlice.map(b => b.h));
  const swingLow  = Math.min(...lookSlice.map(b => b.l));

  // ── BEARISH (PUT) setup ───────────────────────────────────────────────────
  const putConditions = {};

  // Hard gate 1: Sweep prior swing high
  putConditions.sweep = last.h > swingHigh && last.c < swingHigh;

  // Hard gate 2: Rejection wick — upper wick >= 30% of bar range
  const upperWick = last.h - Math.max(last.o, last.c);
  putConditions.rejection = barRange > 0 && (upperWick / barRange) >= 0.30;

  // VWAP stretch
  putConditions.vwapStretch = vwap ? (price < vwap && (vwap - price) / atr >= 0.3) : false;

  // EMA stretch
  putConditions.emaStretch = ema21 ? (price > ema21 * 1.002) : false;

  // RSI overbought
  putConditions.rsi = rsi >= 65;

  // Volume spike
  putConditions.volume = volRatio >= 1.5;

  // Range expansion
  const avgRange = bars2m.slice(-10, -1).reduce((s, b) => s + (b.h - b.l), 0) / 9;
  putConditions.range = barRange > avgRange * 1.3;

  // MACD bearish
  putConditions.macd = macd.hist < 0;

  // Bearish close location (closes in lower 35% of bar)
  const closeLocation = barRange > 0 ? (last.c - last.l) / barRange : 0.5;
  putConditions.bearClose = closeLocation <= 0.35;

  // Score PUT
  let putScore = 0;
  if (!putConditions.sweep || !putConditions.rejection) {
    putScore = 0; // Hard gates required
  } else {
    putScore += 2; // sweep
    putScore += 2; // rejection
    if (putConditions.vwapStretch || putConditions.emaStretch) putScore += 1.5;
    if (putConditions.rsi)    putScore += 1.5;
    if (putConditions.volume) putScore += 1;
    if (putConditions.range)  putScore += 1;
    if (putConditions.macd)   putScore += 1;
    if (!putConditions.bearClose) putScore -= 0.5; // penalty for not closing weak
  }

  // ── BULLISH (CALL) setup ──────────────────────────────────────────────────
  const callConditions = {};

  // Hard gate 1: Sweep prior swing low
  callConditions.sweep = last.l < swingLow && last.c > swingLow;

  // Hard gate 2: Rejection wick — lower wick >= 30% of bar range
  const lowerWick = Math.min(last.o, last.c) - last.l;
  callConditions.rejection = barRange > 0 && (lowerWick / barRange) >= 0.30;

  // VWAP stretch
  callConditions.vwapStretch = vwap ? (price > vwap && (price - vwap) / atr >= 0.3) : false;

  // EMA stretch
  callConditions.emaStretch = ema21 ? (price < ema21 * 0.998) : false;

  // RSI oversold
  callConditions.rsi = rsi <= 35;

  // Volume spike
  callConditions.volume = volRatio >= 1.5;

  // Range expansion
  callConditions.range = barRange > avgRange * 1.3;

  // MACD bullish
  callConditions.macd = macd.hist > 0;

  // Bullish close location (closes in upper 65% of bar)
  callConditions.bullClose = closeLocation >= 0.65;

  // Score CALL
  let callScore = 0;
  if (!callConditions.sweep || !callConditions.rejection) {
    callScore = 0;
  } else {
    callScore += 2;
    callScore += 2;
    if (callConditions.vwapStretch || callConditions.emaStretch) callScore += 1.5;
    if (callConditions.rsi)    callScore += 1.5;
    if (callConditions.volume) callScore += 1;
    if (callConditions.range)  callScore += 1;
    if (callConditions.macd)   callScore += 1;
    if (!callConditions.bullClose) callScore -= 0.5;
  }

  return {
    put:  { score: parseFloat(putScore.toFixed(2)),  conditions: putConditions,  trend: trend15m },
    call: { score: parseFloat(callScore.toFixed(2)), conditions: callConditions, trend: trend15m },
    price,
    atr:   parseFloat(atr.toFixed(4)),
    rsi:   parseFloat(rsi.toFixed(1)),
    vwap:  vwap ? parseFloat(vwap.toFixed(2)) : null,
    ema21: ema21 ? parseFloat(ema21.toFixed(2)) : null,
    volRatio: parseFloat(volRatio.toFixed(2)),
    trend: trend15m,
    timestamp: new Date().toISOString(),
  };
}

// ─── Options Execution ────────────────────────────────────────────────────────

async function fetchOptionsChain(direction, price, dte = 0) {
  const today = new Date();
  const exp   = new Date(today);
  exp.setDate(today.getDate() + dte);
  const expStr = exp.toISOString().split('T')[0];

  const url = `${DATA_URL}/v1beta1/options/snapshots/SPY?expiration_date=${expStr}&limit=50`;
  const res = await fetch(url, { headers: ALPACA_HEADERS() });
  if (!res.ok) throw new Error(`Options chain ${res.status}`);
  const data = await res.json();
  const snaps = data.snapshots || {};

  const type = direction === 'call' ? 'C' : 'P';
  const candidates = Object.entries(snaps)
    .filter(([sym]) => sym.includes(type))
    .map(([sym, snap]) => {
      const strike = parseFloat(sym.slice(-8)) / 1000;
      const bid    = snap.latestQuote?.bp || 0;
      const ask    = snap.latestQuote?.ap || 0;
      const mid    = (bid + ask) / 2;
      return { sym, strike, mid, bid, ask };
    })
    .filter(c => c.mid > 0 && c.mid * 100 <= MAX_SPEND);

  if (!candidates.length) return null;

  // Find ATM contract within budget
  const atm = candidates
    .sort((a, b) => Math.abs(a.strike - price) - Math.abs(b.strike - price))[0];

  return atm;
}

async function executeOptionsOrder(direction, score, price, dte = 0) {
  try {
    const contract = await fetchOptionsChain(direction, price, dte);
    if (!contract) {
      console.log(`[STARS] No suitable ${direction} contract found within $${MAX_SPEND}`);
      return null;
    }

    const limitPrice = parseFloat((contract.ask * 1.01).toFixed(2));
    const orderParams = {
      symbol:        contract.sym,
      qty:           '1',
      side:          'buy',
      type:          'limit',
      time_in_force: 'day',
      limit_price:   limitPrice.toString(),
    };

    const res = await fetch(`${TRADE_URL}/v2/orders`, {
      method: 'POST',
      headers: { ...ALPACA_HEADERS(), 'Content-Type': 'application/json' },
      body: JSON.stringify(orderParams),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Order failed: ${err}`);
    }

    const order = await res.json();
    console.log(`[STARS] ★ ${direction.toUpperCase()} order submitted: ${contract.sym} @ $${limitPrice} | score ${score}`);
    return { ...order, contract, limitPrice, direction, score, dte };
  } catch (e) {
    console.error(`[STARS] Execution error: ${e.message}`);
    return null;
  }
}

// ─── Main Scan ────────────────────────────────────────────────────────────────

async function runScan() {
  try {
    console.log('[STARS] Running scan...');
    const [bars2m, bars15m, vwap] = await Promise.all([
      fetchSPYBars('2Min', 40),
      fetchSPY15mBars(),
      fetchVWAP(),
    ]);

    console.log(`[STARS] Fetched ${bars2m.length} 2m bars, ${bars15m.length} 15m bars, VWAP=${vwap?.toFixed(2) || 'null'}`);
    const result = scoreSetup(bars2m, bars15m, vwap);
    if (!result) { console.log('[STARS] No result from scoreSetup'); return; }
    console.log(`[STARS] Scores — CALL: ${result.call.score} PUT: ${result.put.score} price: ${result.price?.toFixed(2)} trend: ${result.trend}`);

    scannerState.lastScan    = new Date().toISOString();
    scannerState.currentScore = { call: result.call.score, put: result.put.score };
    scannerState.conditions   = { call: result.call.conditions, put: result.put.conditions };
    scannerState.meta         = { price: result.price, atr: result.atr, rsi: result.rsi, vwap: result.vwap, ema21: result.ema21, volRatio: result.volRatio, trend: result.trend };

    const now        = Date.now();
    const cooledDown = (now - lastSignalTime) > COOLDOWN;

    // Check for signals — CALLS ONLY based on backtest (100% WR at score 9+)
    const callFired = result.call.score >= SCORE_MIN;
    const putFired  = !CALLS_ONLY && result.put.score >= SCORE_MIN;

    if ((putFired || callFired) && cooledDown) {
      // Check weekly PDT limit
      if (!checkWeeklyLimit()) {
        console.log(`[STARS] Signal blocked — weekly trade limit reached (${weeklyTrades.count}/${MAX_TRADES_PER_WEEK})`);
        scannerState.weeklyLimitHit = true;
        return;
      }
      scannerState.weeklyLimitHit = false;

      const direction = callFired ? 'call' : 'put';
      const score     = direction === 'call' ? result.call.score : result.put.score;
      const withTrend = direction === 'call'
        ? result.trend === 'bull'
        : result.trend === 'bear';

      const signal = {
        direction,
        score,
        withTrend,
        price:    result.price,
        atr:      result.atr,
        t1:       direction === 'put'
          ? parseFloat((result.price - result.atr * 0.8).toFixed(2))
          : parseFloat((result.price + result.atr * 0.8).toFixed(2)),
        stop:     direction === 'put'
          ? parseFloat((result.price + result.atr * 0.5).toFixed(2))
          : parseFloat((result.price - result.atr * 0.5).toFixed(2)),
        trend:    result.trend,
        timestamp: new Date().toISOString(),
        orders:   [],
      };

      lastSignalTime = now;
      recordWeeklyTrade();
      console.log(`[STARS] ★ SIGNAL: ${direction.toUpperCase()} score=${score} price=${result.price} weekly=${weeklyTrades.count}/${MAX_TRADES_PER_WEEK}`);

      // Execute 0DTE order
      const order0dte = await executeOptionsOrder(direction, score, result.price, 0);
      if (order0dte) signal.orders.push({ dte: 0, ...order0dte });

      // Execute 1-3DTE order if score is very high
      if (score >= 8.5) {
        const order1dte = await executeOptionsOrder(direction, score, result.price, 1);
        if (order1dte) signal.orders.push({ dte: 1, ...order1dte });
      }

      scannerState.signals.unshift(signal);
      if (scannerState.signals.length > 20) scannerState.signals.pop();
      scannerState.activeOrder = signal;
    }

  } catch (e) {
    console.error(`[STARS] Scan error: ${e.message}`);
  }
}

// ─── Scanner Control ──────────────────────────────────────────────────────────

function isMarketHours() {
  const now   = new Date();
  const et    = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day   = et.getDay();
  const hour  = et.getHours();
  const min   = et.getMinutes();
  const mins  = hour * 60 + min;
  return day >= 1 && day <= 5 && mins >= 9 * 60 + 35 && mins <= 15 * 60 + 45;
}

function startScanner() {
  if (scannerState.scanInterval) return;
  console.log('[STARS] Scanner started — polling every 30s during market hours');
  scannerState.running = true;

  scannerState.scanInterval = setInterval(async () => {
    if (isMarketHours()) {
      await runScan();
    }
  }, 30000);

  // Run immediately if market is open
  if (isMarketHours()) runScan();
}

// Auto-start
startScanner();

// ─── Routes ───────────────────────────────────────────────────────────────────

router.get('/status', (req, res) => {
  res.json({
    running:      scannerState.running,
    marketHours:  isMarketHours(),
    lastScan:     scannerState.lastScan,
    score:        scannerState.currentScore,
    conditions:   scannerState.conditions,
    meta:         scannerState.meta,
    signals:      scannerState.signals,
    activeOrder:  scannerState.activeOrder,
    config: {
      maxSpend:         MAX_SPEND,
      scoreMin:         SCORE_MIN,
      callsOnly:        CALLS_ONLY,
      cooldownMins:     parseInt(process.env.STARS_COOLDOWN_MINS || '30'),
      maxWeeklyTrades:  MAX_TRADES_PER_WEEK,
      paper:            process.env.PAPER_TRADING !== 'false',
    },
    weekly: {
      tradesThisWeek:   weeklyTrades.count,
      tradesRemaining:  Math.max(0, MAX_TRADES_PER_WEEK - weeklyTrades.count),
      limitHit:         scannerState.weeklyLimitHit || false,
      weekStart:        new Date(weeklyTrades.weekStart).toLocaleDateString(),
    },
  });
});

router.post('/scan-now', async (req, res) => {
  await runScan();
  res.json({ scanned: true, score: scannerState.currentScore, lastScan: scannerState.lastScan });
});

module.exports = router;
