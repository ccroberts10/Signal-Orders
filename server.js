require('dotenv').config();
const express = require('express');
const path    = require('path');
const app     = express();

app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Dashboard — no auth required
app.use('/dashboard', express.static(path.resolve(__dirname, 'dashboard')));
app.get('/dashboard', (req, res) =>
  res.sendFile(path.resolve(__dirname, 'dashboard', 'index.html'))
);

// ── Proxy routes — injects API key server-side so mobile Safari works ─────────
// These bypass the x-api-key header requirement for read-only dashboard data

function injectKey(req, res, next) {
  req.headers['x-api-key'] = process.env.API_KEY;
  next();
}

const ordersRouter  = require('./routes/orders');
const optionsRouter = require('./routes/options');
const gexRouter     = require('./routes/gex');

app.get('/proxy/status',         injectKey, (req, res, next) => { req.url = '/status';  next(); }, ordersRouter);
app.get('/proxy/log',            injectKey, (req, res, next) => { req.url = '/log';     next(); }, ordersRouter);
app.get('/proxy/options-status', injectKey, (req, res, next) => { req.url = '/status';  next(); }, optionsRouter);
app.post('/proxy/poll-now',      injectKey, (req, res, next) => { req.url = '/poll-now'; next(); }, ordersRouter);

// ── Protected API routes — key required ───────────────────────────────────────
function requireKey(req, res, next) {
  if (req.headers['x-api-key'] !== process.env.API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.use('/api/orders',  requireKey, ordersRouter);
app.use('/api/options', requireKey, optionsRouter);
app.use('/api/gex',     requireKey, gexRouter);

app.get('/', (req, res) => res.json({ status: 'signal-orders running' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`signal-orders on :${PORT}`));
