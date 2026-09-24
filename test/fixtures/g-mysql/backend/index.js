const express = require("express");
const app = express();
app.get("/health", (req, res) => res.send("ok"));
app.get("/api/products", (req, res) => res.json([]));
app.listen(process.env.PORT || 3000);
