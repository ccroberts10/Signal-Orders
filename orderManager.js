/**
 * SIGNAL Order Manager — V4 Configuration
 * Backtested best performer: +34.64% return, -15.22% max drawdown, 46.4% win rate
 *
 * V4 Features:
 *   - Market regime filter (SPY EMA check — no buys in risk-off)
 *   - Score trending filter (two consecutive 75+ scores required)
 *   - Conviction-based position sizing (score 90-100→15%, 80-89→12%, 75-79→8%)
 *   - Volatility-tiered trailing stops (large 8%, mid 10%, small 15%)
 *   - Sector concentration limit (max 2 per sector)
 *   - Earnings blackout extended to 10 days
 *   - Take profit: 10% gain + score drops below 60
 *   - No-buy list: SPY, QQQ (scored but never bought)
 */

const EventEmitter = require('events');
const fs           = require('fs');
const path         = require('path');

// Persistent storage for peak prices — survives Railway restarts
const PEAKS_FILE = process.env.PEAKS_FILE || '/data/peaks.json';

function loadPeaks() {
  try {
    console.log('[ORDER-MGR] Looking for peaks file at:', PEAKS_FILE);
    if (fs.existsSync(PEAKS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PEAKS_FILE, 'utf8'));
      console.log('[ORDER-MGR] ✓ Loaded peak prices from disk:', JSON.stringify(data));
      return data;
    } else {
      console.warn('[ORDER-MGR] ✗ Peaks file not found at', PEAKS_FILE, '— starting fresh');
    }
  } catch (e) {
    console.warn('[ORDER-MGR] Could not load peak prices:', e.message);
  }
  return {};
}

function savePeaks(peaks) {
  try {
    const dir = path.dirname(PEAKS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log('[ORDER-MGR] Created directory:', dir);
    }
    fs.writeFileSync(PEAKS_FILE, JSON.stringify(peaks, null, 2));
    console.log('[ORDER-MGR] ✓ Saved peaks to disk:', PEAKS_FILE);
  } catch (e) {
    console.warn('[ORDER-MGR] Could not save peak prices:', e.message);
  }
}



// ─── Config ───────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  broker:       'alpaca',
  paperTrading: true,
  watchlist:    (process.env.WATCHLIST || 'AAPL,NVDA,TSLA,META,AMD,SPY,QQQ,MSFT,GOOGL,AMZN,VICR,RMBS,ATOM,MU,MRVL,AAOI,METC,VIAV,OPTX,MXL,NOK,FCEL').split(',').map(s => s.trim()),

  // Signal thresholds
  buyThreshold:  75,
  sellThreshold: 35,
  holdZone:      [36, 74],

  // No-buy list — scored and displayed but never bought
  noBuyList: ['SPY', 'QQQ'],

  // Conviction-based position sizing
  positionSizing: {
    high:   0.15,   // Score 90-100
    medium: 0.12,   // Score 80-89
    low:    0.08,   // Score 75-79
  },

  // Volatility-tiered trailing stops
  trailingStops: {
    large: 0.08,    // AAPL, MSFT, GOOGL, AMZN, META, NVDA
    mid:   0.10,    // MRVL, MU, AMD, TSLA, RMBS
    small: 0.15,    // METC, POET, ATOM, AAOI, VIAV, VICR
  },

  // Ticker volatility tiers
    // Volatility tiers — override via Railway env vars
  // LARGE_CAPS=AAPL,MSFT,GOOGL,AMZN,META,NVDA,SPY,QQQ
  // SMALL_CAPS=METC,POET,ATOM,AAOI,VIAV,VICR,OPTX,FCEL
  // Everything else defaults to mid tier
  volatilityTierOverrides: {
    large: (process.env.LARGE_CAPS || 'AAPL,MSFT,GOOGL,AMZN,META,NVDA,SPY,QQQ').split(',').map(s=>s.trim()),
    small: (process.env.SMALL_CAPS || 'METC,ATOM,AAOI,VIAV,VICR,OPTX,FCEL').split(',').map(s=>s.trim()),
  },

  // Sector mapping for concentration limit
  // Sectors — override via Railway env var
  // SECTOR_MAP=AAPL:tech,NVDA:semis,TSLA:ev,NOK:telecom,FCEL:energy
  // Tickers not listed default to 'unknown' (no sector limit applied)
  sectorMapRaw: process.env.SECTOR_MAP || 'AAPL:tech,MSFT:tech,GOOGL:tech,AMZN:tech,META:tech,NVDA:semis,AMD:semis,MU:semis,MRVL:semis,RMBS:semis,MXL:semis,TSLA:ev,SPY:etf,QQQ:etf,ATOM:biotech,OPTX:biotech,VICR:power,AAOI:photonics,VIAV:photonics,METC:coal,NOK:telecom,FCEL:energy',

  maxPerSector:         2,     // Max 2 positions per sector
  maxOpenPositions:     parseInt(process.env.MAX_POSITIONS || '6'),  // Max concurrent positions

  // Order execution
  defaultOrderType:  'limit',
  limitSlippagePct:  0.002,
  maxSpreadPct:      0.02,

  // Risk controls
  dailyLossLimitPct:    0.03,   // Halt if down 3% on the day
  earningsBlackoutDays: 10,     // No new positions within 10 days of earnings
  haltOnUnknownError:   true,

  // Take profit
  takeProfitPct:       0.10,   // 10% gain triggers TP check
  takeProfitScoreDrop: 60,     // Sell if up 10%+ AND score drops below 60

  // Options
  enableOptions:      process.env.OPTIONS_ENABLED === 'true',
  defaultOptionsDTE:  30,
  defaultOptionsDelta: 0.30,

  // Logging
  logLevel: 'info',
};

