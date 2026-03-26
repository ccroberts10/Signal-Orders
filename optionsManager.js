/**
 * SIGNAL Options Manager
 * Executes defined-risk options strategies on watchlist tickers
 * Strategies: Cash-Secured Puts (CSP), Covered Calls (CC), Long Calls
 *
 * Requires: orderManager.js (for broker adapter + logging)
 * Broker: Alpaca Options API (same credentials)
 */

const EventEmitter = require('events');

// ─── Options Config Defaults ──────────────────────────────────────────────────

const OPTIONS_CONFIG = {
  enabled: false,                    // Must explicitly enable

  // Strategy gates — enable individually
  strategies: {
    cashSecuredPut:  true,           // Sell puts when bullish/neutral, collect premium
    coveredCall:     true,           // Sell calls against long stock positions
    longCall:        false,          // Buy calls on high-conviction breakouts only
  },

  // Contract selection
  targetDTE:        [21, 45],        // [min, max] days to expiration window
  targetDelta:      [0.25, 0.35],    // [min, max] delta for short options (CSP/CC)
  longCallDelta:    [0.55, 0.70],    // Delta range for long calls (ITM-ish)
  minOpenInterest:  50,              // Reject strikes with OI below this
  minVolume:        5,               // Reject strikes with volume below this
  maxSpreadPct:     0.10,            // Max bid/ask spread as % of mid (options are wider)

  // Sizing
  maxContractsPerTicker: 2,          // Never more than 2 contracts per ticker
  maxOptionsRiskPct:     0.05,       // Max 5% of portfolio at risk per options position
  cspCashRequirement:    1.0,        // Must have full cash to secure the put (1.0 = 100%)

  // Premium filters
  minAnnualizedYield:    0.20,       // Reject CSP/CC if annualized yield < 20%
  minPremiumDollars:     25,         // Reject if premium per contract < $25

  // Management rules
  takeProfitPct:         0.50,       // Close at 50% of max profit
  stopLossPct:           2.00,       // Close if position value 2x the credit received
  rollDTEThreshold:      7,          // Roll when DTE reaches this number

  // Micro-cap guards (POET, ATOM etc)
  minStockPrice:         2.00,       // Skip options if stock < $2 (too illiquid)
  requireLiquidityCheck: true,       // Enforce OI + volume + spread checks
};

// ─── Options Chain Fetcher (Alpaca) ───────────────────────────────────────────

class OptionsChainFetcher {
  constructor(headers) {
    this.base = 'https://data.alpaca.markets';
    this.headers = headers;
  }

