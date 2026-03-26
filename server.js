require('dotenv').config();
const express = require('express');
const path    = require('path');
const app     = express();

app.use(express.json());

// Dashboard loads without auth (it's just HTML)
app.use('/dashboard', express.static(path.resolve(__dirname, 'dashboard')));
app.get('/dashboard', (req, res) => res.sendFile(path.resolve(__dirname, 'dashboard', 'index.html')));

// API routes are protected
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
```

4. Click **Commit changes**
5. Click **Commit changes** again

---

Wait 30 seconds for Railway to redeploy, then try opening this in your browser:
```
https://signal-orders-production.up.railway.app/dashboard
