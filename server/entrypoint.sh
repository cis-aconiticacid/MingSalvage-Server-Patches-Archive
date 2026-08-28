#!/bin/bash
set -e

PERSIST=/app/persist
DATA_DIR="$PERSIST/data"
CONTENT_SRC=/app/resources/backend/MingSalvageBackend/_internal/content
SAVE_DB="$CONTENT_SRC/review_save.db"
PERSIST_SAVE="$PERSIST/review_save.db"
PERSIST_PASSWORD="$PERSIST/password.txt"

# --- First-run initialization ---
if [ ! -f "$PERSIST/.initialized" ]; then
    echo "[entrypoint] First run — copying initial data to persist..."
    mkdir -p "$DATA_DIR"

    # runtime data directory
    cp -rn /app/.ming_backend_data/* "$DATA_DIR/" 2>/dev/null || true

    # save database
    if [ -f "$SAVE_DB" ]; then
        cp -n "$SAVE_DB" "$PERSIST_SAVE"
    fi

    # password
    cp -n /app/password.txt "$PERSIST_PASSWORD"

    touch "$PERSIST/.initialized"
    echo "[entrypoint] Initialization done."
fi

# --- Link persistent files back (force symlink, replacing built-in files) ---
rm -f "$SAVE_DB"
ln -sf "$PERSIST_SAVE" "$SAVE_DB"

rm -f /app/password.txt
ln -sf "$PERSIST_PASSWORD" /app/password.txt

# MING_SIM_USER_DATA_DIR points directly to /app/persist/data, no symlink needed

echo "[entrypoint] Starting Ming Salvage..."
exec python3 run_ming_backend.py