  async _fetch(path) {
    const res = await fetch(`${this.base}${path}`, { headers: this.headers });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Options chain fetch ${path} → ${res.status}: ${err}`);
    }
    return res.json();
  }

  /**
   * Get all option contracts for a symbol near target expiration
   */
  async getChain(symbol, targetDTE = [21, 45]) {
    const today = new Date();
    const minExp = new Date(today); minExp.setDate(today.getDate() + targetDTE[0]);
    const maxExp = new Date(today); maxExp.setDate(today.getDate() + targetDTE[1]);

    const minDate = minExp.toISOString().split('T')[0];
    const maxDate = maxExp.toISOString().split('T')[0];

    const data = await this._fetch(
      `/v1beta1/options/snapshots/${symbol}?expiration_date_gte=${minDate}&expiration_date_lte=${maxDate}&limit=100`
    );

    return data.snapshots || {};
  }

  /**
   * Get latest quote for a specific option contract
   */
  async getOptionQuote(contractSymbol) {
    const data = await this._fetch(`/v1beta1/options/snapshots/${contractSymbol}`);
    return data.snapshots?.[contractSymbol] || null;
  }
}

// ─── Strike Selector ──────────────────────────────────────────────────────────

class StrikeSelector {
  /**
   * Find best CSP strike: nearest to target delta within OI/volume/spread constraints
   */
  static selectCSPStrike(snapshots, stockPrice, config) {
    const puts = Object.entries(snapshots)
      .filter(([sym, snap]) => {
        const d = snap.greeks;
        const q = snap.latestQuote;
        if (!d || !q) return false;
        const contractType = sym.includes('P') ? 'put' : null; // Alpaca OCC symbol
        // OCC format: RMBS250516P00020000 → type is at position [ticker.length + 6]
        // Filter puts by negative delta range (absolute value)
        const absDelta = Math.abs(d.delta);
        return (
          absDelta >= config.targetDelta[0] &&
          absDelta <= config.targetDelta[1] &&
          snap.openInterest >= config.minOpenInterest &&
          (snap.dayVolume || 0) >= config.minVolume
        );
      })
      .map(([sym, snap]) => {
        const mid    = (snap.latestQuote.bp + snap.latestQuote.ap) / 2;
        const spread = (snap.latestQuote.ap - snap.latestQuote.bp) / mid;
        const strike = parseFloat(snap.details?.strike_price || extractStrikeFromOCC(sym));
        const dte    = daysUntil(snap.details?.expiration_date);
        const annYield = (mid * 100) / strike / (dte / 365);

        return { sym, snap, mid, spread, strike, dte, annYield,
                 delta: Math.abs(snap.greeks.delta) };
      })
      .filter(c =>
        c.spread <= config.maxSpreadPct &&
        c.mid * 100 >= config.minPremiumDollars &&
        c.annYield >= config.minAnnualizedYield
      )
      .sort((a, b) => b.annYield - a.annYield); // Best yield first

    return puts[0] || null;
  }

  /**
   * Find best Covered Call strike: OTM, target delta
   */
  static selectCoveredCallStrike(snapshots, stockPrice, config) {
    const calls = Object.entries(snapshots)
      .filter(([sym, snap]) => {
        const d = snap.greeks;
        const q = snap.latestQuote;
        if (!d || !q) return false;
        const strike = parseFloat(snap.details?.strike_price || extractStrikeFromOCC(sym));
        return (
          strike > stockPrice &&                          // OTM only for CC
          d.delta >= config.targetDelta[0] &&
          d.delta <= config.targetDelta[1] &&
          snap.openInterest >= config.minOpenInterest &&
          (snap.dayVolume || 0) >= config.minVolume
        );
      })
      .map(([sym, snap]) => {
        const mid     = (snap.latestQuote.bp + snap.latestQuote.ap) / 2;
        const spread  = (snap.latestQuote.ap - snap.latestQuote.bp) / mid;
        const strike  = parseFloat(snap.details?.strike_price || extractStrikeFromOCC(sym));
        const dte     = daysUntil(snap.details?.expiration_date);
        const annYield = (mid * 100) / stockPrice / (dte / 365);

        return { sym, snap, mid, spread, strike, dte, annYield, delta: snap.greeks.delta };
      })
      .filter(c =>
        c.spread <= config.maxSpreadPct &&
        c.mid * 100 >= config.minPremiumDollars &&
        c.annYield >= config.minAnnualizedYield
      )
      .sort((a, b) => b.annYield - a.annYield);

    return calls[0] || null;
  }

  /**
   * Find best Long Call: slightly ITM, higher delta, good liquidity
   */
  static selectLongCallStrike(snapshots, stockPrice, config) {
    const calls = Object.entries(snapshots)
      .filter(([sym, snap]) => {
        const d = snap.greeks;
        const q = snap.latestQuote;
        if (!d || !q) return false;
        return (
          d.delta >= config.longCallDelta[0] &&
          d.delta <= config.longCallDelta[1] &&
          snap.openInterest >= config.minOpenInterest * 2 &&  // Stricter for long
          (snap.dayVolume || 0) >= config.minVolume * 2
        );
      })
      .map(([sym, snap]) => {
        const ask    = snap.latestQuote.ap;
        const spread = (snap.latestQuote.ap - snap.latestQuote.bp) /
                       ((snap.latestQuote.ap + snap.latestQuote.bp) / 2);
        const strike = parseFloat(snap.details?.strike_price || extractStrikeFromOCC(sym));
        const dte    = daysUntil(snap.details?.expiration_date);

        return { sym, snap, ask, spread, strike, dte, delta: snap.greeks.delta };
      })
      .filter(c => c.spread <= config.maxSpreadPct)
      .sort((a, b) => b.delta - a.delta); // Highest delta first

    return calls[0] || null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function daysUntil(dateStr) {
  if (!dateStr) return 0;
  return Math.round((new Date(dateStr) - new Date()) / (1000 * 60 * 60 * 24));
}

function extractStrikeFromOCC(occSymbol) {
  // OCC format: RMBS250516P00020000 → last 8 digits / 1000
  const raw = occSymbol.slice(-8);
  return (parseInt(raw) / 1000).toFixed(2);
}

// ─── Options Manager ──────────────────────────────────────────────────────────

class OptionsManager extends EventEmitter {
  constructor(orderManager, userConfig = {}) {
    super();
    this.om     = orderManager;             // Reference to parent OrderManager
    this.broker = orderManager.broker;      // Shared broker adapter
    this.logger = orderManager.logger;
    this.log    = orderManager.log;
    this.config = { ...OPTIONS_CONFIG, ...userConfig };
    this.fetcher = new OptionsChainFetcher(this.broker.headers);

    if (!this.config.enabled) {
      this.logger.warn('OptionsManager: options trading is DISABLED. Set enabled:true to activate.');
    }
  }

  // ── Guard checks ──────────────────────────────────────────────────────────

  _assertEnabled() {
    if (!this.config.enabled) throw new Error('Options trading is disabled in config');
    if (this.om.halted) throw new Error('System is halted');
  }

  async _getStockPrice(symbol) {
    const quote = await this.broker.getLatestQuote(symbol);
    const mid = (parseFloat(quote.bp) + parseFloat(quote.ap)) / 2;
    if (mid < this.config.minStockPrice) {
      throw new Error(`${symbol} price $${mid.toFixed(2)} below minimum $${this.config.minStockPrice} for options`);
    }
    return mid;
  }

  async _checkCashForCSP(strike, contracts = 1) {
    const account = await this.broker.getAccount();
    const cash    = parseFloat(account.cash);
    const required = strike * 100 * contracts * this.config.cspCashRequirement;
    if (cash < required) {
      throw new Error(`Insufficient cash for CSP: need $${required.toFixed(0)}, have $${cash.toFixed(0)}`);
    }
    return true;
  }

  async _checkPositionForCC(symbol) {
    const position = await this.broker.getPosition(symbol);
    if (!position) throw new Error(`No stock position in ${symbol} — can't sell covered call`);
    const shares = parseInt(position.qty);
    const maxContracts = Math.floor(shares / 100);
    if (maxContracts < 1) throw new Error(`Need at least 100 shares of ${symbol} for a covered call`);
    return { shares, maxContracts };
  }

