const express = require("express");
const app = express();
app.get("/api/items", (req, res) => res.json([]));
app.listen(3000);
