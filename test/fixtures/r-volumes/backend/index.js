const express = require("express");
const app = express();
app.get("/api/keys", (req, res) => res.json([]));
app.listen(3000);
