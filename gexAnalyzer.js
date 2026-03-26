/**
 * SIGNAL GEX Module — Gamma Exposure Calculator
 * 
 * Calculates GEX from live Tradier options chain data.
 * GEX tells you where market makers are hedging, identifying
 * price magnets (positive GEX) and volatility zones (negative GEX).
 *
 * Usage:
 *   const { GEXAnalyzer } = require('./gexAnalyzer');
 *   const gex = new GEXAnalyzer(tradierToken);
 *   const analysis = await gex.analyze('AAPL', 185.50);
 */

class GEXAnalyzer {
  constructor(tradierToken) {
    this.token   = tradierToken;
    this.cache   = {}; // { symbol: { ts, data } }
    this.cacheTTL = 5 * 60 * 1000; // 5 min cache
  }

  // ── Fetch options chain from Tradier ───────────────────────────────────────

  async _fetchChain(symbol) {
    const cached = this.cache[symbol];
    if (cached && Date.now() - cached.ts < this.cacheTTL) {
      return cached.data;
    }

    const headers = {
      'Authorization': `Bearer ${this.token}`,
      'Accept': 'application/json',
    };

    // Get nearest 3 expirations
    const expRes = await fetch(
      `https://api.tradier.com/v1/markets/options/expirations?symbol=${symbol}&includeAllRoots=false`,
      { headers }
    );
    if (!expRes.ok) throw new Error(`Tradier expirations ${expRes.status}`);
    const expData = await expRes.json();
    const exps = expData.expirations?.date || [];
    const expList = (Array.isArray(exps) ? exps : [exps]).slice(0, 3);

    // Fetch chains for each expiration
    const allContracts = [];
    for (const exp of expList) {
      const chainRes = await fetch(
        `https://api.tradier.com/v1/markets/options/chains?symbol=${symbol}&expiration=${exp}&greeks=true`,
        { headers }
      );
      if (!chainRes.ok) continue;
      const chainData = await chainRes.json();
      const opts = chainData.options?.option || [];
      opts.forEach(o => { o._expiry = exp; });
      allContracts.push(...opts);
      await new Promise(r => setTimeout(r, 200));
    }

    this.cache[symbol] = { ts: Date.now(), data: allContracts };
    return allContracts;
  }

  // ── Core GEX calculation ───────────────────────────────────────────────────

  /**
   * Calculate GEX for each strike
   * GEX = gamma × open_interest × 100 × spot²× 0.01
   * Calls contribute positive GEX, puts contribute negative GEX
   * (market makers are long calls → positive gamma, long puts → negative gamma)
   */
  _calculateGEX(contracts, spotPrice) {
    const strikeMap = {};

    for (const c of contracts) {
      const gamma = c.greeks?.gamma;
      const oi    = c.open_interest || 0;
      const strike = c.strike;
      const type   = c.option_type; // 'call' or 'put'

      if (!gamma || !strike || !oi) continue;

      // GEX formula: gamma × OI × 100 × spot² × 0.01
      const gexValue = gamma * oi * 100 * Math.pow(spotPrice, 2) * 0.01;

      if (!strikeMap[strike]) {
        strikeMap[strike] = { strike, callGEX: 0, putGEX: 0, netGEX: 0, totalOI: 0 };
      }

      if (type === 'call') {
        strikeMap[strike].callGEX += gexValue;
      } else {
        strikeMap[strike].putGEX -= gexValue; // puts are negative
      }
      strikeMap[strike].totalOI += oi;
    }

    // Calculate net GEX per strike
    for (const s of Object.values(strikeMap)) {
      s.netGEX = s.callGEX + s.putGEX;
    }

    return Object.values(strikeMap).sort((a, b) => a.strike - b.strike);
  }

  // ── Find key GEX levels ───────────────────────────────────────────────────

