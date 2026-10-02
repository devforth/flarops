import os
from flask import Flask
app = Flask(__name__)
TOKEN = os.environ.get("API_TOKEN")
JWT = os.environ.get("JWT_SECRET")
STRIPE = os.environ.get("STRIPE_KEY")
EXPORTED = os.environ.get("EXPORTED_TOKEN")
@app.route("/api/health")
def health():
    return "ok"
