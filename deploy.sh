#!/usr/bin/env bash
# Deploy-Script fuer sofianotes auf dem Zielserver.
#
# Holt den neuesten Stand vom GitHub-Repo und baut/startet den Container neu.
# Aufruf auf dem Server, im geklonten Repo-Verzeichnis:
#
#   ./deploy.sh
#
# Einmalig vorher einrichten:
#   git clone https://github.com/L8teNever/sofianotes
#   cd sofianotes
#   cp .env.example .env   # BIND_HOST/BIND_PORT fuer die eigene Umgebung anpassen
#   ./deploy.sh

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

echo "==> git pull ($(git rev-parse --abbrev-ref HEAD))"
git pull --ff-only

echo "==> docker compose up -d --build"
docker compose up -d --build

echo "==> Status"
docker compose ps
