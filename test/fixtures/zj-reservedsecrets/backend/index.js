const express = require("express");
const app = express();
const s3 = { key: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY, region: process.env.AWS_REGION };
const gh = process.env.GITHUB_TOKEN;
const deployKey = process.env.SSH_PRIVATE_KEY;
const registry = process.env.REGISTRY_PASSWORD;
const signing = process.env.APP_SIGNING_KEY;
app.get("/api/ok", (q, r) => r.json({ s3: !!s3.key, gh: !!gh, deployKey: !!deployKey, registry: !!registry, signing: !!signing }));
app.listen(process.env.PORT || 4000);
