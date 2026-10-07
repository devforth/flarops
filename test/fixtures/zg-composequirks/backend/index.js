const express=require("express");const app=express();
const cfg={db:process.env.DATABASE_URL,jwt:process.env.JWT_PRIVATE_KEY,prom:process.env.PROM_URL,redis:process.env.REDIS_HOST,debug:process.env.DEBUG,backups:process.env.BACKUP_DIR,store:process.env.STORE_URL};
app.get("/api/health",(q,r)=>r.json(cfg));app.listen(process.env.PORT||4000)
