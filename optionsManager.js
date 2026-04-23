/**
 * SIGNAL Options Manager — Optimized V2
 *
 * Strategy selection by score:
 *   Score 90-100 + no position  → Buy long call (momentum capture)
 *   Score 75-89  + no position  → Sell CSP (premium collection, bullish entry)
 *   Score 55-89  + has position → Sell covered call (premium on existing holdings)
 *   Score 90-100 + has position → Hold for upside (don't cap big winners)
 *   Score < 55                  → No entry
 *
 * Improvements over V1:
 *   - Relaxed filters: lower min OI (10), lower min volume (1), wider spread (15%)
 *   - Lower min yield (8%) to find more trades
 *   - GEX-anchored strikes with wider tolerance ($5 wall tolerance)
 *   - Long calls enabled on 90+ scores
 *   - Better error logging to diagnose skips
 *   - Auto-roll logic at 7 DTE
 */

const EventEmitter   = require('events');
const { GEXAnalyzer } = require('./gexAnalyzer');

const OPTIONS_CONFIG = {
  enabled: false,

  strategies: {
    cashSecuredPut: true,
    coveredCall:    true,
    longCall:       true,   // Enabled — buys on 90+ scores
  },

  // Score thresholds for strategy selection
  longCallMinScore:    90,   // Buy calls when score >= 90
  cspMinScore:         75,   // Sell CSP when score >= 75, no position
  ccMinScore:          55,   // Sell CC when score >= 55, has position
  holdForUpsideScore:  90,   // Don't sell CC on existing position if score >= 90

  // Contract selection — relaxed filters
  targetDTE:       [21, 60],    // Wider window: 21-60 days
  targetDelta:     [0.20, 0.45],// Wider delta range
  longCallDelta:   [0.40, 0.70],// Long calls: 40-70 delta
  minOpenInterest: 10,          // Relaxed from 50
  minVolume:       1,           // Relaxed from 5
  maxSpreadPct:    0.15,        // Relaxed from 0.10

  // GEX settings
  useGEX:           true,
  gexWallTolerance: 5.0,        // Wider tolerance: within $5 of GEX wall

  // Sizing
  maxContractsPerTicker: 1,
  maxOptionsRiskPct:     0.05,  // Max 5% of portfolio per long call
  cspCashRequirement:    1.0,   // Must have full cash to secure put

  // Premium filters — relaxed
  minAnnualizedYield: 0.08,    // Relaxed from 14% to 8%
  minPremiumDollars:  15,      // Relaxed from 25 to 15

  // Management
  takeProfitPct:     0.50,     // Close short options at 50% profit
  stopLossPct:       2.00,     // Close if 2x the credit received
  rollDTEThreshold:  7,        // Roll when 7 days left

  // Guards
  minStockPrice:         1.00,
  requireLiquidityCheck: true,
};

// ─── Options Chain Fetcher ────────────────────────────────────────────────────

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

  async getChain(symbol, targetDTE = [21, 60]) {
    const today  = new Date();
    const minExp = new Date(today); minExp.setDate(today.getDate() + targetDTE[0]);
    const maxExp = new Date(today); maxExp.setDate(today.getDate() + targetDTE[1]);
    const data   = await this._fetch(
      `/v1beta1/options/snapshots/${symbol}?expiration_date_gte=${minExp.toISOString().split('T')[0]}&expiration_date_lte=${maxExp.toISOString().split('T')[0]}&limit=200`
    );
    return data.snapshots || {};
  }
}

// ─── Strike Selector ─────────────────────────────────────────────────────────

class StrikeSelector {

