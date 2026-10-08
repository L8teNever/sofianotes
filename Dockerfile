# syntax=docker/dockerfile:1
FROM python:3.12-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends hunspell hunspell-de-de \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend backend
COPY frontend frontend
COPY scripts/bake-version.py scripts/bake-version.py

# Keep semver from backend/version.json. Commit: GIT_COMMIT arg, else .git HEAD.
ARG GIT_COMMIT=
ENV GIT_COMMIT=$GIT_COMMIT
RUN --mount=type=bind,source=.git,target=/app/.git,ro \
    GIT_COMMIT="$GIT_COMMIT" python3 scripts/bake-version.py

RUN mkdir -p data

WORKDIR /app/backend
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
