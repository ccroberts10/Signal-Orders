/**
 * SIGNAL Order Manager — Express Routes
 * Drop this into your existing SIGNAL Express app:
 *   const orderRoutes = require('./routes/orders');
 *   app.use('/api/orders', orderRoutes);
 */

const express = require('express');
const router  = express.Router();
const { OrderManager } = require('../orderManager');

// Single shared instance (persists state across requests)
let om = null;

function getInstance() {
  if (!om) {
    om = new OrderManager({
      paperTrading: process.env.PAPER_TRADING !== 'false', // default paper
      watchlist: (process.env.WATCHLIST || 'RMBS,VICR,ATOM,POET').split(','),
      buyThreshold:  parseInt(process.env.BUY_THRESHOLD  || '75'),
      sellThreshold: parseInt(process.env.SELL_THRESHOLD || '35'),
    });

    // Forward events to SSE clients (if you have an SSE endpoint in SIGNAL)
    om.on('decision', (d) => console.log('[ORDER-MGR] Decision:', d));
    om.on('order',    (o) => console.log('[ORDER-MGR] Order:',    o));
    om.on('halt',     (h) => console.error('[ORDER-MGR] HALT:', h));
  }
  return om;
}

// ─── POST /api/orders/evaluate ────────────────────────────────────────────────
// Called by SIGNAL scanner after scoring a ticker
// Body: { ticker: "RMBS", score: 82, meta: { earnings_date: "2025-05-01" } }
router.post('/evaluate', async (req, res) => {
  const { ticker, score, meta = {} } = req.body;
  if (!ticker || score === undefined) {
    return res.status(400).json({ error: 'ticker and score are required' });
  }
  try {
    const result = await getInstance().evaluate(ticker, score, meta);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/orders/evaluate-all ───────────────────────────────────────────
// Full watchlist batch evaluation
// Body: { scores: { RMBS: 82, VICR: 44, ATOM: 71, POET: 28 }, meta: {} }
router.post('/evaluate-all', async (req, res) => {
  const { scores, meta = {} } = req.body;
  if (!scores) return res.status(400).json({ error: 'scores object required' });
  try {
    const results = await getInstance().evaluateAll(scores, meta);
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /api/orders/status ───────────────────────────────────────────────────
router.get('/status', async (req, res) => {
  try {
    const status = await getInstance().getStatus();
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/orders/halt ────────────────────────────────────────────────────
router.post('/halt', async (req, res) => {
  const { reason = 'Manual halt via API' } = req.body;
  try {
    await getInstance().halt(reason);
    res.json({ halted: true, reason });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/orders/resume ──────────────────────────────────────────────────
router.post('/resume', async (req, res) => {
  getInstance().resume();
  res.json({ halted: false });
});

// ─── GET /api/orders/log ──────────────────────────────────────────────────────
router.get('/log', (req, res) => {
  const log = getInstance().log;
  res.json({
    decisions: log.decisions.slice(-50),
    orders:    log.orders.slice(-50),
    fills:     log.fills.slice(-50),
    summary:   log.summary(),
  });
});

module.exports = router;
