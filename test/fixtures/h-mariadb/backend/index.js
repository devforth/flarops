const express = require("express");
const app = express();
app.get("/api/leads", (req, res) => res.json([]));
app.listen(8080);