  // ── Submit options order ──────────────────────────────────────────────────

  async _submitOptionsOrder({ symbol, contractSymbol, side, qty, orderType, limitPrice, strategy }) {
    const orderParams = {
      symbol:        contractSymbol,
      qty:           qty.toString(),
      side,
      type:          orderType,
      time_in_force: 'day',
      order_class:   'simple',
      ...(limitPrice && { limit_price: limitPrice.toFixed(2) }),
    };

    this.logger.info(`Submitting ${strategy} options order`, {
      underlying: symbol, contractSymbol, side, qty, limitPrice
    });

    const order = await this.broker.submitOrder(orderParams);

    const logEntry = this.log.logOrder({
      ...orderParams,
      orderId:  order.id,
      strategy,
      underlying: symbol,
    });

    this.emit('options_order', logEntry);
    return { order, logEntry };
  }

  // ── Cash-Secured Put ──────────────────────────────────────────────────────

  /**
   * Sell a cash-secured put on a ticker
   * Best used: bullish/neutral bias, want to potentially acquire stock at lower price
   * @param {string} symbol
   * @param {number} contracts  Number of contracts (default 1)
   */
  async sellCashSecuredPut(symbol, contracts = 1) {
    this._assertEnabled();
    if (!this.config.strategies.cashSecuredPut) throw new Error('CSP strategy is disabled');

    const stockPrice = await this._getStockPrice(symbol);
    this.logger.info('Scanning for CSP strikes', { symbol, stockPrice, contracts });

    const snapshots = await this.fetcher.getChain(symbol, this.config.targetDTE);
    if (!Object.keys(snapshots).length) throw new Error(`No options chain data for ${symbol}`);

    const best = StrikeSelector.selectCSPStrike(snapshots, stockPrice, this.config);
    if (!best) throw new Error(`No suitable CSP strike found for ${symbol} — check liquidity/spread filters`);

    await this._checkCashForCSP(best.strike, contracts);

    const limitPrice = parseFloat((best.mid * 0.98).toFixed(2)); // 2% below mid (favor fill)
    const { order } = await this._submitOptionsOrder({
      symbol,
      contractSymbol: best.sym,
      side:           'sell',
      qty:            contracts,
      orderType:      'limit',
      limitPrice,
      strategy:       'CSP',
    });

    const result = {
      strategy:       'CSP',
      symbol,
      contractSymbol: best.sym,
      strike:         best.strike,
      dte:            best.dte,
      delta:          best.delta.toFixed(3),
      premium:        best.mid.toFixed(2),
      creditReceived: (best.mid * 100 * contracts).toFixed(2),
      annualizedYield:(best.annYield * 100).toFixed(1) + '%',
      maxLoss:        ((best.strike - best.mid) * 100 * contracts).toFixed(2),
      breakeven:      (best.strike - best.mid).toFixed(2),
      orderId:        order.id,
    };

    this.logger.info('CSP order submitted', result);
    return result;
  }

  // ── Covered Call ──────────────────────────────────────────────────────────

