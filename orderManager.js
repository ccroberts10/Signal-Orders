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

// ─── Config ───────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  broker:       'alpaca',
  paperTrading: true,
  watchlist:    ['RMBS', 'VICR', 'ATOM', 'POET'],

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
    mid:   0.10,    // MRVL, MU, AMD, PLTR, TSLA, MSTR, RMBS
    small: 0.15,    // METC, POET, ATOM, AAOI, VIAV, VICR
  },

  // Ticker volatility tiers
  volatilityTier: {
    AAPL:  'large', MSFT:  'large', GOOGL: 'large', AMZN:  'large',
    META:  'large', NVDA:  'large', SPY:   'large', QQQ:   'large',
    MRVL:  'mid',   MU:    'mid',   AMD:   'mid',   PLTR:  'mid',
    TSLA:  'mid',   MSTR:  'mid',   RMBS:  'mid',
    METC:  'small', POET:  'small', ATOM:  'small', AAOI:  'small',
    VIAV:  'small', VICR:  'small', OPTX:  'small', MXL:   'mid',
  },

  // Sector mapping for concentration limit
  sectors: {
    AAPL:  'tech',      MSFT:  'tech',      GOOGL: 'tech',
    AMZN:  'tech',      META:  'tech',      NVDA:  'semis',
    AMD:   'semis',     MU:    'semis',     MRVL:  'semis',
    PLTR:  'software',  MSTR:  'crypto',    TSLA:  'ev',
    SPY:   'etf',       QQQ:   'etf',       RMBS:  'semis',
    ATOM:  'biotech',   VICR:  'power',     POET:  'photonics',
    AAOI:  'photonics', VIAV:  'photonics', METC:  'coal',  OPTX:  'biotech',  MXL:   'semis',
  },

  maxPerSector:         2,     // Max 2 positions per sector
  maxOpenPositions:     4,     // Max concurrent positions

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
  enableOptions:      false,
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
    const res = await fetch(url, opts);
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Alpaca ${method} ${path} → ${res.status}: ${err}`);
    }
    return res.json();
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
    this.positionPeaks = {};

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
  }

  // ── Volatility Tier Helpers ───────────────────────────────────────────────────

  _getTier(ticker) {
    return this.config.volatilityTier[ticker] || 'mid';
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
    return positions.filter(p => this.config.sectors[p.symbol] === sector).length;
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
    const account    = await this.broker.getAccount();
    const equity     = parseFloat(account.equity);
    const positionPct = this._getPositionSize(score);
    const maxDollar  = equity * positionPct;
    const { mid }    = await this.getValidatedQuote(symbol);
    const shares     = Math.floor(maxDollar / mid);
    if (shares < 1) throw new Error(`Position size rounds to 0 shares for ${symbol} at $${mid.toFixed(2)}`);
    this.logger.debug('Position size', { symbol, score, positionPct, maxDollar, mid, shares });
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
      const sector = this.config.sectors[ticker];
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

      const orderParams = {
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

      const qty        = parseInt(position.qty);
      const { bid }    = await this.getValidatedQuote(ticker);
      const limitPrice = this.config.defaultOrderType === 'limit'
        ? parseFloat((bid * (1 - this.config.limitSlippagePct)).toFixed(2))
        : null;

      const orderParams = {
        symbol:        ticker,
        qty:           qty.toString(),
        side:          'sell',
        type:          this.config.defaultOrderType,
        time_in_force: 'day',
        ...(limitPrice && { limit_price: limitPrice.toString() }),
      };

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
    const account    = await this.broker.getAccount();
    const positions  = await this.broker.getAllPositions();
    const openOrders = await this.broker.getOrders('open');
    const regime     = this.marketRegime;

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
          sector:          this.config.sectors[p.symbol] || 'unknown',
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
