const express=require("express");const app=express();app.get("/orders",(q,r)=>r.json([]));app.listen(3002)
