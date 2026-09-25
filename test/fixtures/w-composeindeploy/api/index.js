const express = require("express");
const app = express();
app.get("/orders", (req, res) => res.json([]));
app.get("/invoices", (req, res) => res.json([]));
app.listen(3000);
