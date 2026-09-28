const express = require("express");
const app = express();
app.get("/api/orders", (req, res) => res.json([]));
app.listen(process.env.PORT || 5000);
