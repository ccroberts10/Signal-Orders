/**
 * SIGNAL Order Manager — Express Routes
 */

const express = require('express');
const router  = express.Router();
const cron    = require('node-cron');
const { OrderManager } = require('../orderManager');

let om       = null;
let pollJob  = null;

function getInstance() {
  if (!om) {
    om = new OrderManager({
      paperTrading:  process.env.PAPER_TRADING !== 'false',
      watchlist:     (process.env.WATCHLIST || 'RMBS,VICR,ATOM,POET,NVDA,AMD,AAPL,MSFT,AVGO,MU,SPY,QQQ,IWM,META,TSLA,GOOGL').split(','),
      buyThreshold:  parseInt(process.env.BUY_THRESHOLD  || '75'),
      sellThreshold: parseInt(process.env.SELL_THRESHOLD || '35'),
    });

    om.on('decision', (d) => console.log('[ORDER-MGR] Decision:', JSON.stringify(d)));
    om.on('order',    (o) => console.log('[ORDER-MGR] Order:',    JSON.stringify(o)));
    om.on('halt',     (h) => console.error('[ORDER-MGR] HALT:',   JSON.stringify(h)));

    const signalUrl = process.env.SIGNAL_URL;
    if (signalUrl) {
      pollJob = cron.schedule('*/5 9-16 * * 1-5', async () => {
        try {
          const res = await fetch(signalUrl + '/api/results');
          if (!res.ok) { console.log('[ORDER-MGR] Poll: SIGNAL returned', res.status); return; }
          const data = await res.json();
          if (!data.results || !data.results.length) { console.log('[ORDER-MGR] Poll: no results yet'); return; }
          const scores = {};
          const meta   = {};
          data.results.forEach(r => {
            if (!r.error && r.ticker) {
              scores[r.ticker] = r.score || 0;
              if (r.earnings && r.earnings.date) meta[r.ticker] = { earnings_date: r.earnings.date };
            }
          });
          console.log('[ORDER-MGR] Polled SIGNAL —', Object.keys(scores).length, 'scores');
          await om.evaluateAll(scores, meta);
        } catch (e) {
          console.error('[ORDER-MGR] Poll failed (non-fatal):', e.message);
        }
      }, { timezone: 'America/New_York' });
      console.log('[ORDER-MGR] SIGNAL poll active — every 5 min, 9am-4pm ET weekdays');
    } else {
      console.log('[ORDER-MGR] SIGNAL_URL not set — polling disabled');
    }
  }
  return om;
}

router.post('/evaluate', async (req, res) => {
  const { ticker, score, meta = {} } = req.body;
  if (!ticker || score === undefined) return res.status(400).json({ error: 'ticker and score are required' });
  try { res.json(await getInstance().evaluate(ticker, score, meta)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/evaluate-all', async (req, res) => {
  const { scores, meta = {} } = req.body;
  if (!scores) return res.status(400).json({ error: 'scores object required' });
  try { res.json({ results: await getInstance().evaluateAll(scores, meta) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/status', async (req, res) => {
  try { res.json(await getInstance().getStatus()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/halt', async (req, res) => {
  const { reason = 'Manual halt via API' } = req.body;
  try { await getInstance().halt(reason); res.json({ halted: true, reason }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/resume', async (req, res) => {
  getInstance().resume();
  res.json({ halted: false });
});

router.get('/log', (req, res) => {
  const log = getInstance().log;
  res.json({
    decisions: log.decisions.slice(-50),
    orders:    log.orders.slice(-50),
    fills:     log.fills.slice(-50),
    summary:   log.summary(),
  });
});

router.post('/poll-now', async (req, res) => {
  const signalUrl = process.env.SIGNAL_URL;
  if (!signalUrl) return res.status(400).json({ error: 'SIGNAL_URL not set' });
  try {
    const r = await fetch(signalUrl + '/api/results');
    if (!r.ok) return res.status(502).json({ error: 'SIGNAL returned ' + r.status });
    const data = await r.json();
    const scores = {};
    const meta   = {};
    (data.results || []).forEach(r => {
      if (!r.error && r.ticker) {
        scores[r.ticker] = r.score || 0;
        if (r.earnings && r.earnings.date) meta[r.ticker] = { earnings_date: r.earnings.date };
      }
    });
    res.json({ polled: true, scoresReceived: Object.keys(scores).length, results: await getInstance().evaluateAll(scores, meta) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
