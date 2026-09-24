const express=require("express");const app=express();app.get("/api/users",(q,r)=>r.json([]));app.listen(process.env.PORT||4000)
