/**
 * SIGNAL Options Routes
 * Mount in Express app:
 *   app.use('/api/options', require('./routes/options'));
 */

const express = require('express');
const router  = express.Router();
const { OrderManager }   = require('../orderManager');
const { OptionsManager } = require('../optionsManager');

let optMgr = null;

function getInstance() {
  if (!optMgr) {
    const om = require('./orders').getInstance?.() || new OrderManager({
      paperTrading: process.env.PAPER_TRADING !== 'false',
      watchlist:    (process.env.WATCHLIST || 'RMBS,VICR,ATOM,POET').split(','),
    });

    optMgr = new OptionsManager(om, {
      enabled:           process.env.OPTIONS_ENABLED === 'true',
      maxContractsPerTicker: parseInt(process.env.MAX_CONTRACTS || '1'),
      minAnnualizedYield:    parseFloat(process.env.MIN_YIELD   || '0.20'),
    });
  }
  return optMgr;
}

// POST /api/options/csp
// Body: { symbol: "RMBS", contracts: 1 }
router.post('/csp', async (req, res) => {
  const { symbol, contracts = 1 } = req.body;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  try {
    const result = await getInstance().sellCashSecuredPut(symbol, contracts);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/options/cc
// Body: { symbol: "RMBS", contracts: 1 }
router.post('/cc', async (req, res) => {
  const { symbol, contracts = 1 } = req.body;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  try {
    const result = await getInstance().sellCoveredCall(symbol, contracts);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/options/long-call
// Body: { symbol: "VICR", contracts: 1 }
router.post('/long-call', async (req, res) => {
  const { symbol, contracts = 1 } = req.body;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  try {
    const result = await getInstance().buyLongCall(symbol, contracts);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/options/evaluate
// Body: { symbol: "RMBS", score: 82, context: { hasPosition: true, earningsSoon: false } }
router.post('/evaluate', async (req, res) => {
  const { symbol, score, context = {} } = req.body;
  if (!symbol || score === undefined) return res.status(400).json({ error: 'symbol and score required' });
  try {
    const result = await getInstance().evaluateOptionsStrategy(symbol, score, context);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/options/manage — run take-profit / stop-loss checks
router.post('/manage', async (req, res) => {
  try {
    const actions = await getInstance().manageOpenPositions();
    res.json({ actions });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/options/status
router.get('/status', async (req, res) => {
  try {
    const status = await getInstance().getOptionsStatus();
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
