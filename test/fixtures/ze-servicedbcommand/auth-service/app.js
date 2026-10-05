const express = require("express");
const app = express();
app.get("/auth/login", (req, res) => res.json({}));
app.listen(4001);