  /**
   * Sell a covered call against an existing long position
   * Best used: neutral/slightly bearish short-term, want to collect premium on holdings
   * @param {string} symbol
   * @param {number} contracts  Default: 1 (uses 100 shares)
   */
  async sellCoveredCall(symbol, contracts = 1) {
    this._assertEnabled();
    if (!this.config.strategies.coveredCall) throw new Error('Covered call strategy is disabled');

    const stockPrice = await this._getStockPrice(symbol);
    const { shares, maxContracts } = await this._checkPositionForCC(symbol);

    const safeContracts = Math.min(contracts, maxContracts, this.config.maxContractsPerTicker);
    this.logger.info('Scanning for CC strikes', { symbol, stockPrice, shares, safeContracts });

    const snapshots = await this.fetcher.getChain(symbol, this.config.targetDTE);
    if (!Object.keys(snapshots).length) throw new Error(`No options chain data for ${symbol}`);

    const best = StrikeSelector.selectCoveredCallStrike(snapshots, stockPrice, this.config);
    if (!best) throw new Error(`No suitable CC strike found for ${symbol}`);

    const limitPrice = parseFloat((best.mid * 0.98).toFixed(2));
    const { order } = await this._submitOptionsOrder({
      symbol,
      contractSymbol: best.sym,
      side:           'sell',
      qty:            safeContracts,
      orderType:      'limit',
      limitPrice,
      strategy:       'CC',
    });

    const result = {
      strategy:       'CC',
      symbol,
      contractSymbol: best.sym,
      strike:         best.strike,
      dte:            best.dte,
      delta:          best.delta.toFixed(3),
      premium:        best.mid.toFixed(2),
      creditReceived: (best.mid * 100 * safeContracts).toFixed(2),
      annualizedYield:(best.annYield * 100).toFixed(1) + '%',
      maxProfit:      ((best.strike - stockPrice + best.mid) * 100 * safeContracts).toFixed(2),
      cappedAt:       best.strike.toFixed(2),
      orderId:        order.id,
    };

    this.logger.info('Covered call submitted', result);
    return result;
  }

  // ── Long Call ─────────────────────────────────────────────────────────────

  /**
   * Buy a call option — high conviction breakout play
   * Best used: strong bullish signal, want leveraged upside with defined risk
   * @param {string} symbol
   * @param {number} contracts
   */
  async buyLongCall(symbol, contracts = 1) {
    this._assertEnabled();
    if (!this.config.strategies.longCall) throw new Error('Long call strategy is disabled');

    const stockPrice = await this._getStockPrice(symbol);

    // Check max risk
    const account   = await this.broker.getAccount();
    const equity    = parseFloat(account.equity);
    const maxSpend  = equity * this.config.maxOptionsRiskPct;

    const snapshots = await this.fetcher.getChain(symbol, this.config.targetDTE);
    if (!Object.keys(snapshots).length) throw new Error(`No options chain data for ${symbol}`);

    const best = StrikeSelector.selectLongCallStrike(snapshots, stockPrice, this.config);
    if (!best) throw new Error(`No suitable long call strike found for ${symbol}`);

    const cost = best.ask * 100 * contracts;
    if (cost > maxSpend) {
      throw new Error(
        `Long call cost $${cost.toFixed(0)} exceeds max options risk $${maxSpend.toFixed(0)} (${(this.config.maxOptionsRiskPct*100).toFixed(0)}% of equity)`
      );
    }

    const limitPrice = parseFloat((best.ask * 1.01).toFixed(2)); // Slight urgency for long
    const { order } = await this._submitOptionsOrder({
      symbol,
      contractSymbol: best.sym,
      side:           'buy',
      qty:            contracts,
      orderType:      'limit',
      limitPrice,
      strategy:       'LONG_CALL',
    });

    const result = {
      strategy:      'LONG_CALL',
      symbol,
      contractSymbol: best.sym,
      strike:        best.strike,
      dte:           best.dte,
      delta:         best.delta.toFixed(3),
      premium:       best.ask.toFixed(2),
      totalCost:     cost.toFixed(2),
      maxLoss:       cost.toFixed(2),
      breakeven:     (best.strike + best.ask).toFixed(2),
      orderId:       order.id,
    };

    this.logger.info('Long call submitted', result);
    return result;
  }

  // ── Evaluate & Auto-select strategy based on SIGNAL score ────────────────

