#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"
EXAMPLE="$ROOT/.env.example"

if [ -f "$ENV_FILE" ]; then
  echo ".env existe déjà : $ENV_FILE"
  echo "Supprimez-le explicitement si vous voulez régénérer tous les secrets."
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl est requis pour générer les secrets." >&2
  exit 1
fi

cp "$EXAMPLE" "$ENV_FILE"

python3 - "$ENV_FILE" <<'PY'
import secrets
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8")

def hex_secret(nbytes: int = 32) -> str:
    return secrets.token_hex(nbytes)

values = {
    "MASTER_API_KEY": hex_secret(32),
    "JWT_APP_SECRET": hex_secret(32),
    "JICOFO_AUTH_PASSWORD": hex_secret(24),
    "JVB_AUTH_PASSWORD": hex_secret(24),
    "JIGASI_XMPP_PASSWORD": hex_secret(24),
    "JIGASI_TRANSCRIBER_PASSWORD": hex_secret(24),
    "JIBRI_RECORDER_PASSWORD": hex_secret(24),
    "JIBRI_XMPP_PASSWORD": hex_secret(24),
    "WEBHOOK_SECRET": hex_secret(32),
    "S3_ACCESS_KEY": "pm" + secrets.token_hex(12),
    "S3_SECRET_KEY": hex_secret(32),
    "WEB_SESSION_SECRET": hex_secret(32),
    "WEB_ENCRYPTION_KEY": hex_secret(32),
}

lines = []
for line in text.splitlines():
    key = line.split("=", 1)[0]
    if key in values and line.endswith("__GENERATE__"):
        line = f"{key}={values[key]}"
    lines.append(line)
path.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY

chmod 600 "$ENV_FILE"
mkdir -p "$ROOT/data/app" "$ROOT/data/captures" "$ROOT/data/jitsi" "$ROOT/data/web"
echo "Configuration créée : $ENV_FILE"
echo "Secrets générés. Ne pas versionner ce fichier."
echo "Interface web : http://localhost:3090"
echo "Démarrer : docker compose up -d --build"
echo "Enregistrement : docker compose --profile recording up -d --build"
echo "Transcription : docker compose --profile transcription up -d --build"
