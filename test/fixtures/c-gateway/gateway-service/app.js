const express=require("express");const axios=require("axios");const app=express();app.get("/api/users",async(q,r)=>r.json((await axios.get("http://user-service:3000/users")).data));app.listen(3003)