  /**
   * Given a SIGNAL score and context, auto-pick the right options strategy
   * @param {string} symbol
   * @param {number} signalScore
   * @param {object} context  { hasPosition: bool, earningsSoon: bool }
   */
  async evaluateOptionsStrategy(symbol, signalScore, context = {}) {
    this._assertEnabled();

    const { hasPosition = false, earningsSoon = false } = context;

    if (earningsSoon) {
      this.logger.info('Skipping options — earnings blackout', { symbol });
      return { action: 'SKIP', reason: 'earnings_blackout', symbol };
    }

    // Score 75–100: Strongly bullish
    //   → No position: sell CSP (get paid to acquire)
    //   → Has position: sell CC only if score < 85 (don't cap runaway winners)
    if (signalScore >= 75) {
      if (!hasPosition && this.config.strategies.cashSecuredPut) {
        return this.sellCashSecuredPut(symbol);
      }
      if (hasPosition && signalScore < 85 && this.config.strategies.coveredCall) {
        this.logger.info('High score + position but < 85 — selling CC', { symbol, signalScore });
        return this.sellCoveredCall(symbol);
      }
      if (hasPosition && signalScore >= 85) {
        return { action: 'HOLD_FOR_UPSIDE', symbol, signalScore,
                 reason: 'Score >= 85 with position — not capping upside with CC' };
      }
    }

    // Score 55–74: Moderately bullish
    //   → Has position: sell CC to collect premium
    //   → No position: CSP at lower delta for more cushion
    if (signalScore >= 55) {
      if (hasPosition && this.config.strategies.coveredCall) {
        return this.sellCoveredCall(symbol);
      }
      if (!hasPosition && this.config.strategies.cashSecuredPut) {
        return this.sellCashSecuredPut(symbol);
      }
    }

    // Score < 55: Neutral/bearish — no new options entries
    return { action: 'NO_ENTRY', symbol, signalScore,
             reason: 'Score too low for options entry' };
  }

  // ── Position Management ───────────────────────────────────────────────────

  /**
   * Check open options positions for take-profit / stop-loss / roll triggers
   * Call this on a separate, less frequent cron (e.g. every 30 min)
   */
  async manageOpenPositions() {
    this._assertEnabled();
    const positions = await this.broker.getAllPositions();
    const optionsPositions = positions.filter(p => p.asset_class === 'us_option');

    const actions = [];

    for (const pos of optionsPositions) {
      const costBasis     = Math.abs(parseFloat(pos.cost_basis));
      const currentValue  = Math.abs(parseFloat(pos.market_value));
      const unrealizedPL  = parseFloat(pos.unrealized_pl);
      const qty           = parseInt(pos.qty);
      const isShort       = qty < 0;
      const dte           = daysUntil(pos.expiration_date);

      const pnlPct = isShort
        ? unrealizedPL / costBasis          // Credit received = basis for shorts
        : unrealizedPL / costBasis;

      // Take profit: short options at 50% of max profit
      if (isShort && pnlPct >= this.config.takeProfitPct) {
        this.logger.info('Take profit triggered', { symbol: pos.symbol, pnlPct });
        actions.push({ action: 'CLOSE_TAKE_PROFIT', symbol: pos.symbol, pnlPct });
        // In production: submit buy-to-close order here
      }

      // Stop loss: short options at 2x credit
      else if (isShort && Math.abs(pnlPct) >= this.config.stopLossPct) {
        this.logger.warn('Stop loss triggered', { symbol: pos.symbol, pnlPct });
        actions.push({ action: 'CLOSE_STOP_LOSS', symbol: pos.symbol, pnlPct });
      }

      // Roll: approaching expiration
      else if (dte <= this.config.rollDTEThreshold) {
        this.logger.info('Roll trigger — approaching expiration', { symbol: pos.symbol, dte });
        actions.push({ action: 'ROLL_NEEDED', symbol: pos.symbol, dte,
                       note: 'Close current, open new further-dated contract' });
      }
    }

    return actions;
  }

  // ── Status ────────────────────────────────────────────────────────────────

  async getOptionsStatus() {
    const positions = await this.broker.getAllPositions();
    const opts = positions.filter(p => p.asset_class === 'us_option');

    return {
      enabled:          this.config.enabled,
      strategies:       this.config.strategies,
      openPositions:    opts.length,
      positions: opts.map(p => ({
        symbol:        p.symbol,
        qty:           p.qty,
        side:          parseInt(p.qty) < 0 ? 'short' : 'long',
        avgEntry:      parseFloat(p.avg_entry_price).toFixed(2),
        currentPrice:  parseFloat(p.current_price).toFixed(2),
        unrealizedPL:  parseFloat(p.unrealized_pl).toFixed(2),
        marketValue:   parseFloat(p.market_value).toFixed(2),
      })),
    };
  }
}

module.exports = { OptionsManager, OPTIONS_CONFIG };