  _findKeyLevels(strikeGEX, spotPrice) {
    if (!strikeGEX.length) return null;

    const totalGEX = strikeGEX.reduce((sum, s) => sum + s.netGEX, 0);

    // GEX flip point: where cumulative GEX crosses zero (nearest to spot)
    // Below this price = negative GEX (volatile), above = positive (pinned)
    let flipStrike = null;
    let minDist = Infinity;
    for (const s of strikeGEX) {
      const dist = Math.abs(s.strike - spotPrice);
      if (Math.abs(s.netGEX) < Math.abs(totalGEX * 0.05) && dist < minDist) {
        minDist = dist;
        flipStrike = s.strike;
      }
    }

    // Largest positive GEX wall (price magnet / resistance)
    const posWalls = strikeGEX
      .filter(s => s.netGEX > 0 && s.strike >= spotPrice * 0.85 && s.strike <= spotPrice * 1.15)
      .sort((a, b) => b.netGEX - a.netGEX);

    // Largest negative GEX zone (volatility accelerator)
    const negZones = strikeGEX
      .filter(s => s.netGEX < 0 && s.strike >= spotPrice * 0.85 && s.strike <= spotPrice * 1.15)
      .sort((a, b) => a.netGEX - b.netGEX);

    // Put wall (largest put OI below spot — dealers short puts → buy on dip)
    const putWalls = strikeGEX
      .filter(s => s.strike < spotPrice && s.putGEX < 0)
      .sort((a, b) => a.putGEX - b.putGEX)
      .slice(0, 3);

    // Call wall (largest call OI above spot — dealers short calls → sell on rally)
    const callWalls = strikeGEX
      .filter(s => s.strike > spotPrice && s.callGEX > 0)
      .sort((a, b) => b.callGEX - a.callGEX)
      .slice(0, 3);

    return {
      totalGEX:   parseFloat(totalGEX.toFixed(2)),
      flipStrike,
      posWalls:   posWalls.slice(0, 3).map(s => ({ strike: s.strike, gex: parseFloat(s.netGEX.toFixed(2)) })),
      negZones:   negZones.slice(0, 3).map(s => ({ strike: s.strike, gex: parseFloat(s.netGEX.toFixed(2)) })),
      putWalls:   putWalls.map(s => ({ strike: s.strike, gex: parseFloat(s.putGEX.toFixed(2)) })),
      callWalls:  callWalls.map(s => ({ strike: s.strike, gex: parseFloat(s.callGEX.toFixed(2)) })),
    };
  }

  // ── Trading signals from GEX ──────────────────────────────────────────────

  _generateSignals(levels, spotPrice) {
    if (!levels) return { regime: 'UNKNOWN', signals: [], cspGuide: null, ccGuide: null };

    const signals  = [];
    const isPositiveGEX = levels.totalGEX > 0;

    // Regime
    const regime = isPositiveGEX ? 'PINNED' : 'VOLATILE';

    // Distance to nearest positive wall (support/resistance)
    const nearestPosWall = levels.posWalls[0];
    const nearestPutWall = levels.putWalls[0];
    const nearestCallWall = levels.callWalls[0];

    if (isPositiveGEX) {
      signals.push('Positive GEX regime — price likely to stay range-bound near ' +
        (nearestPosWall ? `$${nearestPosWall.strike}` : 'current levels'));
    } else {
      signals.push('Negative GEX regime — expect larger price swings, momentum moves likely');
    }

    // Flip point warning
    if (levels.flipStrike) {
      const pctFromFlip = ((spotPrice - levels.flipStrike) / spotPrice * 100).toFixed(1);
      if (Math.abs(parseFloat(pctFromFlip)) < 3) {
        signals.push(`Price is ${pctFromFlip}% from GEX flip point at $${levels.flipStrike} — volatility expansion possible`);
      }
    }

    // Put wall support
    if (nearestPutWall) {
      const pct = ((spotPrice - nearestPutWall.strike) / spotPrice * 100).toFixed(1);
      signals.push(`Put wall support at $${nearestPutWall.strike} (${pct}% below) — dealers will buy dips here`);
    }

    // Call wall resistance
    if (nearestCallWall) {
      const pct = ((nearestCallWall.strike - spotPrice) / spotPrice * 100).toFixed(1);
      signals.push(`Call wall resistance at $${nearestCallWall.strike} (${pct}% above) — dealers will sell rallies here`);
    }

    // CSP guidance — best strike is just above put wall
    let cspGuide = null;
    if (nearestPutWall) {
      const suggestedStrike = nearestPutWall.strike;
      const pct = ((spotPrice - suggestedStrike) / spotPrice * 100).toFixed(1);
      cspGuide = {
        suggestedStrike,
        reasoning: `Put wall at $${suggestedStrike} (${pct}% OTM) — market makers defend this level, giving your CSP a natural floor`,
        avoid: levels.negZones[0]
          ? `Avoid strikes below $${levels.negZones[0].strike} — negative GEX zone, moves accelerate there`
          : null,
      };
    }

    // CC guidance — best strike is just below call wall
    let ccGuide = null;
    if (nearestCallWall) {
      const suggestedStrike = nearestCallWall.strike;
      const pct = ((suggestedStrike - spotPrice) / spotPrice * 100).toFixed(1);
      ccGuide = {
        suggestedStrike,
        reasoning: `Call wall at $${suggestedStrike} (${pct}% OTM) — dealers sell here, limiting your upside capture risk`,
        avoid: isPositiveGEX
          ? null
          : `Caution — negative GEX regime means stock could break through call wall on strong momentum`,
      };
    }

    return { regime, signals, cspGuide, ccGuide };
  }

