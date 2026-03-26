/**
 * SIGNAL Order Manager
 * Automated execution layer for SIGNAL scanner
 * Supports: Alpaca (default), Tradier (optional)
 */

const EventEmitter = require('events');

// ─── Config ───────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  broker: 'alpaca',           // 'alpaca' | 'tradier'
  paperTrading: true,         // ALWAYS start true
  watchlist: ['RMBS', 'VICR', 'ATOM', 'POET'],

  // Signal thresholds
  buyThreshold: 75,           // SIGNAL score >= this → consider buy
  sellThreshold: 35,          // SIGNAL score <= this → consider sell
  holdZone: [36, 74],         // Between these → hold / no action

  // Position sizing
  maxPositionPct: 0.15,       // Max 15% of portfolio per ticker
  maxPortfolioRisk: 0.40,     // Never more than 40% deployed in watchlist
  defaultOrderType: 'limit',  // 'market' | 'limit'
  limitSlippagePct: 0.002,    // Limit price = mid ± 0.2%

  // Risk controls
  dailyLossLimitPct: 0.03,    // Halt trading if down 3% on the day
  maxSpreadPct: 0.02,         // Reject order if bid/ask spread > 2%
  earningsBlackoutDays: 3,    // No new positions within N days of earnings
  haltOnUnknownError: true,   // Kill switch on unexpected errors

  // Options
  enableOptions: false,       // Gate — must explicitly enable
  defaultOptionsDTE: 30,      // Target 30 DTE for options entries
  defaultOptionsDelta: 0.30,  // Target ~0.30 delta

  // Logging
  logLevel: 'info',           // 'debug' | 'info' | 'warn' | 'error'
};

// ─── Logger ───────────────────────────────────────────────────────────────────

class Logger {
  constructor(level = 'info') {
    this.levels = { debug: 0, info: 1, warn: 2, error: 3 };
    this.level = level;
  }

  _log(level, message, meta = {}) {
    if (this.levels[level] < this.levels[this.level]) return;
    const entry = {
      ts: new Date().toISOString(),
      level: level.toUpperCase(),
      message,
      ...meta,
    };
    console.log(JSON.stringify(entry));
    return entry;
  }

  debug(msg, meta) { return this._log('debug', msg, meta); }
  info(msg, meta)  { return this._log('info', msg, meta); }
  warn(msg, meta)  { return this._log('warn', msg, meta); }
  error(msg, meta) { return this._log('error', msg, meta); }
}

// ─── Trade Log (in-memory + pluggable persistence) ────────────────────────────

