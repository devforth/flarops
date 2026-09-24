const express = require("express");
const app = express();
app.get("/billing/invoices", (req, res) => res.json([]));
app.listen(4002);