// ─── Logger ───────────────────────────────────────────────────────────────────

class Logger {
  constructor(level = 'info') {
    this.levels = { debug: 0, info: 1, warn: 2, error: 3 };
    this.level  = level;
  }

  _log(level, message, meta = {}) {
    if (this.levels[level] < this.levels[this.level]) return;
    const entry = { ts: new Date().toISOString(), level: level.toUpperCase(), message, ...meta };
    console.log(JSON.stringify(entry));
    return entry;
  }

  debug(msg, meta) { return this._log('debug', msg, meta); }
  info(msg, meta)  { return this._log('info',  msg, meta); }
  warn(msg, meta)  { return this._log('warn',  msg, meta); }
  error(msg, meta) { return this._log('error', msg, meta); }
}

// ─── Trade Log ────────────────────────────────────────────────────────────────

class TradeLog {
  constructor() {
    this.decisions = [];
    this.orders    = [];
    this.fills     = [];
  }

  logDecision(ticker, score, action, reason) {
    const entry = { ts: new Date().toISOString(), ticker, score, action, reason };
    this.decisions.push(entry);
    return entry;
  }

  logOrder(order) {
    const entry = { ts: new Date().toISOString(), ...order };
    this.orders.push(entry);
    return entry;
  }

  logFill(fill) {
    const entry = { ts: new Date().toISOString(), ...fill };
    this.fills.push(entry);
    return entry;
  }

  summary() {
    return {
      totalDecisions: this.decisions.length,
      totalOrders:    this.orders.length,
      totalFills:     this.fills.length,
      buys:  this.orders.filter(o => o.side === 'buy').length,
      sells: this.orders.filter(o => o.side === 'sell').length,
    };
  }
}

// ─── Alpaca Broker Adapter ────────────────────────────────────────────────────

class AlpacaAdapter {
  constructor(config) {
    this.paper   = config.paperTrading;
    this.baseUrl = this.paper
      ? 'https://paper-api.alpaca.markets'
      : 'https://api.alpaca.markets';
    this.dataUrl = 'https://data.alpaca.markets';
    this.headers = {
      'APCA-API-KEY-ID':     process.env.ALPACA_KEY,
      'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET,
      'Content-Type': 'application/json',
    };
  }

  async _fetch(method, path, body = null, base = null) {
    const url  = `${base || this.baseUrl}${path}`;
    const opts = { method, headers: this.headers };
    if (body) opts.body = JSON.stringify(body);

    // 10 second timeout to prevent hanging dashboard
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 10000);
    opts.signal      = controller.signal;

