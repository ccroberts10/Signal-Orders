// ============================================================================
// reversalScanner.js  — Reversal Entry Scanner with Alpaca 0DTE execution
// ============================================================================
// Wires into your existing OptionsManager and OrderManager.
// Does NOT duplicate broker/order logic — calls your existing infrastructure.
//
// Backtested win rates (6mo, 2.0 ATR stop, 30min hold):
//   GOOG 80%  META 70%  TSLA 73%  NVDA 61%
//
// Signal logic (all 4 gates required):
//   1. Liquidity sweep of prior swing low (wick below, close back above)
//   2. SPY 15m trend is bullish (price > 21 EMA)
//   3. MACD histogram fading from below-zero (momentum turning)
//   4. Supporting score >= 2/4 (RSI OS, vol spike, bull close, VWAP stretch)
//
// Execution on signal:
//   - Finds ATM 0DTE call via Alpaca options chain
//   - Buys 1 contract (suppScore 2-3) or 2 contracts (suppScore 4)
//   - Schedules a time-exit close at 30 minutes
//   - Sends Pushover notification
// ============================================================================

const https = require('https');

// ── Config ───────────────────────────────────────────────────────────────────
const CONFIG = {
  tickers:      ['GOOG', 'META', 'TSLA', 'NVDA'],
  spyTicker:    'SPY',
  sessionStart: '09:35',
  sessionEnd:   '15:30',
  pollMs:       30000,

  swLookback:   8,
  minSweepATR:  0.005,
  cooldownMs:   4 * 2 * 60 * 1000,

  trendEMALen:  21,
  macdFast:     12,
  macdSlow:     26,
  macdSigLen:   9,

  rsiLen:       7,
  rsiOS:        35,
  volLen:       20,
  volMult:      1.1,
  bullClose:    0.60,
  stretchATR:   0.40,
  atrLen:       14,

  timeExitMin:  30,
  slMult:       2.0,

  atmDeltaMin:  0.40,
  atmDeltaMax:  0.60,
  minOI:        10,
  maxSpreadPct: 0.15,

  contractsStandard:    1,
  contractsHighConv:    2,

  get paperTrading() { return process.env.PAPER_TRADING !== 'false'; },
};

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  running:         false,
  lastScan:        null,
  spyTrend:        null,
  tickers:         {},
  signals:         [],
  openPositions:   [],
  errors:          [],
};

for (const t of CONFIG.tickers) {
  state.tickers[t] = { lastSignalAt: null, conditions: {}, score: 0, signal: false };
}

// ── Lazy manager references ───────────────────────────────────────────────────
let _orderManager = null;
let _optionsFetcher = null;

function getOrderManager() {
  if (!_orderManager) {
    try {
      const { OrderManager } = require('./orderManager');
      _orderManager = new OrderManager({
        paperTrading: CONFIG.paperTrading,
        watchlist:    CONFIG.tickers,
      });
    } catch(e) {
      console.error('[reversal] OrderManager init failed:', e.message);
    }
  }
  return _orderManager;
}

function getOptionsFetcher() {
  if (!_optionsFetcher) {
    const om = getOrderManager();
    if (!om) return null;
    try {
      const { OptionsManager } = require('./optionsManager');
      const inst = new OptionsManager(om, { enabled: true });
      _optionsFetcher = inst.fetcher;
    } catch(e) {
      console.error('[reversal] OptionsManager init failed:', e.message);
    }
  }
  return _optionsFetcher;
}

