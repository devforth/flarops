const express=require("express");const app=express();app.get("/users",(q,r)=>r.json([]));app.listen(3000)
