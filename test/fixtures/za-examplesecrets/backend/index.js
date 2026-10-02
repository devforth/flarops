const express = require('express');
const app = express();
const secret = process.env.JWT_SECRET, stripe = process.env.STRIPE_API_KEY, tok = process.env.API_TOKEN;
const refresh = process.env.REFRESH_SECRET;
const pw = process.env.DB_PASSWORD;
app.get('/api/health', (req, res) => res.send('ok'));
app.listen(process.env.PORT || 3000);