  static _mapContracts(snapshots, type, stockPrice, config) {
    return Object.entries(snapshots)
      .filter(([sym, snap]) => {
        const d = snap.greeks;
        const q = snap.latestQuote;
        if (!d || !q) return false;
        const absDelta = Math.abs(d.delta || 0);
        if (type === 'put') {
          return absDelta >= config.targetDelta[0] && absDelta <= config.targetDelta[1];
        }
        if (type === 'call_short') {
          const strike = parseFloat(snap.details?.strike_price || extractStrikeFromOCC(sym));
          return strike > stockPrice && d.delta >= config.targetDelta[0] && d.delta <= config.targetDelta[1];
        }
        if (type === 'call_long') {
          return d.delta >= config.longCallDelta[0] && d.delta <= config.longCallDelta[1];
        }
        return false;
      })
      .map(([sym, snap]) => {
        const bid    = snap.latestQuote.bp || 0;
        const ask    = snap.latestQuote.ap || 0;
        const mid    = (bid + ask) / 2;
        const spread = mid > 0 ? (ask - bid) / mid : 1;
        const strike = parseFloat(snap.details?.strike_price || extractStrikeFromOCC(sym));
        const dte    = daysUntil(snap.details?.expiration_date);
        const oi     = snap.openInterest || 0;
        const vol    = snap.dayVolume    || 0;
        const annYield = type === 'put'
          ? (mid * 100) / strike / (dte / 365)
          : (mid * 100) / stockPrice / (dte / 365);

        return { sym, snap, mid, spread, strike, dte, oi, vol, annYield, delta: Math.abs(snap.greeks?.delta || 0) };
      })
      .filter(c => {
        const passes = (
          c.oi     >= config.minOpenInterest &&
          c.vol    >= config.minVolume &&
          c.spread <= config.maxSpreadPct &&
          c.mid    >  0 &&
          c.mid * 100 >= config.minPremiumDollars &&
          c.annYield   >= config.minAnnualizedYield &&
          c.dte    >= config.targetDTE[0]
        );
        return passes;
      });
  }

  static selectCSPStrike(snapshots, stockPrice, config, gexData = null) {
    const candidates = this._mapContracts(snapshots, 'put', stockPrice, config)
      .filter(c => c.strike < stockPrice); // OTM puts only

    if (!candidates.length) return null;

    // GEX wall anchor
    if (config.useGEX && gexData?.putWalls?.length) {
      const putWall    = gexData.putWalls[0].strike;
      const inNegZone  = (gexData.negZones || []).some(z => Math.abs(z.strike - putWall) < config.gexWallTolerance);
      if (!inNegZone) {
        const anchored = candidates
          .filter(c => Math.abs(c.strike - putWall) <= config.gexWallTolerance)
          .sort((a, b) => b.annYield - a.annYield);
        if (anchored.length) {
          anchored[0].gexAnchored = true;
          anchored[0].gexWall     = putWall;
          return anchored[0];
        }
      }
    }

    return candidates.sort((a, b) => b.annYield - a.annYield)[0];
  }

  static selectCoveredCallStrike(snapshots, stockPrice, config, gexData = null) {
    const candidates = this._mapContracts(snapshots, 'call_short', stockPrice, config);

    if (!candidates.length) return null;

    // GEX wall anchor
    if (config.useGEX && gexData?.callWalls?.length) {
      const callWall = gexData.callWalls[0].strike;
      const anchored = candidates
        .filter(c => Math.abs(c.strike - callWall) <= config.gexWallTolerance)
        .sort((a, b) => b.annYield - a.annYield);
      if (anchored.length) {
        anchored[0].gexAnchored = true;
        anchored[0].gexWall     = callWall;
        return anchored[0];
      }
    }

    return candidates.sort((a, b) => b.annYield - a.annYield)[0];
  }