  // ── Main analysis entry point ─────────────────────────────────────────────

  /**
   * Full GEX analysis for a ticker
   * @param {string} symbol
   * @param {number} spotPrice  Current stock price
   * @returns {object}  Complete GEX analysis with trading guidance
   */
  async analyze(symbol, spotPrice) {
    if (!this.token) {
      return { error: 'No Tradier token — set TRADIER_TOKEN env var', symbol };
    }

    try {
      const contracts  = await this._fetchChain(symbol);
      if (!contracts.length) return { error: 'No options data', symbol };

      const strikeGEX  = this._calculateGEX(contracts, spotPrice);
      const levels     = this._findKeyLevels(strikeGEX, spotPrice);
      const trading    = this._generateSignals(levels, spotPrice);

      return {
        symbol,
        spotPrice,
        ts:           new Date().toISOString(),
        totalGEX:     levels?.totalGEX,
        regime:       trading.regime,
        flipStrike:   levels?.flipStrike,
        posWalls:     levels?.posWalls,
        negZones:     levels?.negZones,
        putWalls:     levels?.putWalls,
        callWalls:    levels?.callWalls,
        signals:      trading.signals,
        cspGuide:     trading.cspGuide,
        ccGuide:      trading.ccGuide,
        strikeCount:  strikeGEX.length,
      };
    } catch (e) {
      return { error: e.message, symbol };
    }
  }

  // ── Batch analysis for watchlist ─────────────────────────────────────────

  /**
   * Analyze GEX for multiple tickers
   * @param {Array} tickers  [{ symbol, price }]
   */
  async analyzeWatchlist(tickers) {
    const results = {};
    for (const { symbol, price } of tickers) {
      results[symbol] = await this.analyze(symbol, price);
      await new Promise(r => setTimeout(r, 300)); // rate limit
    }
    return results;
  }

  // ── Integration helper: enhance order manager decision with GEX ──────────

  /**
   * Given an order manager decision, layer in GEX context
   * Returns enhanced decision with GEX-adjusted strike guidance
   * @param {object} decision  From orderManager.evaluate()
   * @param {number} spotPrice
   */
  async enhanceDecision(decision, spotPrice) {
    if (!['BUY', 'CSP', 'CC'].includes(decision.action)) return decision;

    const gex = await this.analyze(decision.ticker, spotPrice);
    if (gex.error) return { ...decision, gex: { error: gex.error } };

    // Warn if selling CSP into negative GEX zone
    if (decision.action === 'CSP' && gex.regime === 'VOLATILE') {
      decision.gexWarning = 'Negative GEX regime — stock prone to large moves, widen CSP strike or reduce size';
    }

    // Warn if selling CC near strong positive GEX wall that could cap a big move
    if (decision.action === 'CC' && gex.ccGuide) {
      decision.gexCCStrike = gex.ccGuide.suggestedStrike;
      decision.gexCCNote   = gex.ccGuide.reasoning;
    }

    // Add put wall as CSP strike anchor
    if (decision.action === 'CSP' && gex.cspGuide) {
      decision.gexCSPStrike = gex.cspGuide.suggestedStrike;
      decision.gexCSPNote   = gex.cspGuide.reasoning;
    }

    return { ...decision, gex: { regime: gex.regime, signals: gex.signals, flipStrike: gex.flipStrike } };
  }
}

module.exports = { GEXAnalyzer };
