require('dotenv').config();
const express = require('express');
const path    = require('path');
const app     = express();

app.use(express.json());

// CORS — allows dashboard to call API from any device/browser
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

app.use('/api', (req, res, next) => {
  if (req.headers['x-api-key'] !== process.env.API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

app.use('/api/orders',  require('./routes/orders'));
app.use('/api/options', require('./routes/options'));

app.get('/', (req, res) => res.json({ status: 'signal-orders running' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`signal-orders on :${PORT}`));
