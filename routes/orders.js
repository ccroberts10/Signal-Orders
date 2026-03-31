/**
 * SIGNAL Order Manager — Express Routes
 */

const express = require('express');
const router  = express.Router();
const cron    = require('node-cron');
const { OrderManager }   = require('../orderManager');
const { OptionsManager } = require('../optionsManager');

let om      = null;
let optsMgr = null;

function getOM() {
  if (!om) {
    om = new OrderManager({
      paperTrading:  process.env.PAPER_TRADING !== 'false',
      watchlist:     (process.env.WATCHLIST || 'RMBS,VICR,ATOM,POET').split(','),
      buyThreshold:  parseInt(process.env.BUY_THRESHOLD  || '75'),
      sellThreshold: parseInt(process.env.SELL_THRESHOLD || '35'),
    });

    om.on('decision', (d) => console.log('[ORDER-MGR] Decision:', JSON.stringify(d)));
    om.on('order',    (o) => console.log('[ORDER-MGR] Order:',    JSON.stringify(o)));
    om.on('halt',     (h) => console.error('[ORDER-MGR] HALT:',   JSON.stringify(h)));
  }
  return om;
}

function getOpts() {
  if (!optsMgr) {
    const enabled = process.env.OPTIONS_ENABLED === 'true';
    optsMgr = new OptionsManager(getOM(), {
      enabled,
      minAnnualizedYield:    parseFloat(process.env.MIN_YIELD     || '0.14'),
      maxContractsPerTicker: parseInt(process.env.MAX_CONTRACTS   || '1'),
    });
    optsMgr.on('options_order', (o) => console.log('[OPTIONS-MGR] Order:', JSON.stringify(o)));
    console.log('[OPTIONS-MGR] Initialized — enabled:', enabled);
  }
  return optsMgr;
}

// ── Core poll function — used by both cron and poll-now ──────────────────────

async function runPoll() {
  const signalUrl = process.env.SIGNAL_URL;
  if (!signalUrl) { console.log('[ORDER-MGR] SIGNAL_URL not set'); return { scoresReceived: 0, results: [] }; }

  const r = await fetch(signalUrl + '/api/results');
  if (!r.ok) { console.log('[ORDER-MGR] Poll: SIGNAL returned', r.status); return { scoresReceived: 0, results: [] }; }

  const data = await r.json();
  if (!data.results || !data.results.length) { console.log('[ORDER-MGR] Poll: no results yet'); return { scoresReceived: 0, results: [] }; }

  const scores = {};
  const meta   = {};
  const prices = {};

  data.results.forEach(r => {
    if (!r.error && r.ticker) {
      scores[r.ticker] = r.score || 0;
      if (r.earnings && r.earnings.date) meta[r.ticker] = { earnings_date: r.earnings.date };
      if (r.livePrice && r.livePrice.price) prices[r.ticker] = parseFloat(r.livePrice.price);
    }
  });

  console.log('[ORDER-MGR] Polled SIGNAL —', Object.keys(scores).length, 'scores');

  // ── Equity decisions ─────────────────────────────────────────────────────
  const equityResults = await getOM().evaluateAll(scores, meta);

  // ── Options decisions (runs after equity) ────────────────────────────────
  const optsResults = [];
  if (process.env.OPTIONS_ENABLED === 'true') {
    const opts = getOpts();
    for (const ticker of getOM().config.watchlist) {
      const score = scores[ticker];
      if (score === undefined) continue;
      try {
        const positions  = await getOM().broker.getAllPositions();
        const hasPosition = positions.some(p => p.symbol === ticker);
        const earningsSoon = meta[ticker]
          ? Math.floor((new Date(meta[ticker].earnings_date) - new Date()) / (1000*60*60*24)) <= 3
          : false;

        const optsResult = await opts.evaluateOptionsStrategy(ticker, score, { hasPosition, earningsSoon });
        if (optsResult && optsResult.action !== 'NO_ENTRY' && optsResult.action !== 'SKIP' && optsResult.action !== 'HOLD_FOR_UPSIDE') {
          console.log('[OPTIONS-MGR] Decision:', ticker, JSON.stringify(optsResult));
          optsResults.push(optsResult);
        }
      } catch (e) {
        console.log('[OPTIONS-MGR] Skipped', ticker, '—', e.message);
      }
    }
  }

  return { scoresReceived: Object.keys(scores).length, results: equityResults, optionsResults: optsResults };
}

// ── Start cron poll ───────────────────────────────────────────────────────────

function startPoll() {
  if (process.env.SIGNAL_URL) {
    cron.schedule('*/5 9-16 * * 1-5', async () => {
      try { await runPoll(); }
      catch (e) { console.error('[ORDER-MGR] Poll failed (non-fatal):', e.message); }
    }, { timezone: 'America/New_York' });
    console.log('[ORDER-MGR] SIGNAL poll active — every 5 min, 9am-4pm ET weekdays');
  } else {
    console.log('[ORDER-MGR] SIGNAL_URL not set — polling disabled');
  }
}

startPoll();

// ── Routes ────────────────────────────────────────────────────────────────────

router.post('/evaluate', async (req, res) => {
  const { ticker, score, meta = {} } = req.body;
  if (!ticker || score === undefined) return res.status(400).json({ error: 'ticker and score are required' });
  try { res.json(await getOM().evaluate(ticker, score, meta)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/evaluate-all', async (req, res) => {
  const { scores, meta = {} } = req.body;
  if (!scores) return res.status(400).json({ error: 'scores object required' });
  try { res.json({ results: await getOM().evaluateAll(scores, meta) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/status', async (req, res) => {
  try { res.json(await getOM().getStatus()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/halt', async (req, res) => {
  const { reason = 'Manual halt via API' } = req.body;
  try { await getOM().halt(reason); res.json({ halted: true, reason }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/resume', async (req, res) => {
  getOM().resume();
  res.json({ halted: false });
});

router.get('/log', (req, res) => {
  const log = getOM().log;
  res.json({
    decisions: log.decisions.slice(-50),
    orders:    log.orders.slice(-50),
    fills:     log.fills.slice(-50),
    summary:   log.summary(),
  });
});

router.post('/poll-now', async (req, res) => {
  try {
    const result = await runPoll();
    res.json({ polled: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
