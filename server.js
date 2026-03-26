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

app.use('/dashboard', express.static(path.resolve(__dirname, 'dashboard')));
app.get('/dashboard', (req, res) =>
  res.sendFile(path.resolve(__dirname, 'dashboard', 'index.html'))
);

function requireKey(req, res, next) {
  if (req.headers['x-api-key'] !== process.env.API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.use('/api/orders',  requireKey, require('./routes/orders'));
app.use('/api/options', requireKey, require('./routes/options'));
app.use('/api/gex',     requireKey, require('./routes/gex'));

app.get('/', (req, res) => res.json({ status: 'signal-orders running' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`signal-orders on :${PORT}`));
