import os
from fastapi import FastAPI
app = FastAPI()
DB = os.environ["DATABASE_URL"]
@app.get("/health")
def health():
    return {"ok": True}
@app.get("/v1/items")
def items():
    return []
