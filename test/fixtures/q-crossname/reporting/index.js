const express = require("express");
const app = express();
const pw = process.env.POSTGRES_PASSWORD;
app.get("/reports/daily", (req, res) => res.json([]));
app.listen(4100);
