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

// Dashboard - no auth
app.use('/dashboard', express.static(path.resolve(__dirname, 'dashboard')));
app.get('/dashboard', (req, res) =>
  res.sendFile(path.resolve(__dirname, 'dashboard', 'index.html'))
);

// API key check middleware
function requireKey(req, res, next) {
  if (req.headers['x-api-key'] !== process.env.API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

const orders  = require('./routes/orders');
const options = require('./routes/options');

// Read-only GET endpoints — no key needed (dashboard uses these on all devices)
app.get('/api/orders/status',  orders);
app.get('/api/orders/log',     orders);
app.get('/api/options/status', options);

// All other API routes — key required
app.use('/api/orders',  requireKey, orders);
app.use('/api/options', requireKey, options);

app.get('/', (req, res) => res.json({ status: 'signal-orders running' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`signal-orders on :${PORT}`));
