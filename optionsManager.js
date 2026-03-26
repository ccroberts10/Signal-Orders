/**
 * SIGNAL Options Manager — GEX Enhanced
 * Strategies: Cash-Secured Puts (CSP), Covered Calls (CC), Long Calls
 * Strike selection uses GEX walls when available, falls back to delta targeting
 */

const EventEmitter   = require('events');
const { GEXAnalyzer } = require('./gexAnalyzer');

const OPTIONS_CONFIG = {
  enabled: false,

  strategies: {
    cashSecuredPut: true,
    coveredCall:    true,
    longCall:       false,
  },

  // Contract selection
  targetDTE:       [21, 45],
  targetDelta:     [0.25, 0.35],
  longCallDelta:   [0.55, 0.70],
  minOpenInterest: 50,
  minVolume:       5,
  maxSpreadPct:    0.10,

  // GEX settings
  useGEX:          true,   // Use GEX walls for strike selection when available
  gexWallTolerance: 2.5,   // Accept strikes within $2.50 of GEX wall

  // Sizing
  maxContractsPerTicker: 1,
  maxOptionsRiskPct:     0.05,
  cspCashRequirement:    1.0,

  // Premium filters
  minAnnualizedYield: 0.14,
  minPremiumDollars:  25,

  // Management
  takeProfitPct:      0.50,
  stopLossPct:        2.00,
  rollDTEThreshold:   7,

  // Guards
  minStockPrice:         2.00,
  requireLiquidityCheck: true,
};

// ─── Options Chain Fetcher (Alpaca) ───────────────────────────────────────────

class OptionsChainFetcher {
  constructor(headers) {
    this.base    = 'https://data.alpaca.markets';
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

  async getChain(symbol, targetDTE = [21, 45]) {
    const today  = new Date();
    const minExp = new Date(today); minExp.setDate(today.getDate() + targetDTE[0]);
    const maxExp = new Date(today); maxExp.setDate(today.getDate() + targetDTE[1]);
    const data   = await this._fetch(
      `/v1beta1/options/snapshots/${symbol}?expiration_date_gte=${minExp.toISOString().split('T')[0]}&expiration_date_lte=${maxExp.toISOString().split('T')[0]}&limit=100`
    );
    return data.snapshots || {};
  }
}

// ─── Strike Selector ──────────────────────────────────────────────────────────

class StrikeSelector {

  /**
   * CSP: prefer GEX put wall strike, fall back to delta targeting
   */
  static selectCSPStrike(snapshots, stockPrice, config, gexData = null) {
    const candidates = Object.entries(snapshots)
      .filter(([sym, snap]) => {
        const d = snap.greeks;
        const q = snap.latestQuote;
        if (!d || !q) return false;
        const absDelta = Math.abs(d.delta);
        return (
          absDelta >= config.targetDelta[0] &&
          absDelta <= config.targetDelta[1] &&
          snap.openInterest >= config.minOpenInterest &&
          (snap.dayVolume || 0) >= config.minVolume
        );
      })
      .map(([sym, snap]) => {
        const mid      = (snap.latestQuote.bp + snap.latestQuote.ap) / 2;
        const spread   = (snap.latestQuote.ap - snap.latestQuote.bp) / mid;
        const strike   = parseFloat(snap.details?.strike_price || extractStrikeFromOCC(sym));
        const dte      = daysUntil(snap.details?.expiration_date);
        const annYield = (mid * 100) / strike / (dte / 365);
        return { sym, snap, mid, spread, strike, dte, annYield, delta: Math.abs(snap.greeks.delta) };
      })
      .filter(c =>
        c.spread <= config.maxSpreadPct &&
        c.mid * 100 >= config.minPremiumDollars &&
        c.annYield >= config.minAnnualizedYield
      );

    if (!candidates.length) return null;

    // GEX wall anchor: find candidate closest to put wall
    if (config.useGEX && gexData?.putWalls?.length) {
      const putWallStrike = gexData.putWalls[0].strike;

      // Skip if put wall is inside a negative GEX acceleration zone
      const inNegZone = (gexData.negZones || []).some(z => Math.abs(z.strike - putWallStrike) < 2.5);
      if (!inNegZone) {
        const wallAnchored = candidates
          .filter(c => Math.abs(c.strike - putWallStrike) <= config.gexWallTolerance)
          .sort((a, b) => b.annYield - a.annYield);

        if (wallAnchored.length) {
          wallAnchored[0].gexAnchored = true;
          wallAnchored[0].gexWall = putWallStrike;
          return wallAnchored[0];
        }
      }
    }

    // Fallback: best yield
    return candidates.sort((a, b) => b.annYield - a.annYield)[0];
  }