  static selectLongCallStrike(snapshots, stockPrice, config) {
    const candidates = this._mapContracts(snapshots, 'call_long', stockPrice, config)
      .filter(c => c.spread <= config.maxSpreadPct)
      .sort((a, b) => b.delta - a.delta);
    return candidates[0] || null;
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
    } else {
      this.logger.info('OptionsManager V2 initialized', {
        strategies:     this.config.strategies,
        gexActive:      !!this.gex,
        minYield:       (this.config.minAnnualizedYield * 100).toFixed(0) + '%',
        deltaRange:     this.config.targetDelta.join('-'),
        dteWindow:      this.config.targetDTE.join('-'),
        longCallScore:  this.config.longCallMinScore,
        cspScore:       this.config.cspMinScore,
        ccScore:        this.config.ccMinScore,
      });
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
    const shares       = parseInt(position.qty);
    const maxContracts = Math.floor(shares / 100);
    if (maxContracts < 1) throw new Error(`Need 100+ shares of ${symbol} for covered call`);
    return { shares, maxContracts };
  }

  async _getGEX(symbol, stockPrice) {
    if (!this.gex || !this.config.useGEX) return null;
    try {
      const data = await this.gex.analyze(symbol, stockPrice);
      if (data.error) { this.logger.warn(`GEX unavailable for ${symbol}: ${data.error}`); return null; }
      this.logger.info(`GEX ${symbol}: regime=${data.regime} putWall=${data.putWalls?.[0]?.strike} callWall=${data.callWalls?.[0]?.strike}`);
      return data;
    } catch (e) {
      this.logger.warn(`GEX failed for ${symbol}: ${e.message}`);
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
    if (!this.config.strategies.cashSecuredPut) throw new Error('CSP disabled');

    const stockPrice = await this._getStockPrice(symbol);
    const gexData    = await this._getGEX(symbol, stockPrice);

    if (gexData?.regime === 'VOLATILE') {
      this.logger.warn(`${symbol} negative GEX regime — skipping CSP`);
      return { action: 'SKIP', symbol, reason: 'Negative GEX regime — too volatile for CSP' };
    }

    this.logger.info('Scanning for CSP strikes', { symbol, stockPrice, contracts, gexRegime: gexData?.regime });

    const snapshots = await this.fetcher.getChain(symbol, this.config.targetDTE);
    const count     = Object.keys(snapshots).length;
    this.logger.info(`Options chain for ${symbol}: ${count} contracts found`);

    if (!count) throw new Error(`No options chain data for ${symbol}`);

    const best = StrikeSelector.selectCSPStrike(snapshots, stockPrice, this.config, gexData);
    if (!best) {
      // Log what was available to help diagnose
      const allPuts = Object.entries(snapshots).filter(([s, snap]) => {
        const strike = parseFloat(snap.details?.strike_price || '0');
        return strike < stockPrice && snap.greeks?.delta;
      }).length;
      throw new Error(`No suitable CSP strike for ${symbol} — ${allPuts} OTM puts found but none passed filters (yield≥${(this.config.minAnnualizedYield*100).toFixed(0)}%, OI≥${this.config.minOpenInterest}, spread≤${(this.config.maxSpreadPct*100).toFixed(0)}%)`);
    }

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
      gexWall:         best.gexWall     || null,
      gexRegime:       gexData?.regime  || 'UNKNOWN',
      orderId:         order.id,
    };
    this.logger.info('CSP submitted', result);
    return result;
  }

  // ── Covered Call ──────────────────────────────────────────────────────────

