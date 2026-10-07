const express=require("express");const app=express();
const c={db:process.env.DATABASE_URL,dsn:process.env.ANALYTICS_ADDR,json:process.env.CONFIG_JSON,vault:process.env.VAULT_ADDR,redis:process.env.REDIS_HOST,proxy:process.env.PROXY_URL,secret:process.env.API_SECRET};
app.get("/api/ok",(q,r)=>r.json(Object.keys(c)));app.listen(process.env.PORT||4000)
