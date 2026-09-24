const express=require("express");const app=express();process.env.DB_PASSWORD;process.env.REDIS_PASSWORD;app.get("/api/x",(q,r)=>r.json([]));app.listen(3000)
