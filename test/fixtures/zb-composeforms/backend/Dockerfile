FROM python:3.12-slim
WORKDIR /app
COPY . .
RUN pip install -r requirements.txt
CMD ["gunicorn","-b","0.0.0.0:80","app:app"]