  async sellCoveredCall(symbol, contracts = 1) {
    this._assertEnabled();
    if (!this.config.strategies.coveredCall) throw new Error('Covered call disabled');

    const stockPrice               = await this._getStockPrice(symbol);
    const { shares, maxContracts } = await this._checkPositionForCC(symbol);
    const safeContracts            = Math.min(contracts, maxContracts, this.config.maxContractsPerTicker);
    const gexData                  = await this._getGEX(symbol, stockPrice);

    this.logger.info('Scanning for CC strikes', { symbol, stockPrice, shares, safeContracts, gexRegime: gexData?.regime });

    const snapshots = await this.fetcher.getChain(symbol, this.config.targetDTE);
    const count     = Object.keys(snapshots).length;
    this.logger.info(`Options chain for ${symbol}: ${count} contracts found`);

    if (!count) throw new Error(`No options chain data for ${symbol}`);

    const best = StrikeSelector.selectCoveredCallStrike(snapshots, stockPrice, this.config, gexData);
    if (!best) {
      const allCalls = Object.entries(snapshots).filter(([s, snap]) => {
        const strike = parseFloat(snap.details?.strike_price || '0');
        return strike > stockPrice && snap.greeks?.delta;
      }).length;
      throw new Error(`No suitable CC strike for ${symbol} — ${allCalls} OTM calls found but none passed filters (yield≥${(this.config.minAnnualizedYield*100).toFixed(0)}%, OI≥${this.config.minOpenInterest}, spread≤${(this.config.maxSpreadPct*100).toFixed(0)}%)`);
    }

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
      gexWall:         best.gexWall     || null,
      gexRegime:       gexData?.regime  || 'UNKNOWN',
      orderId:         order.id,
    };
    this.logger.info('CC submitted', result);
    return result;
  }

  // ── Long Call ─────────────────────────────────────────────────────────────

  async buyLongCall(symbol, contracts = 1) {
    this._assertEnabled();
    if (!this.config.strategies.longCall) throw new Error('Long call disabled');

    const stockPrice = await this._getStockPrice(symbol);
    const account    = await this.broker.getAccount();
    const maxSpend   = parseFloat(account.equity) * this.config.maxOptionsRiskPct;
    const gexData    = await this._getGEX(symbol, stockPrice);

    // Skip long calls in negative GEX regime
    if (gexData?.regime === 'VOLATILE') {
      this.logger.warn(`${symbol} negative GEX — skipping long call`);
      return { action: 'SKIP', symbol, reason: 'Negative GEX regime' };
    }

    this.logger.info('Scanning for long call strikes', { symbol, stockPrice });

    const snapshots = await this.fetcher.getChain(symbol, this.config.targetDTE);
    if (!Object.keys(snapshots).length) throw new Error(`No options chain data for ${symbol}`);

    const best = StrikeSelector.selectLongCallStrike(snapshots, stockPrice, this.config);
    if (!best) throw new Error(`No suitable long call for ${symbol}`);

    const cost = best.snap.latestQuote.ap * 100 * contracts;
    if (cost > maxSpend) throw new Error(`Long call cost $${cost.toFixed(0)} exceeds max risk $${maxSpend.toFixed(0)}`);

    const limitPrice = parseFloat((best.snap.latestQuote.ap * 1.01).toFixed(2));
    const { order }  = await this._submitOptionsOrder({
      symbol, contractSymbol: best.sym, side: 'buy',
      qty: contracts, orderType: 'limit', limitPrice, strategy: 'LONG_CALL',
    });

    const result = {
      strategy:    'LONG_CALL',
      symbol,
      contractSymbol: best.sym,
      strike:      best.strike,
      dte:         best.dte,
      delta:       best.delta.toFixed(3),
      premium:     best.snap.latestQuote.ap.toFixed(2),
      totalCost:   cost.toFixed(2),
      maxLoss:     cost.toFixed(2),
      breakeven:   (best.strike + best.snap.latestQuote.ap).toFixed(2),
      gexRegime:   gexData?.regime || 'UNKNOWN',
      orderId:     order.id,
    };
    this.logger.info('Long call submitted', result);
    return result;
  }

  // ── Strategy Selection ────────────────────────────────────────────────────

  async evaluateOptionsStrategy(symbol, signalScore, context = {}) {
    this._assertEnabled();

    const { hasPosition = false, earningsSoon = false } = context;

    if (earningsSoon) {
      this.logger.info('Skipping options — earnings blackout', { symbol });
      return { action: 'SKIP', reason: 'earnings_blackout', symbol };
    }

    this.logger.info('Evaluating options strategy', { symbol, signalScore, hasPosition });

    // Score 90+ with existing position — hold for upside, don't cap with CC
    if (signalScore >= this.config.holdForUpsideScore && hasPosition) {
      return { action: 'HOLD_FOR_UPSIDE', symbol, signalScore, reason: `Score ${signalScore} >= ${this.config.holdForUpsideScore} — riding upside` };
    }

    // Score 90+ no position — buy call for momentum capture
    if (signalScore >= this.config.longCallMinScore && !hasPosition && this.config.strategies.longCall) {
      return this.buyLongCall(symbol);
    }

    // Score 75-89 no position — sell CSP for premium collection
    if (signalScore >= this.config.cspMinScore && !hasPosition && this.config.strategies.cashSecuredPut) {
      return this.sellCashSecuredPut(symbol);
    }

    // Score 55-89 with position — sell covered call for premium
    if (signalScore >= this.config.ccMinScore && hasPosition && this.config.strategies.coveredCall) {
      return this.sellCoveredCall(symbol);
    }

    return { action: 'NO_ENTRY', symbol, signalScore, reason: `Score ${signalScore} too low or no matching strategy` };
  }

  // ── Position Management ───────────────────────────────────────────────────

  async manageOpenPositions() {
    this._assertEnabled();
    const positions        = await this.broker.getAllPositions();
    const optionsPositions = positions.filter(p => p.asset_class === 'us_option');
    const actions          = [];

    for (const pos of optionsPositions) {
      const costBasis    = Math.abs(parseFloat(pos.cost_basis));
      const unrealizedPL = parseFloat(pos.unrealized_pl);
      const qty          = parseInt(pos.qty);
      const isShort      = qty < 0;
      const dte          = daysUntil(pos.expiration_date);
      const pnlPct       = costBasis > 0 ? unrealizedPL / costBasis : 0;

      if (isShort && pnlPct >= this.config.takeProfitPct) {
        actions.push({ action: 'CLOSE_TAKE_PROFIT', symbol: pos.symbol, pnlPct: (pnlPct*100).toFixed(1)+'%', dte });
      } else if (isShort && Math.abs(pnlPct) >= this.config.stopLossPct) {
        actions.push({ action: 'CLOSE_STOP_LOSS', symbol: pos.symbol, pnlPct: (pnlPct*100).toFixed(1)+'%', dte });
      } else if (dte <= this.config.rollDTEThreshold) {
        actions.push({ action: 'ROLL_NEEDED', symbol: pos.symbol, dte });
      } else {
        actions.push({ action: 'HOLD', symbol: pos.symbol, pnlPct: (pnlPct*100).toFixed(1)+'%', dte });
      }
    }
    return actions;
  }

  async getOptionsStatus() {
    const positions        = await this.broker.getAllPositions();
    const opts             = positions.filter(p => p.asset_class === 'us_option');
    return {
      enabled:       this.config.enabled,
      strategies:    this.config.strategies,
      gexActive:     !!this.gex && this.config.useGEX,
      scoreThresholds: {
        longCall:      this.config.longCallMinScore,
        csp:           this.config.cspMinScore,
        coveredCall:   this.config.ccMinScore,
        holdForUpside: this.config.holdForUpsideScore,
      },
      filters: {
        minYield:    (this.config.minAnnualizedYield*100).toFixed(0)+'%',
        minOI:       this.config.minOpenInterest,
        maxSpread:   (this.config.maxSpreadPct*100).toFixed(0)+'%',
        dteWindow:   this.config.targetDTE.join('-')+' days',
        deltaRange:  this.config.targetDelta.join('-'),
      },
      openPositions: opts.length,
      positions: opts.map(p => ({
        symbol:       p.symbol,
        qty:          p.qty,
        side:         parseInt(p.qty) < 0 ? 'short' : 'long',
        avgEntry:     parseFloat(p.avg_entry_price).toFixed(2),
        currentPrice: parseFloat(p.current_price).toFixed(2),
        unrealizedPL: parseFloat(p.unrealized_pl).toFixed(2),
        marketValue:  parseFloat(p.market_value).toFixed(2),
        dte:          daysUntil(p.expiration_date),
      })),
    };
  }
}

module.exports = { OptionsManager, OPTIONS_CONFIG };