// ── Polygon bar fetcher ───────────────────────────────────────────────────────
function polygonGet(path) {
  return new Promise((resolve, reject) => {
    const key = process.env.POLYGON_API_KEY;
    if (!key) return reject(new Error('POLYGON_API_KEY not set'));
    const url = `https://api.polygon.io${path}&apiKey=${key}`;
    https.get(url, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.status === 'ERROR') return reject(new Error(json.error || 'Polygon error'));
          resolve(json.results || []);
        } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function fetchBars(ticker, mult, span, from, to) {
  return polygonGet(
    `/v2/aggs/ticker/${ticker}/range/${mult}/${span}/${from}/${to}?adjusted=true&sort=asc&limit=500`
  );
}

// ── Date/time helpers ─────────────────────────────────────────────────────────
function toDateStr(d) { return d.toISOString().split('T')[0]; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

function isDST(d) {
  const jan = new Date(d.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(d.getFullYear(), 6, 1).getTimezoneOffset();
  return d.getTimezoneOffset() < Math.max(jan, jul);
}

function toET(ts) {
  const d = new Date(ts);
  return new Date(d.getTime() + (isDST(d) ? -4 : -5) * 3600000);
}

function timeStr(ts) {
  const e = toET(ts);
  return `${String(e.getUTCHours()).padStart(2,'0')}:${String(e.getUTCMinutes()).padStart(2,'0')}`;
}

function inSession() {
  const t = timeStr(Date.now());
  return t >= CONFIG.sessionStart && t <= CONFIG.sessionEnd;
}

function isWeekday() {
  const d = toET(Date.now());
  return d.getUTCDay() >= 1 && d.getUTCDay() <= 5;
}

// ── Indicators ────────────────────────────────────────────────────────────────
function calcEMA(vals, len) {
  const out = new Array(vals.length).fill(null);
  const k = 2 / (len + 1);
  let prev = null;
  for (let i = 0; i < vals.length; i++) {
    if (i < len - 1) continue;
    if (prev === null) {
      out[i] = vals.slice(i - len + 1, i + 1).reduce((a, b) => a + b, 0) / len;
    } else {
      out[i] = vals[i] * k + prev * (1 - k);
    }
    prev = out[i];
  }
  return out;
}

function calcATR(bars, len) {
  const tr = bars.map((b, i) => i === 0 ? b.h - b.l :
    Math.max(b.h - b.l, Math.abs(b.h - bars[i-1].c), Math.abs(b.l - bars[i-1].c)));
  const out = new Array(bars.length).fill(null);
  for (let i = len - 1; i < bars.length; i++) {
    out[i] = i === len - 1
      ? tr.slice(0, len).reduce((a, b) => a + b, 0) / len
      : (out[i-1] * (len - 1) + tr[i]) / len;
  }
  return out;
}

function calcRSI(closes, len) {
  const out = new Array(closes.length).fill(null);
  let ag = 0, al = 0;
  for (let i = 1; i <= len; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) ag += d / len; else al += Math.abs(d) / len;
  }
  out[len] = 100 - 100 / (1 + ag / (al || 0.0001));
  for (let i = len + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    ag = (ag * (len-1) + (d > 0 ? d : 0)) / len;
    al = (al * (len-1) + (d < 0 ? Math.abs(d) : 0)) / len;
    out[i] = 100 - 100 / (1 + ag / (al || 0.0001));
  }
  return out;
}

function calcMACD(closes, fast, slow, sigLen) {
  const ef  = calcEMA(closes, fast);
  const es  = calcEMA(closes, slow);
  const ml  = closes.map((_, i) => ef[i] != null && es[i] != null ? ef[i] - es[i] : null);
  const sig = calcEMA(ml.map(v => v ?? 0), sigLen);
  const hist = ml.map((v, i) => v != null && sig[i] != null ? v - sig[i] : null);
  return { hist };
}

function calcVWAP(bars) {
  const out = new Array(bars.length).fill(null);
  let cpv = 0, cv = 0, day = null;
  for (let i = 0; i < bars.length; i++) {
    const d = toET(bars[i].t).toISOString().split('T')[0];
    if (d !== day) { cpv = 0; cv = 0; day = d; }
    const tp = (bars[i].h + bars[i].l + bars[i].c) / 3;
    cpv += tp * bars[i].v; cv += bars[i].v;
    out[i] = cv > 0 ? cpv / cv : null;
  }
  return out;
}

function sma(arr, i, n) {
  if (i < n - 1) return null;
  return arr.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n;
}

function lowest(arr, i, n) {
  if (i < n) return null;
  return Math.min(...arr.slice(i - n, i));
}

// ── SPY 15m trend ─────────────────────────────────────────────────────────────
async function updateSpyTrend() {
  const today = new Date();
  const bars  = await fetchBars(CONFIG.spyTicker, 15, 'minute',
    toDateStr(addDays(today, -5)), toDateStr(today));
  if (!bars || bars.length < CONFIG.trendEMALen + 2) return;
  const closes = bars.map(b => b.c);
  const ema    = calcEMA(closes, CONFIG.trendEMALen);
  const last   = bars.length - 1;
  if (ema[last] == null) return;
  state.spyTrend = closes[last] > ema[last] ? 'bull' : 'bear';
}

// ── 0DTE ATM call finder ──────────────────────────────────────────────────────
async function find0DTECall(ticker) {
  const fetcher = getOptionsFetcher();
  if (!fetcher) throw new Error('OptionsChainFetcher unavailable — check ALPACA_KEY/ALPACA_SECRET');

  const today = toDateStr(new Date());
  const data  = await fetcher._fetch(
    `/v1beta1/options/snapshots/${ticker}?expiration_date_gte=${today}&expiration_date_lte=${today}&limit=200`
  );
  const snapshots = data.snapshots || {};

  if (!Object.keys(snapshots).length) {
    throw new Error(`No 0DTE chain for ${ticker}`);
  }

  const candidates = Object.entries(snapshots)
    .filter(([sym, snap]) => {
      const g = snap.greeks;
      const q = snap.latestQuote;
      if (!g || !q) return false;
      if (g.delta < CONFIG.atmDeltaMin || g.delta > CONFIG.atmDeltaMax) return false;
      const mid = (q.bp + q.ap) / 2;
      if (mid <= 0) return false;
      const spread = (q.ap - q.bp) / mid;
      if (spread > CONFIG.maxSpreadPct) return false;
      if ((snap.openInterest || 0) < CONFIG.minOI) return false;
      return true;
    })
    .map(([sym, snap]) => {
      const q      = snap.latestQuote;
      const mid    = (q.bp + q.ap) / 2;
      const strike = parseFloat(snap.details?.strike_price || '0');
      return {
        sym,
        mid,
        ask:     q.ap,
        strike,
        delta:   snap.greeks.delta,
        atmDist: Math.abs(snap.greeks.delta - 0.50),
      };
    })
    .sort((a, b) => a.atmDist - b.atmDist);

  if (!candidates.length) {
    throw new Error(`No ATM 0DTE call found for ${ticker} (delta ${CONFIG.atmDeltaMin}-${CONFIG.atmDeltaMax})`);
  }

  return candidates[0];
}

// ── Order placement via existing broker ───────────────────────────────────────
async function placeCallOrder(ticker, contract, contracts, signal) {
  const om = getOrderManager();
  if (!om) throw new Error('OrderManager unavailable');

  const limitPrice = parseFloat((contract.ask * 1.01).toFixed(2));

  const orderParams = {
    symbol:        contract.sym,
    qty:           contracts.toString(),
    side:          'buy',
    type:          'limit',
    time_in_force: 'day',
    limit_price:   limitPrice.toFixed(2),
  };

  console.log(`[reversal] Submitting ${contracts}x ${contract.sym} @ $${limitPrice}`);
  const order = await om.broker.submitOrder(orderParams);

  if (om.log?.logOrder) {
    om.log.logOrder({
      ...orderParams,
      orderId:    order.id,
      strategy:   'REVERSAL_CALL',
      underlying: ticker,
    });
  }

  // Schedule time exit
  setTimeout(() => closePosition(contract.sym, ticker), CONFIG.timeExitMin * 60 * 1000);

  state.openPositions.push({
    contractSym: contract.sym,
    underlying:  ticker,
    orderId:     order.id,
    openedAt:    new Date().toISOString(),
    exitBy:      signal.exitBy,
    contracts,
    entry:       signal.entry,
    t1:          signal.t1,
    sl:          signal.sl,
  });

  return order;
}

// ── Time exit ─────────────────────────────────────────────────────────────────
async function closePosition(contractSym, underlying) {
  console.log(`[reversal] Time exit: ${contractSym}`);
  const om = getOrderManager();
  if (!om) return;

  try {
    const position = await om.broker.getPosition(contractSym).catch(() => null);
    if (!position) {
      console.log(`[reversal] ${contractSym} already closed`);
      return;
    }
    const qty = Math.abs(parseInt(position.qty));
    if (qty <= 0) return;

    await om.broker.submitOrder({
      symbol: contractSym, qty: qty.toString(),
      side: 'sell', type: 'market', time_in_force: 'day',
    });

    console.log(`[reversal] Time exit placed: ${qty}x ${contractSym}`);
    sendPushover(
      `⏱ ${underlying} — Time Exit`,
      `Closed ${contractSym}\n${qty} contract${qty>1?'s':''} — 30min exit`
    );
    state.openPositions = state.openPositions.filter(p => p.contractSym !== contractSym);
  } catch(e) {
    console.error(`[reversal] Time exit failed ${contractSym}:`, e.message);
    addError(underlying, `Time exit failed: ${e.message}`);
  }
}

// ── Pushover ──────────────────────────────────────────────────────────────────
function sendPushover(title, message) {
  const token = process.env.PUSHOVER_TOKEN;
  const user  = process.env.PUSHOVER_USER;
  if (!token || !user) return;
  const body = JSON.stringify({ token, user, title, message, priority: 1 });
  const req  = https.request({
    hostname: 'api.pushover.net', path: '/1/messages.json', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, res => console.log(`[reversal] Pushover ${res.statusCode}`));
  req.on('error', e => console.error('[reversal] Pushover:', e.message));
  req.write(body); req.end();
}

function addError(ticker, msg) {
  state.errors.unshift({ ts: new Date().toISOString(), ticker, msg });
  if (state.errors.length > 10) state.errors.pop();
}

// ── Scan one ticker ───────────────────────────────────────────────────────────
async function scanTicker(ticker) {
  const today = new Date();
  const raw   = await fetchBars(ticker, 2, 'minute',
    toDateStr(addDays(today, -3)), toDateStr(today));
  if (!raw || raw.length < 60) return;

  const bars   = raw.map(b => ({ t:b.t, o:b.o, h:b.h, l:b.l, c:b.c, v:b.v }));
  const closes = bars.map(b => b.c);
  const lows   = bars.map(b => b.l);
  const vols   = bars.map(b => b.v);

  const atrArr   = calcATR(bars, CONFIG.atrLen);
  const rsiArr   = calcRSI(closes, CONFIG.rsiLen);
  const vwapArr  = calcVWAP(bars);
  const { hist } = calcMACD(closes, CONFIG.macdFast, CONFIG.macdSlow, CONFIG.macdSigLen);

  const warmup = Math.max(CONFIG.atrLen, CONFIG.macdSlow + CONFIG.macdSigLen, CONFIG.volLen) + 5;
  const i = bars.length - 2;
  if (i < warmup) return;

  const bar  = bars[i];
  const atr  = atrArr[i];
  const rsi  = rsiArr[i];
  const vwap = vwapArr[i];
  const mh   = hist[i], mh1 = hist[i-1], mh2 = hist[i-2];

  if (!atr || !rsi || mh == null || mh1 == null || mh2 == null) return;

  const volAvg   = sma(vols, i, CONFIG.volLen);
  const priorLow = lowest(lows, i, CONFIG.swLookback);
  if (!volAvg || priorLow == null) return;

  const rangeVal = Math.max(bar.h - bar.l, 0.01);
  const closeLoc = (bar.c - bar.l) / rangeVal;

  const sweepOK   = bar.l < priorLow && (priorLow - bar.l) >= atr * CONFIG.minSweepATR && bar.c > priorLow;
  const trendOK   = state.spyTrend === 'bull';
  const macdOK    = mh < 0 && mh > mh1 && mh1 < mh2;
  const s_rsi     = rsi <= CONFIG.rsiOS;
  const s_vol     = vols[i] >= volAvg * CONFIG.volMult;
  const s_close   = closeLoc >= CONFIG.bullClose;
  const s_vwap    = vwap != null && bar.l <= vwap - atr * CONFIG.stretchATR;
  const suppScore = (s_rsi?1:0) + (s_vol?1:0) + (s_close?1:0) + (s_vwap?1:0);
  const suppOK    = suppScore >= 2;

  const ts = state.tickers[ticker];
  ts.conditions = {
    sweep: sweepOK, trend: trendOK, macd: macdOK, supp: suppOK,
    suppScore, s_rsi, s_vol, s_close, s_vwap,
    rsi: rsi?.toFixed(1), atr: atr?.toFixed(3),
    price: bar.c?.toFixed(2), vwap: vwap?.toFixed(2),
  };
  ts.score  = (sweepOK?1:0) + (trendOK?1:0) + (macdOK?1:0) + (suppOK?1:0);
  ts.signal = false;

  if (!sweepOK || !trendOK || !macdOK || !suppOK) return;
  if (ts.lastSignalAt && (Date.now() - ts.lastSignalAt) < CONFIG.cooldownMs) return;

  ts.signal       = true;
  ts.lastSignalAt = Date.now();

  const entry    = bar.c;
  const t1       = (entry + atr * 1.0).toFixed(2);
  const t2       = (entry + atr * 2.0).toFixed(2);
  const sl       = (entry - atr * CONFIG.slMult).toFixed(2);
  const etNow    = toET(Date.now());
  const exitTime = new Date(etNow.getTime() + CONFIG.timeExitMin * 60000);
  const exitStr  = `${String(exitTime.getUTCHours()).padStart(2,'0')}:${String(exitTime.getUTCMinutes()).padStart(2,'0')}`;

  const signal = {
    ticker, ts: new Date().toISOString(),
    entry: entry.toFixed(2), t1, t2, sl,
    atr: atr.toFixed(3), suppScore, spyTrend: state.spyTrend, exitBy: exitStr,
  };

  state.signals.unshift(signal);
  if (state.signals.length > 50) state.signals.pop();

  console.log(`[reversal] ★ ${ticker} signal @ $${entry.toFixed(2)} supp:${suppScore}/4 — finding 0DTE call...`);

  try {
    const contract  = await find0DTECall(ticker);
    const contracts = suppScore >= 4 ? CONFIG.contractsHighConv : CONFIG.contractsStandard;
    const cost      = (contract.ask * 100 * contracts).toFixed(0);
    const hc        = suppScore >= 4 ? ' ★★ HI-CONV' : '';
    const mode      = CONFIG.paperTrading ? 'PAPER' : 'LIVE';

    const order = await placeCallOrder(ticker, contract, contracts, signal);

    console.log(`[reversal] ${mode} order: ${contracts}x ${contract.sym} @ $${contract.ask.toFixed(2)} ~$${cost}`);

    sendPushover(
      `★ ${ticker} CALL ${mode}${hc}`,
      `Contract: ${contract.sym}\n` +
      `${contracts}x @ $${contract.ask.toFixed(2)} (~$${cost})\n` +
      `Delta: ${contract.delta.toFixed(2)}  Strike: $${contract.strike}\n` +
      `Stock: $${entry.toFixed(2)} → T1 $${t1}\n` +
      `Stop: $${sl}  (2.0 ATR)\n` +
      `Supp: ${suppScore}/4${s_rsi?' RSI':''}${s_vol?' VOL':''}${s_vwap?' VWAP':''}\n` +
      `SPY: BULL\n` +
      `Auto-exit: ${exitStr} ET\n` +
      `Order: ${order.id}`
    );

    signal.contractSym = contract.sym;
    signal.contracts   = contracts;
    signal.premium     = contract.ask.toFixed(2);
    signal.orderId     = order.id;
    signal.cost        = cost;

  } catch(e) {
    console.error(`[reversal] Order failed ${ticker}:`, e.message);
    addError(ticker, e.message);

    sendPushover(
      `★ ${ticker} SIGNAL — ORDER FAILED`,
      `Signal fired but order failed:\n${e.message}\n\nEntry: $${entry.toFixed(2)}  T1: $${t1}  SL: $${sl}`
    );
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────
async function scan() {
  if (!isWeekday() || !inSession()) return;
  state.lastScan = new Date().toISOString();

  try { await updateSpyTrend(); }
  catch(e) { console.error('[reversal] SPY trend error:', e.message); }

  for (const ticker of CONFIG.tickers) {
    try {
      await scanTicker(ticker);
      await new Promise(r => setTimeout(r, 2000));
    } catch(e) {
      console.error(`[reversal] ${ticker}:`, e.message);
      addError(ticker, e.message);
    }
  }
}

function getState() {
  return {
    running:       state.running,
    lastScan:      state.lastScan,
    spyTrend:      state.spyTrend,
    inSession:     isWeekday() && inSession(),
    paperTrading:  CONFIG.paperTrading,
    tickers:       state.tickers,
    signals:       state.signals.slice(0, 20),
    openPositions: state.openPositions,
    errors:        state.errors,
  };
}

function start() {
  if (state.running) return;
  state.running = true;
  console.log(`[reversal] Started (${CONFIG.paperTrading ? 'PAPER' : 'LIVE'}) — ${CONFIG.tickers.join(', ')}`);
  scan().catch(e => console.error('[reversal] Initial scan error:', e.message));
  setInterval(() => scan().catch(e => console.error('[reversal] Scan error:', e.message)), CONFIG.pollMs);
}

module.exports = { start, getState };
