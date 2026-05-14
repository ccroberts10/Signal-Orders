/**
 * SIGNAL Options Manager — V3
 *
 * Changes from V2:
 *   - Full diagnostic logging in evaluateOptionsStrategy so every skip is explained
 *   - SPX market regime filter via gex-app API (hard block in TRENDING regime)
 *   - CTA composite block when dealers + trend followers both against trade
 *   - Fail-open guarantee: if gex-app unreachable, all trades proceed normally
 *   - CC path now correctly checks share count before attempting
 *   - Long call path correctly only runs when no position exists
 *
 * Strategy selection by score:
 *   Score 90-100 + no position  → Buy long call (momentum capture)
 *   Score 75-89  + no position  → Sell CSP (premium collection, bullish entry)
 *   Score 55-89  + has position + 100+ shares → Sell covered call
 *   Score 90-100 + has position → Hold for upside (don't cap big winners)
 *   Score < 55                  → No entry
 *
 * SPX Regime blocks (hard block, fail-open):
 *   TRENDING + below flip       → Block long calls
 *   TRENDING (any)              → Block CSP
 *   TRENDING + CTA short        → Block new covered calls
 */

const EventEmitter    = require('events');
const { GEXAnalyzer } = require('./gexAnalyzer');

const OPTIONS_CONFIG = {
  enabled: false,

  strategies: {
    cashSecuredPut: true,
    coveredCall:    true,
    longCall:       true,
  },

  // Score thresholds
  longCallMinScore:   90,
  cspMinScore:        75,
  ccMinScore:         55,
  holdForUpsideScore: 90,

  // Contract selection
  targetDTE:       [21, 60],
  targetDelta:     [0.20, 0.45],
  longCallDelta:   [0.40, 0.70],
  minOpenInterest: 10,
  minVolume:       1,
  maxSpreadPct:    0.15,

  // GEX settings
  useGEX:           true,
  gexWallTolerance: 5.0,

  // Sizing
  maxContractsPerTicker: 1,
  maxOptionsRiskPct:     0.05,
  cspCashRequirement:    1.0,

  // Premium filters
  minAnnualizedYield: 0.08,
  minPremiumDollars:  15,

  // Management
  takeProfitPct:    0.50,
  stopLossPct:      2.00,
  rollDTEThreshold: 7,

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
        return (
          c.oi     >= config.minOpenInterest &&
          c.vol    >= config.minVolume &&
          c.spread <= config.maxSpreadPct &&
          c.mid    >  0 &&
          c.mid * 100 >= config.minPremiumDollars &&
          c.annYield   >= config.minAnnualizedYield &&
          c.dte    >= config.targetDTE[0]
        );
      });
  }

  static selectCSPStrike(snapshots, stockPrice, config, gexData = null) {
    const candidates = this._mapContracts(snapshots, 'put', stockPrice, config)
      .filter(c => c.strike < stockPrice);

    if (!candidates.length) return null;

    if (config.useGEX && gexData?.putWalls?.length) {
      const putWall   = gexData.putWalls[0].strike;
      const inNegZone = (gexData.negZones || []).some(z => Math.abs(z.strike - putWall) < config.gexWallTolerance);
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
      this.logger.info('OptionsManager V3 initialized', {
        strategies:    this.config.strategies,
        gexActive:     !!this.gex,
        minYield:      (this.config.minAnnualizedYield * 100).toFixed(0) + '%',
        deltaRange:    this.config.targetDelta.join('-'),
        dteWindow:     this.config.targetDTE.join('-'),
        longCallScore: this.config.longCallMinScore,
        cspScore:      this.config.cspMinScore,
        ccScore:       this.config.ccMinScore,
        gexAppUrl:     process.env.GEX_APP_URL || 'https://gex-scanner-production.up.railway.app',
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

  // ── SPX Market Regime Check ───────────────────────────────────────────────
  // Calls gex-app for SPX regime + CTA. Returns null on ANY failure (fail-open).
  // A monitoring service must never block live trading due to its own outage.

  async _checkSPXRegime() {
    const url = (process.env.GEX_APP_URL || 'https://gex-scanner-production.up.railway.app') + '/api/gex';
    try {
      const ctrl    = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 4000); // 4s max
      const res     = await fetch(url, {
        signal:  ctrl.signal,
        headers: { 'Accept': 'application/json' },
      });
      clearTimeout(timeout);

      if (!res.ok) {
        this.logger.warn(`[SPX-REGIME] gex-app HTTP ${res.status} — proceeding without filter`);
        return null;
      }

      const data = await res.json();

      if (!data || data.loading || data.error || !data.regime || data.regime === 'UNAVAILABLE') {
        this.logger.warn('[SPX-REGIME] no usable data — proceeding without filter');
        return null;
      }

      const regime    = data.regime;
      const netGEX    = data.netGEXBillions || 0;
      const flipPoint = data.flipPoint       || null;
      const spot      = data.spotPrice       || null;
      const aboveFlip = (flipPoint && spot)  ? spot > flipPoint : null;
      const ctaComposite = (data.marketContext && data.marketContext.ctaComposite != null)
        ? data.marketContext.ctaComposite : null;

      this.logger.info('[SPX-REGIME]', { regime, netGEX, flipPoint, spot, aboveFlip, ctaComposite });
      return { regime, netGEX, flipPoint, spot, aboveFlip, ctaComposite };

    } catch (e) {
      this.logger.warn(`[SPX-REGIME] unreachable (${e.message}) — proceeding without filter`);
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
      strategy:       'LONG_CALL',
      symbol,
      contractSymbol: best.sym,
      strike:         best.strike,
      dte:            best.dte,
      delta:          best.delta.toFixed(3),
      premium:        best.snap.latestQuote.ap.toFixed(2),
      totalCost:      cost.toFixed(2),
      maxLoss:        cost.toFixed(2),
      breakeven:      (best.strike + best.snap.latestQuote.ap).toFixed(2),
      gexRegime:      gexData?.regime || 'UNKNOWN',
      orderId:        order.id,
    };
    this.logger.info('Long call submitted', result);
    return result;
  }

  // ── Strategy Selection ────────────────────────────────────────────────────

  async evaluateOptionsStrategy(symbol, signalScore, context = {}) {
    this._assertEnabled();

    const { hasPosition = false, earningsSoon = false } = context;

    // ── Gate 1: Earnings blackout ─────────────────────────────────────────
    if (earningsSoon) {
      this.logger.info(`[OPTIONS] ${symbol} SKIP — earnings blackout`);
      return { action: 'SKIP', reason: 'earnings_blackout', symbol };
    }

    // ── Gate 2: SPX market regime (hard block, fail-open) ─────────────────
    const spx = await this._checkSPXRegime();
    if (spx) {
      const isTrending  = spx.regime === 'TRENDING';
      const isMildTrend = spx.regime === 'MILD TREND';
      const ctaShort    = spx.ctaComposite !== null && spx.ctaComposite < -25;

      // Block long calls in bearish trending regime (below flip)
      if ((isTrending || isMildTrend) && spx.aboveFlip === false && !hasPosition) {
        this.logger.warn(`[OPTIONS] ${symbol} BLOCK long call — ${spx.regime}, below flip ${spx.flipPoint}`);
        return {
          action: 'SKIP', symbol, signalScore,
          reason: `SPX_REGIME_BLOCK: ${spx.regime} + below flip ${spx.flipPoint}`,
          spxRegime: spx.regime, spxFlip: spx.flipPoint,
        };
      }

      // Block CSP in full trending regime
      if (isTrending && !hasPosition) {
        this.logger.warn(`[OPTIONS] ${symbol} BLOCK CSP — ${spx.regime} (${spx.netGEX}B)`);
        return {
          action: 'SKIP', symbol, signalScore,
          reason: `SPX_REGIME_BLOCK: ${spx.regime} — too volatile for cash-secured puts`,
          spxRegime: spx.regime, spxNetGEX: spx.netGEX,
        };
      }

      // Block new covered calls in trending + CTA short
      if (isTrending && ctaShort && hasPosition) {
        this.logger.warn(`[OPTIONS] ${symbol} BLOCK CC — ${spx.regime} + CTA short (${spx.ctaComposite})`);
        return {
          action: 'SKIP', symbol, signalScore,
          reason: `SPX_REGIME_BLOCK: ${spx.regime} + CTA short ${spx.ctaComposite}`,
          spxRegime: spx.regime, ctaComposite: spx.ctaComposite,
        };
      }
    }

    // ── Diagnostic log — shows exactly which path each ticker takes ────────
    this.logger.info(`[OPTIONS] ${symbol} evaluating`, {
      score:       signalScore,
      hasPosition,
      thresholds: {
        holdUpside: this.config.holdForUpsideScore,
        longCall:   this.config.longCallMinScore,
        csp:        this.config.cspMinScore,
        cc:         this.config.ccMinScore,
      },
      path: hasPosition
        ? (signalScore >= this.config.holdForUpsideScore ? 'HOLD_FOR_UPSIDE' :
           signalScore >= this.config.ccMinScore         ? 'TRY_CC' : 'NO_ENTRY')
        : (signalScore >= this.config.longCallMinScore   ? 'TRY_LONG_CALL' :
           signalScore >= this.config.cspMinScore        ? 'TRY_CSP' : 'NO_ENTRY'),
      spxRegime: spx?.regime || 'N/A',
    });

    // ── Score 90+ with existing position: hold for upside ─────────────────
    if (signalScore >= this.config.holdForUpsideScore && hasPosition) {
      this.logger.info(`[OPTIONS] ${symbol} HOLD_FOR_UPSIDE — score ${signalScore} >= ${this.config.holdForUpsideScore}`);
      return {
        action: 'HOLD_FOR_UPSIDE', symbol, signalScore,
        reason: `Score ${signalScore} >= ${this.config.holdForUpsideScore} — riding upside`,
      };
    }

    // ── Score 90+ no position: buy long call ──────────────────────────────
    if (signalScore >= this.config.longCallMinScore && !hasPosition && this.config.strategies.longCall) {
      this.logger.info(`[OPTIONS] ${symbol} → LONG_CALL — score ${signalScore}`);
      return this.buyLongCall(symbol);
    }

    // ── Score 75-89 no position: sell CSP ────────────────────────────────
    if (signalScore >= this.config.cspMinScore && !hasPosition && this.config.strategies.cashSecuredPut) {
      this.logger.info(`[OPTIONS] ${symbol} → CSP — score ${signalScore}`);
      return this.sellCashSecuredPut(symbol);
    }

    // ── Score 55-89 with position: sell covered call ──────────────────────
    // Check share count first before attempting — avoids the silent skip
    if (signalScore >= this.config.ccMinScore && hasPosition && this.config.strategies.coveredCall) {
      // Pre-check shares so we log a clear reason instead of throwing inside sellCoveredCall
      try {
        const position = await this.broker.getPosition(symbol);
        const shares   = position ? parseInt(position.qty) : 0;
        if (shares < 100) {
          this.logger.info(`[OPTIONS] ${symbol} SKIP CC — only ${shares} shares (need 100+)`);
          return {
            action: 'SKIP', symbol, signalScore,
            reason: `Insufficient shares for CC: have ${shares}, need 100`,
          };
        }
        this.logger.info(`[OPTIONS] ${symbol} → CC — score ${signalScore}, shares ${shares}`);
        return this.sellCoveredCall(symbol);
      } catch (e) {
        this.logger.info(`[OPTIONS] ${symbol} SKIP CC — ${e.message}`);
        return { action: 'SKIP', symbol, signalScore, reason: e.message };
      }
    }

    // ── No matching strategy ──────────────────────────────────────────────
    this.logger.info(`[OPTIONS] ${symbol} NO_ENTRY — score ${signalScore}, hasPosition ${hasPosition}`);
    return {
      action: 'NO_ENTRY', symbol, signalScore,
      reason: `Score ${signalScore} below thresholds or no matching strategy`,
    };
  }

  // ── Position Management ───────────────────────────────────────────────────
  // NOT gated by regime — always runs regardless of SPX environment

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
    const positions = await this.broker.getAllPositions();
    const opts      = positions.filter(p => p.asset_class === 'us_option');
    return {
      enabled:    this.config.enabled,
      strategies: this.config.strategies,
      gexActive:  !!this.gex && this.config.useGEX,
      gexAppUrl:  process.env.GEX_APP_URL || 'https://gex-scanner-production.up.railway.app',
      scoreThresholds: {
        longCall:      this.config.longCallMinScore,
        csp:           this.config.cspMinScore,
        coveredCall:   this.config.ccMinScore,
        holdForUpside: this.config.holdForUpsideScore,
      },
      filters: {
        minYield:   (this.config.minAnnualizedYield*100).toFixed(0)+'%',
        minOI:      this.config.minOpenInterest,
        maxSpread:  (this.config.maxSpreadPct*100).toFixed(0)+'%',
        dteWindow:  this.config.targetDTE.join('-')+' days',
        deltaRange: this.config.targetDelta.join('-'),
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