  /**
   * CC: prefer GEX call wall strike, fall back to delta targeting
   */
  static selectCoveredCallStrike(snapshots, stockPrice, config, gexData = null) {
    const candidates = Object.entries(snapshots)
      .filter(([sym, snap]) => {
        const d = snap.greeks;
        const q = snap.latestQuote;
        if (!d || !q) return false;
        const strike = parseFloat(snap.details?.strike_price || extractStrikeFromOCC(sym));
        return (
          strike > stockPrice &&
          d.delta >= config.targetDelta[0] &&
          d.delta <= config.targetDelta[1] &&
          snap.openInterest >= config.minOpenInterest &&
          (snap.dayVolume || 0) >= config.minVolume
        );
      })
      .map(([sym, snap]) => {
        const mid      = (snap.latestQuote.bp + snap.latestQuote.ap) / 2;
        const spread   = (snap.latestQuote.ap - snap.latestQuote.bp) / mid;
        const strike   = parseFloat(snap.details?.strike_price || extractStrikeFromOCC(sym));
        const dte      = daysUntil(snap.details?.expiration_date);
        const annYield = (mid * 100) / stockPrice / (dte / 365);
        return { sym, snap, mid, spread, strike, dte, annYield, delta: snap.greeks.delta };
      })
      .filter(c =>
        c.spread <= config.maxSpreadPct &&
        c.mid * 100 >= config.minPremiumDollars &&
        c.annYield >= config.minAnnualizedYield
      );

    if (!candidates.length) return null;

    // GEX wall anchor: find candidate closest to call wall
    if (config.useGEX && gexData?.callWalls?.length) {
      const callWallStrike = gexData.callWalls[0].strike;
      const wallAnchored   = candidates
        .filter(c => Math.abs(c.strike - callWallStrike) <= config.gexWallTolerance)
        .sort((a, b) => b.annYield - a.annYield);

      if (wallAnchored.length) {
        wallAnchored[0].gexAnchored  = true;
        wallAnchored[0].gexWall      = callWallStrike;
        return wallAnchored[0];
      }
    }

    return candidates.sort((a, b) => b.annYield - a.annYield)[0];
  }

