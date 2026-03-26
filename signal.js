require('dotenv').config();
const express = require('express');
const path    = require('path');
const app     = express();

app.use(express.json());

app.use('/api', (req, res, next) => {
  if (req.headers['x-api-key'] !== process.env.API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

app.use('/api/orders',  require('./routes/orders'));
app.use('/api/options', require('./routes/options'));
app.use('/dashboard',   express.static(path.join(__dirname, 'dashboard')));

app.get('/', (req, res) => res.json({ status: 'signal-orders running' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`signal-orders on :${PORT}`));
