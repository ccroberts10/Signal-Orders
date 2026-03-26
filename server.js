require('dotenv').config();
const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());

function basicAuth(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="SIGNAL Dashboard"');
    return res.status(401).send('Authentication required');
  }
  const decoded = Buffer.from(auth.split(' ')[1], 'base64').toString();
  const [user, pass] = decoded.split(':');
  if (user === process.env.DASHBOARD_USER && pass === process.env.DASHBOARD_PASS) {
    return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="SIGNAL Dashboard"');
  return res.status(401).send('Invalid credentials');
}

app.use('/dashboard', basicAuth, express.static(path.resolve(__dirname, 'dashboard')));
app.get('/dashboard', basicAuth, (req, res) => res.sendFile(path.resolve(__dirname, 'dashboard', 'index.html')));

app.use('/api', (req, res, next) => {
  if (req.headers['x-api-key'] !== process.env.API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

app.use('/api/orders', require('./routes/orders'));
app.use('/api/options', require('./routes/options'));

app.get('/', (req, res) => res.json({ status: 'signal-orders running' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`signal-orders on :${PORT}`));
