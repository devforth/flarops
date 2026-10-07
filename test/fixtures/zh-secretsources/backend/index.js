const express=require("express");const app=express();
const cfg={jwt:process.env.JWT_SECRET,token:process.env.API_TOKEN,amqp:process.env.AMQP_URL};
app.get("/api/ok",(q,r)=>r.json(Object.keys(cfg)));app.listen(process.env.PORT||4000)
