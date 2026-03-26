/**
 * SIGNAL GEX Routes
 * Mount in server.js:
 *   app.use('/api/gex', require('./routes/gex'));
 */

const express = require('express');
const router  = express.Router();
const { GEXAnalyzer } = require('../gexAnalyzer');

let analyzer = null;

function getInstance() {
  if (!analyzer) {
    analyzer = new GEXAnalyzer(process.env.TRADIER_TOKEN);
  }
  return analyzer;
}

// GET /api/gex/:symbol?price=185.50
router.get('/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const price  = parseFloat(req.query.price);
  if (!price) return res.status(400).json({ error: 'price query param required e.g. ?price=185.50' });
  try {
    const result = await getInstance().analyze(symbol, price);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/gex/watchlist
// Body: [{ symbol: "AAPL", price: 185.50 }, ...]
router.post('/watchlist', async (req, res) => {
  const tickers = req.body;
  if (!Array.isArray(tickers)) return res.status(400).json({ error: 'array of { symbol, price } required' });
  try {
    const results = await getInstance().analyzeWatchlist(tickers);
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
