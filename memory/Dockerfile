FROM python:3.11-slim
WORKDIR /app
COPY wheels/ /wheels/
RUN pip install --no-index --find-links=/wheels flask
COPY app/ .
CMD ["python", "main.py"]
