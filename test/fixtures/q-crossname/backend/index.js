const express = require("express");
const app = express();
const pw = process.env.POSTGRES_PASSWORD;
app.get("/api/accounts", (req, res) => res.json([]));
app.listen(3000);
