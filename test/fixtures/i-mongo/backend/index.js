const express = require("express");
const app = express();
app.get("/api/events", (req, res) => res.json([]));
app.listen(5000);