    try {
      const res = await fetch(url, opts);
      clearTimeout(timeout);
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Alpaca ${method} ${path} → ${res.status}: ${err}`);
      }
      return res.json();
    } catch (e) {
      clearTimeout(timeout);
      if (e.name === 'AbortError') throw new Error(`Alpaca ${method} ${path} → timeout after 10s`);
      throw e;
    }
  }

  async getAccount()        { return this._fetch('GET', '/v2/account'); }
  async getAllPositions()    { return this._fetch('GET', '/v2/positions'); }
  async getOrders(status)   { return this._fetch('GET', `/v2/orders?status=${status}`); }
  async cancelAllOrders()   { return this._fetch('DELETE', '/v2/orders'); }
  async submitOrder(params) { return this._fetch('POST', '/v2/orders', params); }

  async getPosition(symbol) {
    try { return await this._fetch('GET', `/v2/positions/${symbol}`); }
    catch (e) { if (e.message.includes('404')) return null; throw e; }
  }

  async getLatestQuote(symbol) {
    const data = await this._fetch('GET', `/v2/stocks/${symbol}/quotes/latest`, null, this.dataUrl);
    return data.quote;
  }

  async isMarketOpen() {
    const clock = await this._fetch('GET', '/v2/clock');
    return clock.is_open;
  }

  // Fetch SPY price + EMAs for market regime check
  async getSPYRegime() {
    try {
      const end   = new Date().toISOString().split('T')[0];
      const start = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const data  = await this._fetch('GET', `/v2/stocks/SPY/bars?timeframe=1Day&start=${start}&end=${end}&limit=60&feed=iex`, null, this.dataUrl);
      const bars  = data.bars || [];
      if (bars.length < 50) return { riskOn: true, reason: 'insufficient SPY data' };

      const closes = bars.map(b => b.c);
      const price  = closes[closes.length - 1];

      // EMA calculation
      const calcEMA = (values, period) => {
        if (values.length < period) return null;
        const k = 2 / (period + 1);
        let val = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
        for (let i = period; i < values.length; i++) val = values[i] * k + val * (1 - k);
        return val;
      };

      const ema20 = calcEMA(closes, 20);
      const ema50 = calcEMA(closes, Math.min(50, closes.length));

      const riskOn = price > ema20 && price > ema50;
      return {
        riskOn,
        spyPrice: price,
        ema20:    ema20?.toFixed(2),
        ema50:    ema50?.toFixed(2),
        reason:   riskOn
          ? `SPY $${price.toFixed(2)} above EMA20 $${ema20?.toFixed(2)} and EMA50 $${ema50?.toFixed(2)}`
          : `SPY $${price.toFixed(2)} below EMAs — RISK OFF`,
      };
    } catch (e) {
      return { riskOn: true, reason: `SPY regime check failed: ${e.message}` };
    }
  }
}

// ─── Order Manager ────────────────────────────────────────────────────────────

class OrderManager extends EventEmitter {
  constructor(userConfig = {}) {
    super();
    this.config     = { ...DEFAULT_CONFIG, ...userConfig };
    this.logger     = new Logger(this.config.logLevel);
    this.log        = new TradeLog();
    this.halted     = false;
    this.haltReason = null;
    this.portfolioValueAtOpen = null;

    // Peak price tracking per position: { TICKER: { peakPrice, entryPrice, entryDate } }
    this.positionPeaks = loadPeaks(); // Persisted across restarts

    // Score history for trending filter: { TICKER: [score1, score2, ...] }
    this.scoreHistory = {};

    // Cached market regime (updated each poll cycle)
    this.marketRegime = { riskOn: true, reason: 'initializing', lastChecked: null };

    if (this.config.broker === 'alpaca') {
      this.broker = new AlpacaAdapter(this.config);
    } else {
      throw new Error(`Broker '${this.config.broker}' not implemented.`);
    }

    this.logger.info('OrderManager V4 initialized', {
      broker:           this.config.broker,
      paper:            this.config.paperTrading,
      watchlist:        this.config.watchlist,
      noBuyList:        this.config.noBuyList,
      positionSizing:   '90+→15% | 80-89→12% | 75-79→8%',
      trailingStops:    'large=8% | mid=10% | small=15%',
      takeProfitAt:     `${this.config.takeProfitPct*100}% gain + score < ${this.config.takeProfitScoreDrop}`,
      earningsBlackout: `${this.config.earningsBlackoutDays} days`,
      maxPerSector:     this.config.maxPerSector,
    });

    if (this.config.paperTrading) {
      this.logger.warn('PAPER TRADING MODE — no real money at risk');
    }

    // Reconcile peaks with live positions after a short delay (broker may not be ready instantly)
    setTimeout(() => this._reconcilePeaks().catch(e => this.logger.warn('Peak reconcile error:', e.message)), 5000);
  }

  // ── Volatility Tier Helpers ───────────────────────────────────────────────────

  _getTier(ticker) {
    const overrides = this.config.volatilityTierOverrides;
    if (overrides.large.includes(ticker)) return 'large';
    if (overrides.small.includes(ticker)) return 'small';
    return 'mid'; // default — safe middle ground
  }

  _getSector(ticker) {
    if (!this._sectorMap) {
      this._sectorMap = {};
      (this.config.sectorMapRaw || '').split(',').forEach(pair => {
        const [sym, sec] = pair.trim().split(':');
        if (sym && sec) this._sectorMap[sym.trim()] = sec.trim();
      });
    }
    return this._sectorMap[ticker] || 'unknown';
  }

  _getTrailingStop(ticker) {
    return this.config.trailingStops[this._getTier(ticker)];
  }

  _getPositionSize(score) {
    if (score >= 90) return this.config.positionSizing.high;
    if (score >= 80) return this.config.positionSizing.medium;
    return this.config.positionSizing.low;
  }

  // ── Score Trending Filter ─────────────────────────────────────────────────────

  _updateScoreHistory(ticker, score) {
    if (!this.scoreHistory[ticker]) this.scoreHistory[ticker] = [];
    this.scoreHistory[ticker].push(score);
    if (this.scoreHistory[ticker].length > 5) this.scoreHistory[ticker].shift();
  }

  _isTrendingUp(ticker) {
    const history = this.scoreHistory[ticker];
    if (!history || history.length < 2) return false;
    const last = history[history.length - 1];
    const prev = history[history.length - 2];
    return last >= this.config.buyThreshold && prev >= this.config.buyThreshold;
  }

  // ── Sector Concentration Check ────────────────────────────────────────────────

  async _getSectorCount(sector) {
    const positions = await this.broker.getAllPositions();
    return positions.filter(p => this._getSector(p.symbol) === sector).length;
  }

  // ── Market Regime Check ───────────────────────────────────────────────────────

  async _refreshMarketRegime() {
    const now = Date.now();
    // Refresh at most once per hour
    if (this.marketRegime.lastChecked && now - this.marketRegime.lastChecked < 60 * 60 * 1000) {
      return this.marketRegime;
    }
    const regime = await this.broker.getSPYRegime();
    this.marketRegime = { ...regime, lastChecked: now };
    this.logger.info('Market regime updated', { riskOn: regime.riskOn, reason: regime.reason });
    return this.marketRegime;
  }

  // ── Peak Reconciliation — seeds missing peaks from live positions ──────────────

  async _reconcilePeaks() {
    try {
      const positions = await this.broker.getAllPositions();
      let changed = false;
      for (const pos of positions) {
        const sym   = pos.symbol;
        const price = parseFloat(pos.current_price);
        const entry = parseFloat(pos.avg_entry_price);
        if (!this.positionPeaks[sym]) {
          // Missing peak — use the HIGHER of current price or entry price
          // This prevents stops from being too loose after a restart
          const seedPrice = Math.max(price, entry);
          this.positionPeaks[sym] = { peakPrice: seedPrice, entryPrice: entry, entryDate: new Date().toISOString() };
          this.logger.warn(`Peak seeded for ${sym} at $${seedPrice.toFixed(2)} (restart recovery — current: $${price.toFixed(2)}, entry: $${entry.toFixed(2)})`);
          changed = true;
        } else {
          // Peak exists from file — verify it's not lower than current price
          if (price > this.positionPeaks[sym].peakPrice) {
            this.positionPeaks[sym].peakPrice = price;
            changed = true;
          }
          this.logger.info(`Peak loaded for ${sym}: $${this.positionPeaks[sym].peakPrice.toFixed(2)} (current: $${price.toFixed(2)})`);
        }
      }
      // Remove peaks for positions that no longer exist
      const activeSymbols = positions.map(p => p.symbol);
      for (const sym of Object.keys(this.positionPeaks)) {
        if (!activeSymbols.includes(sym)) {
          delete this.positionPeaks[sym];
          this.logger.info(`Peak cleared for ${sym} — no longer held`);
          changed = true;
        }
      }
      if (changed) savePeaks(this.positionPeaks);
      this.logger.info('Peak reconciliation complete', { peaks: JSON.stringify(this.positionPeaks) });
    } catch (e) {
      this.logger.warn('Peak reconciliation failed (non-fatal):', e.message);
    }
  }

  // ── Kill Switch ───────────────────────────────────────────────────────────────

  async halt(reason) {
    this.halted     = true;
    this.haltReason = reason;
    this.logger.error('HALT TRIGGERED', { reason });
    this.emit('halt', { reason });
    try {
      await this.broker.cancelAllOrders();
      this.logger.info('All open orders cancelled after halt');
    } catch (e) {
      this.logger.error('Failed to cancel orders during halt', { error: e.message });
    }
  }

  resume() {
    this.halted     = false;
    this.haltReason = null;
    this.logger.info('Trading resumed');
    this.emit('resume');
  }

  // ── Market Open Check ─────────────────────────────────────────────────────────

  async assertMarketOpen() {
    const open = await this.broker.isMarketOpen();
    if (!open) throw new Error('Market is closed');
    return true;
  }

  // ── Quote & Spread Validation ─────────────────────────────────────────────────

  async getValidatedQuote(symbol) {
    const quote  = await this.broker.getLatestQuote(symbol);
    const bid    = parseFloat(quote.bp);
    const ask    = parseFloat(quote.ap);
    const mid    = (bid + ask) / 2;
    const spread = (ask - bid) / mid;

    if (spread > this.config.maxSpreadPct) {
      throw new Error(`Spread too wide for ${symbol}: ${(spread * 100).toFixed(2)}%`);
    }
    return { bid, ask, mid, spread };
  }

  // ── Position Sizing ───────────────────────────────────────────────────────────

  async calculateShares(symbol, score) {
    const account     = await this.broker.getAccount();
    const equity      = parseFloat(account.equity);
    const positionPct = this._getPositionSize(score);
    const maxDollar   = equity * positionPct;
    const { mid }     = await this.getValidatedQuote(symbol);

    // Support fractional shares — round to 6 decimal places
    const sharesRaw  = maxDollar / mid;
    const shares     = sharesRaw >= 1
      ? Math.floor(sharesRaw)                          // whole shares for expensive stocks
      : parseFloat(sharesRaw.toFixed(6));               // fractional for small accounts

    if (shares <= 0) throw new Error(`Position size rounds to 0 shares for ${symbol} at $${mid.toFixed(2)}`);
    this.logger.debug('Position size', { symbol, score, positionPct, maxDollar, mid, shares, fractional: shares < 1 });
    return { shares, positionPct };
  }

  // ── Daily Loss Limit ──────────────────────────────────────────────────────────

  async checkDailyLossLimit() {
    if (!this.portfolioValueAtOpen) {
      const account = await this.broker.getAccount();
      this.portfolioValueAtOpen = parseFloat(account.last_equity);
    }
    const account = await this.broker.getAccount();
    const current = parseFloat(account.equity);
    const pnlPct  = (current - this.portfolioValueAtOpen) / this.portfolioValueAtOpen;

    if (pnlPct < -this.config.dailyLossLimitPct) {
      await this.halt(`Daily loss limit breached: ${(pnlPct * 100).toFixed(2)}%`);
      return false;
    }
    return true;
  }

  // ── Exit Rules (Trailing Stop + Take Profit) ──────────────────────────────────

  async checkExitRules(ticker, signalScore, position) {
    const currentPrice = parseFloat(position.current_price);
    const entryPrice   = parseFloat(position.avg_entry_price);
    const gainPct      = (currentPrice - entryPrice) / entryPrice;

    // Update peak tracking
    if (!this.positionPeaks[ticker]) {
      this.positionPeaks[ticker] = { peakPrice: currentPrice, entryPrice, entryDate: new Date().toISOString() };
    }
    if (currentPrice > this.positionPeaks[ticker].peakPrice) {
      this.positionPeaks[ticker].peakPrice = currentPrice;
      savePeaks(this.positionPeaks); // Persist immediately
    }

    const peakPrice    = this.positionPeaks[ticker].peakPrice;
    const dropFromPeak = (peakPrice - currentPrice) / peakPrice;
    const trailingStop = this._getTrailingStop(ticker);
    const tier         = this._getTier(ticker);

    this.logger.debug('Exit rules check', {
      ticker, tier, currentPrice, entryPrice, peakPrice,
      gainPct:      (gainPct * 100).toFixed(2) + '%',
      dropFromPeak: (dropFromPeak * 100).toFixed(2) + '%',
      trailingStop: (trailingStop * 100).toFixed(0) + '%',
      signalScore,
    });

    // Trailing stop — tiered by volatility
    if (dropFromPeak >= trailingStop) {
      const reason = `Trailing stop [${tier}]: dropped ${(dropFromPeak * 100).toFixed(1)}% from peak $${peakPrice.toFixed(2)} (stop=${(trailingStop*100).toFixed(0)}%)`;
      this.logger.warn('TRAILING STOP TRIGGERED', { ticker, tier, dropFromPeak, peakPrice, currentPrice });
      return { shouldExit: true, reason, exitType: 'TRAILING_STOP' };
    }

    // Take profit — 10% gain + score below 60
    if (gainPct >= this.config.takeProfitPct && signalScore < this.config.takeProfitScoreDrop) {
      const reason = `Take profit: up ${(gainPct * 100).toFixed(1)}% and score ${signalScore} < ${this.config.takeProfitScoreDrop}`;
      this.logger.info('TAKE PROFIT TRIGGERED', { ticker, gainPct, signalScore });
      return { shouldExit: true, reason, exitType: 'TAKE_PROFIT' };
    }

    return { shouldExit: false };
  }

  // ── Core Evaluate ─────────────────────────────────────────────────────────────

  async evaluate(ticker, signalScore, meta = {}) {
    // Update score history for trending filter
    this._updateScoreHistory(ticker, signalScore);

    // Guard: halted
    if (this.halted) {
      this.logger.warn('Skipping — system halted', { ticker });
      return { action: 'HALTED', ticker, signalScore };
    }

    // Guard: watchlist
    if (!this.config.watchlist.includes(ticker)) {
      this.logger.warn('Not in watchlist — skipping', { ticker });
      return { action: 'SKIP', ticker, reason: 'not_in_watchlist' };
    }

    // Guard: market open
    try { await this.assertMarketOpen(); }
    catch (e) { return { action: 'SKIP', ticker, reason: 'market_closed' }; }

    // Guard: daily loss limit
    const withinLoss = await this.checkDailyLossLimit();
    if (!withinLoss) return { action: 'HALTED', ticker, reason: 'daily_loss_limit' };

    // Guard: earnings blackout
    if (meta.earnings_date) {
      const daysToEarnings = Math.floor(
        (new Date(meta.earnings_date) - new Date()) / (1000 * 60 * 60 * 24)
      );
      if (daysToEarnings >= 0 && daysToEarnings <= this.config.earningsBlackoutDays) {
        const reason = `Earnings blackout: ${daysToEarnings}d to earnings`;
        this.log.logDecision(ticker, signalScore, 'HOLD', reason);
        return { action: 'HOLD', ticker, signalScore, reason };
      }
    }

    // Check exit rules on existing positions first
    const existingPosition = await this.broker.getPosition(ticker);
    if (existingPosition) {
      const exitCheck = await this.checkExitRules(ticker, signalScore, existingPosition);
      if (exitCheck.shouldExit) {
        this.log.logDecision(ticker, signalScore, 'SELL', exitCheck.reason);
        this.emit('decision', { ticker, signalScore, action: 'SELL', reason: exitCheck.reason });
        return this._executeSell(ticker, signalScore, meta, exitCheck.exitType);
      }
    }

    // Standard score-based decision
    let action, reason;

    if (signalScore >= this.config.buyThreshold) {
      action = 'BUY';
      reason = `Score ${signalScore} >= buy threshold ${this.config.buyThreshold}`;
    } else if (signalScore <= this.config.sellThreshold) {
      action = 'SELL';
      reason = `Score ${signalScore} <= sell threshold ${this.config.sellThreshold}`;
    } else {
      action = 'HOLD';
      reason = `Score ${signalScore} in hold zone [${this.config.holdZone.join('-')}]`;
    }

    this.log.logDecision(ticker, signalScore, action, reason);
    this.logger.info('Decision', { ticker, signalScore, action, reason });
    this.emit('decision', { ticker, signalScore, action, reason });

    if (action === 'BUY')  return this._executeBuy(ticker, signalScore, meta);
    if (action === 'SELL') return this._executeSell(ticker, signalScore, meta);
    return { action: 'HOLD', ticker, signalScore, reason };
  }

  // ── Buy Execution ─────────────────────────────────────────────────────────────

  async _executeBuy(ticker, signalScore, meta) {
    try {
      // No-buy list
      if (this.config.noBuyList.includes(ticker)) {
        this.logger.info('Ticker on no-buy list — skipping', { ticker });
        return { action: 'SKIP', ticker, reason: 'no_buy_list' };
      }

      // Already have position
      const existing = await this.broker.getPosition(ticker);
      if (existing) {
        this.logger.info('Already have a position — skipping buy', { ticker, qty: existing.qty });
        return { action: 'SKIP', ticker, reason: 'already_have_position' };
      }

      // Market regime filter — no buys in risk-off market
      const regime = await this._refreshMarketRegime();
      if (!regime.riskOn) {
        this.logger.warn('Market regime RISK OFF — skipping buy', { ticker, reason: regime.reason });
        return { action: 'SKIP', ticker, reason: `risk_off: ${regime.reason}` };
      }

      // Score trending filter — must score 75+ on two consecutive scans
      if (!this._isTrendingUp(ticker)) {
        this.logger.info('Score not trending up — skipping buy', { ticker, history: this.scoreHistory[ticker] });
        return { action: 'SKIP', ticker, reason: 'score_not_trending' };
      }

      // Sector concentration limit
      const sector = this._getSector(ticker);
      if (sector) {
        const sectorCount = await this._getSectorCount(sector);
        if (sectorCount >= this.config.maxPerSector) {
          this.logger.info('Sector limit reached — skipping buy', { ticker, sector, sectorCount, max: this.config.maxPerSector });
          return { action: 'SKIP', ticker, reason: `sector_limit: ${sector} (${sectorCount}/${this.config.maxPerSector})` };
        }
      }

      // Max open positions check
      const positions = await this.broker.getAllPositions();
      if (positions.length >= this.config.maxOpenPositions) {
        this.logger.info('Max positions reached — skipping buy', { ticker, current: positions.length, max: this.config.maxOpenPositions });
        return { action: 'SKIP', ticker, reason: `max_positions: ${positions.length}/${this.config.maxOpenPositions}` };
      }

      // Calculate conviction-based position size
      const { mid, ask }      = await this.getValidatedQuote(ticker);
      const { shares, positionPct } = await this.calculateShares(ticker, signalScore);
      const limitPrice        = this.config.defaultOrderType === 'limit'
        ? parseFloat((ask * (1 + this.config.limitSlippagePct)).toFixed(2))
        : null;

      const tier = this._getTier(ticker);
      const stop = this._getTrailingStop(ticker);

      // Use notional dollar amount for fractional shares, qty for whole shares
      const isFractional = shares < 1;
      const orderParams = isFractional ? {
        symbol:        ticker,
        notional:      (shares * mid).toFixed(2),  // dollar amount for fractional
        side:          'buy',
        type:          'market',                    // fractional orders must be market orders
        time_in_force: 'day',
      } : {
        symbol:        ticker,
        qty:           shares.toString(),
        side:          'buy',
        type:          this.config.defaultOrderType,
        time_in_force: 'day',
        ...(limitPrice && { limit_price: limitPrice.toString() }),
      };

      this.logger.info('Submitting buy order', {
        ticker, tier, sector, shares, limitPrice, mid,
        positionPct: (positionPct * 100).toFixed(0) + '%',
        trailingStop: (stop * 100).toFixed(0) + '%',
        signalScore,
      });

      const order    = await this.broker.submitOrder(orderParams);
      const logEntry = this.log.logOrder({ ...orderParams, orderId: order.id, side: 'buy', tier, positionPct, signalScore });
      this.emit('order', logEntry);

      // Initialize peak tracking
      this.positionPeaks[ticker] = { peakPrice: mid, entryPrice: mid, entryDate: new Date().toISOString() };

      return {
        action: 'BUY', ticker, signalScore, shares, limitPrice,
        tier, positionPct: (positionPct * 100).toFixed(0) + '%',
        trailingStop: (stop * 100).toFixed(0) + '%',
        orderId: order.id,
      };
    } catch (e) {
      this.logger.error('Buy execution failed', { ticker, error: e.message });
      this.emit('error', { ticker, action: 'BUY', error: e.message });
      if (this.config.haltOnUnknownError && !e.message.includes('spread') && !e.message.includes('size') && !e.message.includes('insufficient')) {
        await this.halt(`Unexpected buy error on ${ticker}: ${e.message}`);
      }
      return { action: 'ERROR', ticker, error: e.message };
    }
  }

  // ── Sell Execution ────────────────────────────────────────────────────────────

  async _executeSell(ticker, signalScore, meta, exitType = 'SCORE') {
    try {
      const position = await this.broker.getPosition(ticker);
      if (!position) {
        this.logger.info('No position to sell', { ticker });
        return { action: 'SKIP', ticker, reason: 'no_position' };
      }

      const qtyRaw     = parseFloat(position.qty);
      const isFractional = qtyRaw % 1 !== 0;

      // Fractional shares MUST use market orders and notional — Alpaca requirement
      let orderParams;
      if (isFractional) {
        orderParams = {
          symbol:        ticker,
          qty:           qtyRaw.toString(),
          side:          'sell',
          type:          'market',
          time_in_force: 'day',
        };
      } else {
        const qty        = parseInt(position.qty);
        const { bid }    = await this.getValidatedQuote(ticker);
        const limitPrice = parseFloat((bid * (1 - this.config.limitSlippagePct)).toFixed(2));
        orderParams = {
          symbol:        ticker,
          qty:           qty.toString(),
          side:          'sell',
          type:          'limit',
          time_in_force: 'day',
          limit_price:   limitPrice.toString(),
        };
      }

      this.logger.info('Submitting sell order', { ticker, qty, limitPrice, exitType });
      const order    = await this.broker.submitOrder(orderParams);
      const logEntry = this.log.logOrder({ ...orderParams, orderId: order.id, side: 'sell', exitType });
      this.emit('order', logEntry);

      // Clear peak tracking
      delete this.positionPeaks[ticker];

      return { action: 'SELL', ticker, signalScore, qty, limitPrice, exitType, orderId: order.id };
    } catch (e) {
      this.logger.error('Sell execution failed', { ticker, error: e.message });
      this.emit('error', { ticker, action: 'SELL', error: e.message });
      return { action: 'ERROR', ticker, error: e.message };
    }
  }

  // ── Batch Evaluation ──────────────────────────────────────────────────────────

  async evaluateAll(scores, meta = {}) {
    const results = [];
    // Sort by score descending so highest conviction gets first shot at position slots
    const sorted = this.config.watchlist
      .filter(t => scores[t] !== undefined)
      .sort((a, b) => (scores[b] || 0) - (scores[a] || 0));

    for (const ticker of sorted) {
      const score = scores[ticker];
      if (score === undefined) {
        this.logger.warn('No score provided for ticker', { ticker });
        continue;
      }
      const result = await this.evaluate(ticker, score, meta[ticker] || {});
      results.push(result);
    }

    // Process watchlist tickers not in scores
    for (const ticker of this.config.watchlist) {
      if (scores[ticker] === undefined) {
        this.logger.warn('No score provided for ticker', { ticker });
      }
    }

    this.logger.info('Batch evaluation complete', { results: results.map(r => `${r.ticker}:${r.action}`) });
    return results;
  }

  // ── Status ────────────────────────────────────────────────────────────────────

  async getStatus() {
    let account, positions, openOrders;
    const regime = this.marketRegime;

    try { account    = await this.broker.getAccount(); }
    catch (e) { account = { equity: '0', cash: '0', buying_power: '0' }; this.logger.warn('getStatus: account fetch failed', { error: e.message }); }

    try { positions  = await this.broker.getAllPositions(); }
    catch (e) { positions = []; this.logger.warn('getStatus: positions fetch failed', { error: e.message }); }

    try { openOrders = await this.broker.getOrders('open'); }
    catch (e) { openOrders = []; this.logger.warn('getStatus: orders fetch failed', { error: e.message }); }

    return {
      halted:      this.halted,
      haltReason:  this.haltReason,
      paper:       this.config.paperTrading,
      marketRegime: {
        riskOn: regime.riskOn,
        reason: regime.reason,
        lastChecked: regime.lastChecked ? new Date(regime.lastChecked).toISOString() : null,
      },
      account: {
        equity:      parseFloat(account.equity).toFixed(2),
        cash:        parseFloat(account.cash).toFixed(2),
        buyingPower: parseFloat(account.buying_power).toFixed(2),
      },
      positions: positions.map(p => {
        const current = parseFloat(p.current_price);
        const entry   = parseFloat(p.avg_entry_price);
        const peak    = this.positionPeaks[p.symbol]?.peakPrice || current;
        const tier    = this._getTier(p.symbol);
        const stop    = this._getTrailingStop(p.symbol);
        return {
          symbol:          p.symbol,
          tier,
          sector:          this._getSector(p.symbol),
          qty:             p.qty,
          avgEntry:        entry.toFixed(2),
          currentPrice:    current.toFixed(2),
          peakPrice:       peak.toFixed(2),
          unrealizedPL:    parseFloat(p.unrealized_pl).toFixed(2),
          unrealizedPLPct: (parseFloat(p.unrealized_plpc) * 100).toFixed(2) + '%',
          gainFromEntry:   ((current - entry) / entry * 100).toFixed(2) + '%',
          dropFromPeak:    ((peak - current) / peak * 100).toFixed(2) + '%',
          trailingStop:    (stop * 100).toFixed(0) + '%',
          trailingStopAt:  (peak * (1 - stop)).toFixed(2),
        };
      }),
      openOrders:   openOrders.length,
      tradeSummary: this.log.summary(),
      config: {
        buyThreshold:     this.config.buyThreshold,
        sellThreshold:    this.config.sellThreshold,
        noBuyList:        this.config.noBuyList,
        watchlist:        this.config.watchlist,
        maxOpenPositions: this.config.maxOpenPositions,
        maxPerSector:     this.config.maxPerSector,
        positionSizing:   '90+→15% | 80-89→12% | 75-79→8%',
        trailingStops:    'large=8% | mid=10% | small=15%',
        takeProfitAt:     `${this.config.takeProfitPct*100}% gain + score < ${this.config.takeProfitScoreDrop}`,
        earningsBlackout: `${this.config.earningsBlackoutDays} days`,
      },
    };
  }
}

module.exports = { OrderManager, DEFAULT_CONFIG };
