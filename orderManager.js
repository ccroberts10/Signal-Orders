/**
 * SIGNAL Order Manager
 * Automated execution layer for SIGNAL scanner
 * Supports: Alpaca (default), Tradier (optional)
 */

const EventEmitter = require('events');

const DEFAULT_CONFIG = {
  broker: 'alpaca',
  paperTrading: true,
  watchlist: ['RMBS', 'VICR', 'ATOM', 'POET'],

  // Signal thresholds
  buyThreshold:  75,
  sellThreshold: 35,
  holdZone:      [36, 74],

  // Position sizing
  maxPositionPct:   0.15,
  maxPortfolioRisk: 0.40,
  defaultOrderType: 'limit',
  limitSlippagePct: 0.002,

  // Risk controls
  dailyLossLimitPct:   0.03,
  maxSpreadPct:        0.02,
  earningsBlackoutDays: 3,
  haltOnUnknownError:  true,

  // ── Trailing stop & take profit ──────────────────────────────────────────
  trailingStopPct:     0.08,   // Sell if price drops 8% from peak
  takeProfitPct:       0.12,   // Take profit threshold: 12% gain
  takeProfitScoreDrop: 60,     // Sell if up 12%+ AND score drops below this

  // Options
  enableOptions:     false,
  defaultOptionsDTE: 30,
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
    this.portfolioValueAtOpen = null;

    // Trailing stop tracking: { TICKER: { peakPrice, entryPrice } }
    this.positionPeaks = {};

    if (this.config.broker === 'alpaca') {
      this.broker = new AlpacaAdapter(this.config);
    } else {
      throw new Error(`Broker '${this.config.broker}' not implemented. Use 'alpaca'.`);
    }

    this.logger.info('OrderManager initialized', {
      broker:    this.config.broker,
      paper:     this.config.paperTrading,
      watchlist: this.config.watchlist,
      trailingStop: (this.config.trailingStopPct * 100).toFixed(0) + '%',
      takeProfitAt: (this.config.takeProfitPct * 100).toFixed(0) + '% gain + score < ' + this.config.takeProfitScoreDrop,
    });

    if (this.config.paperTrading) {
      this.logger.warn('PAPER TRADING MODE — no real money at risk');
    }
  }

  // ── Kill Switch ──────────────────────────────────────────────────────────────

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

  // ── Market Check ─────────────────────────────────────────────────────────────

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

  async calculateShares(symbol) {
    const account   = await this.broker.getAccount();
    const equity    = parseFloat(account.equity);
    const maxDollar = equity * this.config.maxPositionPct;
    const { mid }   = await this.getValidatedQuote(symbol);
    const shares    = Math.floor(maxDollar / mid);
    if (shares < 1) throw new Error(`Position size rounds to 0 shares for ${symbol} at $${mid.toFixed(2)}`);
    return shares;
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

  // ── Trailing Stop & Take Profit Check ────────────────────────────────────────

  async checkExitRules(ticker, signalScore, position) {
    const currentPrice = parseFloat(position.current_price);
    const entryPrice   = parseFloat(position.avg_entry_price);
    const gainPct      = (currentPrice - entryPrice) / entryPrice;

    // Update peak price tracking
    if (!this.positionPeaks[ticker]) {
      this.positionPeaks[ticker] = { peakPrice: currentPrice, entryPrice };
    }
    if (currentPrice > this.positionPeaks[ticker].peakPrice) {
      this.positionPeaks[ticker].peakPrice = currentPrice;
    }

    const peakPrice    = this.positionPeaks[ticker].peakPrice;
    const dropFromPeak = (peakPrice - currentPrice) / peakPrice;

    this.logger.debug('Exit rules check', {
      ticker,
      currentPrice,
      entryPrice,
      peakPrice,
      gainPct:      (gainPct * 100).toFixed(2) + '%',
      dropFromPeak: (dropFromPeak * 100).toFixed(2) + '%',
      signalScore,
    });

    // Rule 1: Trailing stop — down 8%+ from peak
    if (dropFromPeak >= this.config.trailingStopPct) {
      const reason = `Trailing stop: dropped ${(dropFromPeak * 100).toFixed(1)}% from peak $${peakPrice.toFixed(2)}`;
      this.logger.warn('TRAILING STOP TRIGGERED', { ticker, dropFromPeak, peakPrice, currentPrice });
      return { shouldExit: true, reason, exitType: 'TRAILING_STOP' };
    }

    // Rule 2: Take profit — up 12%+ AND score drops below 60
    if (gainPct >= this.config.takeProfitPct && signalScore < this.config.takeProfitScoreDrop) {
      const reason = `Take profit: up ${(gainPct * 100).toFixed(1)}% and score dropped to ${signalScore} (< ${this.config.takeProfitScoreDrop})`;
      this.logger.info('TAKE PROFIT TRIGGERED', { ticker, gainPct, signalScore });
      return { shouldExit: true, reason, exitType: 'TAKE_PROFIT' };
    }

    return { shouldExit: false };
  }

  // ── Core Evaluate & Execute ───────────────────────────────────────────────────

  async evaluate(ticker, signalScore, meta = {}) {
    if (this.halted) {
      this.logger.warn('Skipping — system halted', { ticker });
      return { action: 'HALTED', ticker, signalScore };
    }

    if (!this.config.watchlist.includes(ticker)) {
      this.logger.warn('Not in watchlist — skipping', { ticker });
      return { action: 'SKIP', ticker, reason: 'not_in_watchlist' };
    }

    try { await this.assertMarketOpen(); }
    catch (e) { return { action: 'SKIP', ticker, reason: 'market_closed' }; }

    const withinLoss = await this.checkDailyLossLimit();
    if (!withinLoss) return { action: 'HALTED', ticker, reason: 'daily_loss_limit' };

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

    // ── Check trailing stop & take profit on existing positions ──────────────
    const existingPosition = await this.broker.getPosition(ticker);
    if (existingPosition) {
      const exitCheck = await this.checkExitRules(ticker, signalScore, existingPosition);
      if (exitCheck.shouldExit) {
        this.log.logDecision(ticker, signalScore, 'SELL', exitCheck.reason);
        this.logger.info('Exit rule triggered', { ticker, ...exitCheck });
        this.emit('decision', { ticker, signalScore, action: 'SELL', reason: exitCheck.reason });
        return this._executeSell(ticker, signalScore, meta, exitCheck.exitType);
      }
    }

    // ── Standard score-based decision ────────────────────────────────────────
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
      const existing = await this.broker.getPosition(ticker);
      if (existing) {
        this.logger.info('Already have a position — skipping buy', { ticker, qty: existing.qty });
        return { action: 'SKIP', ticker, reason: 'already_have_position' };
      }

      const { mid, ask } = await this.getValidatedQuote(ticker);
      const qty          = await this.calculateShares(ticker);
      const limitPrice   = this.config.defaultOrderType === 'limit'
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
      const order    = await this.broker.submitOrder(orderParams);
      const logEntry = this.log.logOrder({ ...orderParams, orderId: order.id, side: 'buy' });
      this.emit('order', logEntry);

      // Initialize peak tracking for this new position
      this.positionPeaks[ticker] = { peakPrice: mid, entryPrice: mid };

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

      // Clear peak tracking on sell
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

  // ── Status ────────────────────────────────────────────────────────────────────

  async getStatus() {
    const account    = await this.broker.getAccount();
    const positions  = await this.broker.getAllPositions();
    const openOrders = await this.broker.getOrders('open');

    return {
      halted:     this.halted,
      haltReason: this.haltReason,
      paper:      this.config.paperTrading,
      account: {
        equity:      parseFloat(account.equity).toFixed(2),
        cash:        parseFloat(account.cash).toFixed(2),
        buyingPower: parseFloat(account.buying_power).toFixed(2),
      },
      positions: positions.map(p => {
        const current   = parseFloat(p.current_price);
        const entry     = parseFloat(p.avg_entry_price);
        const peak      = this.positionPeaks[p.symbol]?.peakPrice || current;
        const gainPct   = ((current - entry) / entry * 100).toFixed(2);
        const dropPct   = ((peak - current) / peak * 100).toFixed(2);
        return {
          symbol:          p.symbol,
          qty:             p.qty,
          avgEntry:        entry.toFixed(2),
          currentPrice:    current.toFixed(2),
          peakPrice:       peak.toFixed(2),
          unrealizedPL:    parseFloat(p.unrealized_pl).toFixed(2),
          unrealizedPLPct: (parseFloat(p.unrealized_plpc) * 100).toFixed(2) + '%',
          gainFromEntry:   gainPct + '%',
          dropFromPeak:    dropPct + '%',
          trailingStopAt:  (peak * (1 - this.config.trailingStopPct)).toFixed(2),
        };
      }),
      openOrders:   openOrders.length,
      tradeSummary: this.log.summary(),
      exitRules: {
        trailingStop:        (this.config.trailingStopPct * 100).toFixed(0) + '%',
        takeProfitAt:        (this.config.takeProfitPct * 100).toFixed(0) + '%',
        takeProfitScoreDrop: this.config.takeProfitScoreDrop,
      },
    };
  }
}

module.exports = { OrderManager, DEFAULT_CONFIG };