  static selectLongCallStrike(snapshots, stockPrice, config) {
    return Object.entries(snapshots)
      .filter(([sym, snap]) => {
        const d = snap.greeks;
        const q = snap.latestQuote;
        if (!d || !q) return false;
        return (
          d.delta >= config.longCallDelta[0] &&
          d.delta <= config.longCallDelta[1] &&
          snap.openInterest >= config.minOpenInterest * 2 &&
          (snap.dayVolume || 0) >= config.minVolume * 2
        );
      })
      .map(([sym, snap]) => {
        const ask    = snap.latestQuote.ap;
        const spread = (snap.latestQuote.ap - snap.latestQuote.bp) / ((snap.latestQuote.ap + snap.latestQuote.bp) / 2);
        const strike = parseFloat(snap.details?.strike_price || extractStrikeFromOCC(sym));
        const dte    = daysUntil(snap.details?.expiration_date);
        return { sym, snap, ask, spread, strike, dte, delta: snap.greeks.delta };
      })
      .filter(c => c.spread <= config.maxSpreadPct)
      .sort((a, b) => b.delta - a.delta)[0] || null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function daysUntil(dateStr) {
  if (!dateStr) return 0;
  return Math.round((new Date(dateStr) - new Date()) / (1000 * 60 * 60 * 24));
}

function extractStrikeFromOCC(occSymbol) {
  const raw = occSymbol.slice(-8);
  return (parseInt(raw) / 1000).toFixed(2);
}

// ─── Options Manager ──────────────────────────────────────────────────────────

class OptionsManager extends EventEmitter {
  constructor(orderManager, userConfig = {}) {
    super();
    this.om      = orderManager;
    this.broker  = orderManager.broker;
    this.logger  = orderManager.logger;
    this.log     = orderManager.log;
    this.config  = { ...OPTIONS_CONFIG, ...userConfig };
    this.fetcher = new OptionsChainFetcher(this.broker.headers);
    this.gex     = process.env.TRADIER_TOKEN
      ? new GEXAnalyzer(process.env.TRADIER_TOKEN)
      : null;

    if (!this.config.enabled) {
      this.logger.warn('OptionsManager: disabled. Set OPTIONS_ENABLED=true to activate.');
    }
    if (!this.gex) {
      this.logger.warn('OptionsManager: no TRADIER_TOKEN — GEX strike anchoring disabled, using delta fallback.');
    } else {
      this.logger.info('OptionsManager: GEX strike anchoring active via Tradier.');
    }
  }

  _assertEnabled() {
    if (!this.config.enabled) throw new Error('Options trading is disabled');
    if (this.om.halted) throw new Error('System is halted');
  }

  async _getStockPrice(symbol) {
    const quote = await this.broker.getLatestQuote(symbol);
    const mid   = (parseFloat(quote.bp) + parseFloat(quote.ap)) / 2;
    if (mid < this.config.minStockPrice) {
      throw new Error(`${symbol} price $${mid.toFixed(2)} below minimum $${this.config.minStockPrice}`);
    }
    return mid;
  }

  async _checkCashForCSP(strike, contracts = 1) {
    const account  = await this.broker.getAccount();
    const cash     = parseFloat(account.cash);
    const required = strike * 100 * contracts * this.config.cspCashRequirement;
    if (cash < required) {
      throw new Error(`Insufficient cash for CSP: need $${required.toFixed(0)}, have $${cash.toFixed(0)}`);
    }
    return true;
  }

  async _checkPositionForCC(symbol) {
    const position = await this.broker.getPosition(symbol);
    if (!position) throw new Error(`No stock position in ${symbol}`);
    const shares      = parseInt(position.qty);
    const maxContracts = Math.floor(shares / 100);
    if (maxContracts < 1) throw new Error(`Need 100+ shares of ${symbol} for covered call`);
    return { shares, maxContracts };
  }

  async _getGEX(symbol, stockPrice) {
    if (!this.gex || !this.config.useGEX) return null;
    try {
      const data = await this.gex.analyze(symbol, stockPrice);
      if (data.error) {
        this.logger.warn(`GEX unavailable for ${symbol}: ${data.error}`);
        return null;
      }
      this.logger.info(`GEX ${symbol}: regime=${data.regime} putWall=${data.putWalls?.[0]?.strike} callWall=${data.callWalls?.[0]?.strike}`);
      return data;
    } catch (e) {
      this.logger.warn(`GEX fetch failed for ${symbol}: ${e.message}`);
      return null;
    }
  }

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

    this.logger.info(`Submitting ${strategy}`, { underlying: symbol, contractSymbol, side, qty, limitPrice });
    const order    = await this.broker.submitOrder(orderParams);
    const logEntry = this.log.logOrder({ ...orderParams, orderId: order.id, strategy, underlying: symbol });
    this.emit('options_order', logEntry);
    return { order, logEntry };
  }

  // ── Cash-Secured Put ──────────────────────────────────────────────────────

  async sellCashSecuredPut(symbol, contracts = 1) {
    this._assertEnabled();
    if (!this.config.strategies.cashSecuredPut) throw new Error('CSP strategy disabled');

    const stockPrice = await this._getStockPrice(symbol);
    const gexData    = await this._getGEX(symbol, stockPrice);

    // Block CSP if negative GEX regime — stock prone to big moves
    if (gexData?.regime === 'VOLATILE') {
      this.logger.warn(`${symbol} in negative GEX regime — CSP risk elevated, skipping`, { regime: gexData.regime });
      return { action: 'SKIP', symbol, reason: 'Negative GEX regime — CSP too risky in volatile mode' };
    }

    this.logger.info('Scanning for CSP strikes', { symbol, stockPrice, contracts, gexRegime: gexData?.regime });

    const snapshots = await this.fetcher.getChain(symbol, this.config.targetDTE);
    if (!Object.keys(snapshots).length) throw new Error(`No options chain data for ${symbol}`);

    const best = StrikeSelector.selectCSPStrike(snapshots, stockPrice, this.config, gexData);
    if (!best) throw new Error(`No suitable CSP strike for ${symbol} — check liquidity/spread filters`);

    await this._checkCashForCSP(best.strike, contracts);

    const limitPrice = parseFloat((best.mid * 0.98).toFixed(2));
    const { order }  = await this._submitOptionsOrder({
      symbol, contractSymbol: best.sym, side: 'sell',
      qty: contracts, orderType: 'limit', limitPrice, strategy: 'CSP',
    });

    const result = {
      strategy:        'CSP',
      symbol,
      contractSymbol:  best.sym,
      strike:          best.strike,
      dte:             best.dte,
      delta:           best.delta.toFixed(3),
      premium:         best.mid.toFixed(2),
      creditReceived:  (best.mid * 100 * contracts).toFixed(2),
      annualizedYield: (best.annYield * 100).toFixed(1) + '%',
      maxLoss:         ((best.strike - best.mid) * 100 * contracts).toFixed(2),
      breakeven:       (best.strike - best.mid).toFixed(2),
      gexAnchored:     best.gexAnchored || false,
      gexWall:         best.gexWall || null,
      gexRegime:       gexData?.regime || 'UNKNOWN',
      orderId:         order.id,
    };

    this.logger.info('CSP submitted', result);
    return result;
  }

  // ── Covered Call ──────────────────────────────────────────────────────────

  async sellCoveredCall(symbol, contracts = 1) {
    this._assertEnabled();
    if (!this.config.strategies.coveredCall) throw new Error('Covered call strategy disabled');

    const stockPrice            = await this._getStockPrice(symbol);
    const { shares, maxContracts } = await this._checkPositionForCC(symbol);
    const safeContracts         = Math.min(contracts, maxContracts, this.config.maxContractsPerTicker);
    const gexData               = await this._getGEX(symbol, stockPrice);

    this.logger.info('Scanning for CC strikes', { symbol, stockPrice, shares, safeContracts, gexRegime: gexData?.regime });

    const snapshots = await this.fetcher.getChain(symbol, this.config.targetDTE);
    if (!Object.keys(snapshots).length) throw new Error(`No options chain data for ${symbol}`);

    const best = StrikeSelector.selectCoveredCallStrike(snapshots, stockPrice, this.config, gexData);
    if (!best) throw new Error(`No suitable CC strike for ${symbol}`);

    const limitPrice = parseFloat((best.mid * 0.98).toFixed(2));
    const { order }  = await this._submitOptionsOrder({
      symbol, contractSymbol: best.sym, side: 'sell',
      qty: safeContracts, orderType: 'limit', limitPrice, strategy: 'CC',
    });

    const result = {
      strategy:        'CC',
      symbol,
      contractSymbol:  best.sym,
      strike:          best.strike,
      dte:             best.dte,
      delta:           best.delta.toFixed(3),
      premium:         best.mid.toFixed(2),
      creditReceived:  (best.mid * 100 * safeContracts).toFixed(2),
      annualizedYield: (best.annYield * 100).toFixed(1) + '%',
      maxProfit:       ((best.strike - stockPrice + best.mid) * 100 * safeContracts).toFixed(2),
      cappedAt:        best.strike.toFixed(2),
      gexAnchored:     best.gexAnchored || false,
      gexWall:         best.gexWall || null,
      gexRegime:       gexData?.regime || 'UNKNOWN',
      orderId:         order.id,
    };

    this.logger.info('CC submitted', result);
    return result;
  }

  // ── Long Call ─────────────────────────────────────────────────────────────

  async buyLongCall(symbol, contracts = 1) {
    this._assertEnabled();
    if (!this.config.strategies.longCall) throw new Error('Long call strategy disabled');

    const stockPrice = await this._getStockPrice(symbol);
    const account    = await this.broker.getAccount();
    const maxSpend   = parseFloat(account.equity) * this.config.maxOptionsRiskPct;

    const snapshots = await this.fetcher.getChain(symbol, this.config.targetDTE);
    if (!Object.keys(snapshots).length) throw new Error(`No options chain data for ${symbol}`);

    const best = StrikeSelector.selectLongCallStrike(snapshots, stockPrice, this.config);
    if (!best) throw new Error(`No suitable long call for ${symbol}`);

    const cost = best.ask * 100 * contracts;
    if (cost > maxSpend) throw new Error(`Long call cost $${cost.toFixed(0)} exceeds max risk $${maxSpend.toFixed(0)}`);

    const limitPrice = parseFloat((best.ask * 1.01).toFixed(2));
    const { order }  = await this._submitOptionsOrder({
      symbol, contractSymbol: best.sym, side: 'buy',
      qty: contracts, orderType: 'limit', limitPrice, strategy: 'LONG_CALL',
    });

    return {
      strategy: 'LONG_CALL', symbol, contractSymbol: best.sym,
      strike: best.strike, dte: best.dte, delta: best.delta.toFixed(3),
      premium: best.ask.toFixed(2), totalCost: cost.toFixed(2),
      maxLoss: cost.toFixed(2), breakeven: (best.strike + best.ask).toFixed(2),
      orderId: order.id,
    };
  }

  // ── Auto-select strategy based on SIGNAL score ────────────────────────────

  async evaluateOptionsStrategy(symbol, signalScore, context = {}) {
    this._assertEnabled();

    const { hasPosition = false, earningsSoon = false } = context;

    if (earningsSoon) {
      this.logger.info('Skipping options — earnings blackout', { symbol });
      return { action: 'SKIP', reason: 'earnings_blackout', symbol };
    }

    if (signalScore >= 75) {
      if (!hasPosition && this.config.strategies.cashSecuredPut) {
        return this.sellCashSecuredPut(symbol);
      }
      if (hasPosition && signalScore < 85 && this.config.strategies.coveredCall) {
        return this.sellCoveredCall(symbol);
      }
      if (hasPosition && signalScore >= 85) {
        return { action: 'HOLD_FOR_UPSIDE', symbol, signalScore, reason: 'Score >= 85 — not capping upside' };
      }
    }

    if (signalScore >= 55) {
      if (hasPosition && this.config.strategies.coveredCall) return this.sellCoveredCall(symbol);
      if (!hasPosition && this.config.strategies.cashSecuredPut) return this.sellCashSecuredPut(symbol);
    }

    return { action: 'NO_ENTRY', symbol, signalScore, reason: 'Score too low for options entry' };
  }

  // ── Position Management ───────────────────────────────────────────────────

  async manageOpenPositions() {
    this._assertEnabled();
    const positions       = await this.broker.getAllPositions();
    const optionsPositions = positions.filter(p => p.asset_class === 'us_option');
    const actions         = [];

    for (const pos of optionsPositions) {
      const costBasis    = Math.abs(parseFloat(pos.cost_basis));
      const unrealizedPL = parseFloat(pos.unrealized_pl);
      const qty          = parseInt(pos.qty);
      const isShort      = qty < 0;
      const dte          = daysUntil(pos.expiration_date);
      const pnlPct       = unrealizedPL / costBasis;

      if (isShort && pnlPct >= this.config.takeProfitPct) {
        actions.push({ action: 'CLOSE_TAKE_PROFIT', symbol: pos.symbol, pnlPct });
      } else if (isShort && Math.abs(pnlPct) >= this.config.stopLossPct) {
        actions.push({ action: 'CLOSE_STOP_LOSS', symbol: pos.symbol, pnlPct });
      } else if (dte <= this.config.rollDTEThreshold) {
        actions.push({ action: 'ROLL_NEEDED', symbol: pos.symbol, dte });
      }
    }
    return actions;
  }

  async getOptionsStatus() {
    const positions       = await this.broker.getAllPositions();
    const opts            = positions.filter(p => p.asset_class === 'us_option');
    return {
      enabled:       this.config.enabled,
      strategies:    this.config.strategies,
      gexActive:     !!this.gex && this.config.useGEX,
      openPositions: opts.length,
      positions: opts.map(p => ({
        symbol:       p.symbol,
        qty:          p.qty,
        side:         parseInt(p.qty) < 0 ? 'short' : 'long',
        avgEntry:     parseFloat(p.avg_entry_price).toFixed(2),
        currentPrice: parseFloat(p.current_price).toFixed(2),
        unrealizedPL: parseFloat(p.unrealized_pl).toFixed(2),
        marketValue:  parseFloat(p.market_value).toFixed(2),
      })),
    };
  }
}

module.exports = { OptionsManager, OPTIONS_CONFIG };
