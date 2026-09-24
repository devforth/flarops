const express=require("express");const app=express();app.get("/x",(q,r)=>r.json([]));app.listen(3000)
