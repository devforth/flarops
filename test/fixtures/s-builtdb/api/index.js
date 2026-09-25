const express = require("express");
const app = express();
const pw = process.env.DATABASE_PASSWORD;
app.get("/api/series", (req, res) => res.json([]));
app.listen(3000);