class TradeLog {
  constructor() {
    this.decisions = [];   // Every evaluation
    this.orders    = [];   // Every submitted order
    this.fills     = [];   // Confirmed fills
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
    this.paper = config.paperTrading;
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
    const url = `${base || this.baseUrl}${path}`;
    const opts = { method, headers: this.headers };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Alpaca ${method} ${path} → ${res.status}: ${err}`);
    }
    return res.json();
  }

  async getAccount() {
    return this._fetch('GET', '/v2/account');
  }

  async getPosition(symbol) {
    try {
      return await this._fetch('GET', `/v2/positions/${symbol}`);
    } catch (e) {
      if (e.message.includes('404')) return null;
      throw e;
    }
  }

  async getAllPositions() {
    return this._fetch('GET', '/v2/positions');
  }

  async getLatestQuote(symbol) {
    const data = await this._fetch('GET', `/v2/stocks/${symbol}/quotes/latest`, null, this.dataUrl);
    return data.quote;
  }

  async submitOrder(params) {
    return this._fetch('POST', '/v2/orders', params);
  }

  async cancelAllOrders() {
    return this._fetch('DELETE', '/v2/orders');
  }

  async getOrders(status = 'open') {
    return this._fetch('GET', `/v2/orders?status=${status}`);
  }

  async isMarketOpen() {
    const clock = await this._fetch('GET', '/v2/clock');
    return clock.is_open;
  }
}

// ─── Order Manager ────────────────────────────────────────────────────────────

class OrderManager extends EventEmitter {
  constructor(userConfig = {}) {
    super();
    this.config  = { ...DEFAULT_CONFIG, ...userConfig };
    this.logger  = new Logger(this.config.logLevel);
    this.log     = new TradeLog();
    this.halted  = false;
    this.haltReason = null;
    this.dailyPnL   = 0;
    this.portfolioValueAtOpen = null;

    // Init broker adapter
    if (this.config.broker === 'alpaca') {
      this.broker = new AlpacaAdapter(this.config);
    } else {
      throw new Error(`Broker '${this.config.broker}' not yet implemented. Use 'alpaca'.`);
    }

    this.logger.info('OrderManager initialized', {
      broker: this.config.broker,
      paper:  this.config.paperTrading,
      watchlist: this.config.watchlist,
    });

    if (this.config.paperTrading) {
      this.logger.warn('PAPER TRADING MODE — no real money at risk');
    }
  }

  // ── Kill Switch ─────────────────────────────────────────────────────────────

  async halt(reason) {
    this.halted = true;
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
    this.halted = false;
    this.haltReason = null;
    this.logger.info('Trading resumed');
    this.emit('resume');
  }

  // ── Market Checks ───────────────────────────────────────────────────────────

  async assertMarketOpen() {
    const open = await this.broker.isMarketOpen();
    if (!open) throw new Error('Market is closed');
    return true;
  }

  // ── Quote & Spread Validation ───────────────────────────────────────────────

  async getValidatedQuote(symbol) {
    const quote = await this.broker.getLatestQuote(symbol);
    const bid = parseFloat(quote.bp);
    const ask = parseFloat(quote.ap);
    const mid = (bid + ask) / 2;
    const spread = (ask - bid) / mid;

    this.logger.debug('Quote fetched', { symbol, bid, ask, mid, spreadPct: spread });

    if (spread > this.config.maxSpreadPct) {
      throw new Error(
        `Spread too wide for ${symbol}: ${(spread * 100).toFixed(2)}% > max ${(this.config.maxSpreadPct * 100).toFixed(2)}%`
      );
    }

    return { bid, ask, mid, spread };
  }

  // ── Position Sizing ─────────────────────────────────────────────────────────

  async calculateShares(symbol, side = 'buy') {
    const account   = await this.broker.getAccount();
    const equity    = parseFloat(account.equity);
    const maxDollar = equity * this.config.maxPositionPct;
    const { mid }   = await this.getValidatedQuote(symbol);
    const shares    = Math.floor(maxDollar / mid);

    this.logger.debug('Position size calculated', { symbol, equity, maxDollar, mid, shares });

    if (shares < 1) throw new Error(`Position size rounds to 0 shares for ${symbol} at $${mid.toFixed(2)}`);
    return shares;
  }

  // ── Daily P&L Risk Check ────────────────────────────────────────────────────

  async checkDailyLossLimit() {
    if (!this.portfolioValueAtOpen) {
      const account = await this.broker.getAccount();
      this.portfolioValueAtOpen = parseFloat(account.last_equity);
    }
    const account  = await this.broker.getAccount();
    const current  = parseFloat(account.equity);
    const pnlPct   = (current - this.portfolioValueAtOpen) / this.portfolioValueAtOpen;

    this.logger.debug('Daily P&L check', {
      open: this.portfolioValueAtOpen,
      current,
      pnlPct: (pnlPct * 100).toFixed(2) + '%'
    });

    if (pnlPct < -this.config.dailyLossLimitPct) {
      await this.halt(`Daily loss limit breached: ${(pnlPct * 100).toFixed(2)}%`);
      return false;
    }
    return true;
  }

  // ── Core Evaluate & Execute ─────────────────────────────────────────────────

  /**
   * Main entry point — call this from SIGNAL with a ticker + score
   * @param {string} ticker
   * @param {number} signalScore  0–100
   * @param {object} meta         Optional: { earnings_date, notes, ... }
   */
  async evaluate(ticker, signalScore, meta = {}) {
    // Guard: halted
    if (this.halted) {
      this.logger.warn('Skipping evaluation — system halted', { ticker, haltReason: this.haltReason });
      return { action: 'HALTED', ticker, signalScore };
    }

    // Guard: watchlist
    if (!this.config.watchlist.includes(ticker)) {
      this.logger.warn('Ticker not in watchlist — skipping', { ticker });
      return { action: 'SKIP', ticker, reason: 'not_in_watchlist' };
    }

    // Guard: market open
    try {
      await this.assertMarketOpen();
    } catch (e) {
      return { action: 'SKIP', ticker, reason: 'market_closed' };
    }

    // Guard: daily loss limit
    const withinLoss = await this.checkDailyLossLimit();
    if (!withinLoss) {
      return { action: 'HALTED', ticker, reason: 'daily_loss_limit' };
    }

    // Guard: earnings blackout
    if (meta.earnings_date) {
      const daysToEarnings = Math.floor(
        (new Date(meta.earnings_date) - new Date()) / (1000 * 60 * 60 * 24)
      );
      if (daysToEarnings >= 0 && daysToEarnings <= this.config.earningsBlackoutDays) {
        const reason = `Earnings blackout: ${daysToEarnings}d to earnings`;
        this.log.logDecision(ticker, signalScore, 'HOLD', reason);
        this.logger.info('Earnings blackout — holding', { ticker, daysToEarnings });
        return { action: 'HOLD', ticker, signalScore, reason };
      }
    }

    // Determine action
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

    // Execute
    if (action === 'BUY')  return this._executeBuy(ticker, signalScore, meta);
    if (action === 'SELL') return this._executeSell(ticker, signalScore, meta);
    return { action: 'HOLD', ticker, signalScore, reason };
  }

  // ── Buy Execution ───────────────────────────────────────────────────────────

  async _executeBuy(ticker, signalScore, meta) {
    try {
      const existing = await this.broker.getPosition(ticker);
      if (existing) {
        const reason = 'Already have a position — skipping buy';
        this.logger.info(reason, { ticker, qty: existing.qty });
        return { action: 'SKIP', ticker, reason };
      }

      const { mid, ask } = await this.getValidatedQuote(ticker);
      const qty = await this.calculateShares(ticker, 'buy');
      const limitPrice = this.config.defaultOrderType === 'limit'
        ? parseFloat((ask * (1 + this.config.limitSlippagePct)).toFixed(2))
        : null;

      const orderParams = {
        symbol:        ticker,
        qty:           qty.toString(),
        side:          'buy',
        type:          this.config.defaultOrderType,
        time_in_force: 'day',
        ...(limitPrice && { limit_price: limitPrice.toString() }),
      };

      this.logger.info('Submitting buy order', { ticker, qty, limitPrice, mid });
      const order = await this.broker.submitOrder(orderParams);

      const logEntry = this.log.logOrder({ ...orderParams, orderId: order.id, side: 'buy' });
      this.emit('order', logEntry);

      return { action: 'BUY', ticker, signalScore, qty, limitPrice, orderId: order.id };
    } catch (e) {
      this.logger.error('Buy execution failed', { ticker, error: e.message });
      this.emit('error', { ticker, action: 'BUY', error: e.message });
      if (this.config.haltOnUnknownError && !e.message.includes('spread') && !e.message.includes('size')) {
        await this.halt(`Unexpected buy error on ${ticker}: ${e.message}`);
      }
      return { action: 'ERROR', ticker, error: e.message };
    }
  }

  // ── Sell Execution ──────────────────────────────────────────────────────────

  async _executeSell(ticker, signalScore, meta) {
    try {
      const position = await this.broker.getPosition(ticker);
      if (!position) {
        const reason = 'No position to sell';
        this.logger.info(reason, { ticker });
        return { action: 'SKIP', ticker, reason };
      }

      const qty = parseInt(position.qty);
      const { bid } = await this.getValidatedQuote(ticker);
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

      this.logger.info('Submitting sell order', { ticker, qty, limitPrice });
      const order = await this.broker.submitOrder(orderParams);

      const logEntry = this.log.logOrder({ ...orderParams, orderId: order.id, side: 'sell' });
      this.emit('order', logEntry);

      return { action: 'SELL', ticker, signalScore, qty, limitPrice, orderId: order.id };
    } catch (e) {
      this.logger.error('Sell execution failed', { ticker, error: e.message });
      this.emit('error', { ticker, action: 'SELL', error: e.message });
      return { action: 'ERROR', ticker, error: e.message };
    }
  }

  // ── Batch Evaluation (run full watchlist) ───────────────────────────────────

  /**
   * Pass in scores from SIGNAL for all tickers at once
   * @param {object} scores  e.g. { RMBS: 82, VICR: 44, ATOM: 71, POET: 28 }
   * @param {object} meta    Optional per-ticker meta: { RMBS: { earnings_date: '2025-05-01' } }
   */
  async evaluateAll(scores, meta = {}) {
    const results = [];
    for (const ticker of this.config.watchlist) {
      const score = scores[ticker];
      if (score === undefined) {
        this.logger.warn('No score provided for ticker', { ticker });
        continue;
      }
      const result = await this.evaluate(ticker, score, meta[ticker] || {});
      results.push(result);
    }
    this.logger.info('Batch evaluation complete', { results: results.map(r => `${r.ticker}:${r.action}`) });
    return results;
  }

  // ── Status ──────────────────────────────────────────────────────────────────

  async getStatus() {
    const account   = await this.broker.getAccount();
    const positions = await this.broker.getAllPositions();
    const openOrders = await this.broker.getOrders('open');

    return {
      halted:     this.halted,
      haltReason: this.haltReason,
      paper:      this.config.paperTrading,
      account: {
        equity:       parseFloat(account.equity).toFixed(2),
        cash:         parseFloat(account.cash).toFixed(2),
        buyingPower:  parseFloat(account.buying_power).toFixed(2),
      },
      positions:  positions.map(p => ({
        symbol:    p.symbol,
        qty:       p.qty,
        avgEntry:  parseFloat(p.avg_entry_price).toFixed(2),
        currentPrice: parseFloat(p.current_price).toFixed(2),
        unrealizedPL: parseFloat(p.unrealized_pl).toFixed(2),
        unrealizedPLPct: (parseFloat(p.unrealized_plpc) * 100).toFixed(2) + '%',
      })),
      openOrders: openOrders.length,
      tradeSummary: this.log.summary(),
    };
  }
}

module.exports = { OrderManager, DEFAULT_CONFIG };
