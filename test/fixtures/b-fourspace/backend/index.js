const express=require("express");const app=express();process.env.SECRET_TOKEN;process.env.APP_MODE;app.get("/items",(q,r)=>r.json([]));app.listen(3000)
