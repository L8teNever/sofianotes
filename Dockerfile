FROM python:3.12-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends hunspell hunspell-de-de \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

ARG GIT_COMMIT=main
ENV GIT_COMMIT=$GIT_COMMIT

COPY backend backend
COPY frontend frontend

RUN printf '{"version":"1.0.0","commit":"%s"}\n' "$GIT_COMMIT" > backend/version.json

RUN mkdir -p data

WORKDIR /app/backend
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
