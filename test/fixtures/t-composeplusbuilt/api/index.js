const e=require("express");const app=e();app.get("/api/items",(q,r)=>r.json([]));app.listen(3000);
