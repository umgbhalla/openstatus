#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$ROOT/infra/modal/.env.modal"
MODAL_ENVIRONMENT="${MODAL_ENVIRONMENT:-main}"
MODAL_CLIENT="${MODAL_CLIENT-$HOME/hub/modal-client/py}"
MODAL_BIN="${MODAL_BIN:-$HOME/hub/harp/.venv/bin/modal}"
if [[ "$MODAL_BIN" != */* ]]; then
  MODAL_BIN="$(command -v "$MODAL_BIN" || true)"
fi
if [ ! -x "$MODAL_BIN" ]; then
  printf 'missing Modal CLI: %s\n' "$MODAL_BIN" >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  umask 077
  python3 - "$ENV_FILE" <<'PY'
import secrets
import sys
from pathlib import Path

path = Path(sys.argv[1])
path.write_text(
    "\n".join(
        [
            f"AUTH_SECRET={secrets.token_urlsafe(48)}",
            f"CRON_SECRET={secrets.token_urlsafe(48)}",
            "RESEND_API_KEY=disabled",
            f"SUPER_ADMIN_TOKEN={secrets.token_urlsafe(48)}",
        ]
    )
    + "\n",
    encoding="utf-8",
)
PY
  printf 'created %s; add real RESEND/OAuth credentials before user login\n' "$ENV_FILE"
fi

modal() {
  if [ -n "$MODAL_CLIENT" ]; then
    PYTHONPATH="$MODAL_CLIENT${PYTHONPATH:+:$PYTHONPATH}" "$MODAL_BIN" "$@"
  else
    "$MODAL_BIN" "$@"
  fi
}

cd "$ROOT"
modal secret create openstatus --from-dotenv "$ENV_FILE" --force
# Single-writer fence: never let a live Gateway share the Volumes with bootstrap.
modal app stop openstatus --env "$MODAL_ENVIRONMENT" -y 2>/dev/null || true
modal run --detach --env "$MODAL_ENVIRONMENT" infra/modal/app.py::bootstrap
modal deploy --env "$MODAL_ENVIRONMENT" infra/modal/app.py::app

# The Server URL is only known post-deploy; pin it and redeploy so NEXT_PUBLIC_URL/
# SITE_URL/STATUS_PAGE_BASE_URL and the cron dispatcher all carry the real origin.
MODAL_PYTHON="${MODAL_PYTHON:-$HOME/hub/harp/.venv/bin/python}"
GATEWAY_URL="$(MODAL_ENVIRONMENT="$MODAL_ENVIRONMENT" \
  PYTHONPATH="${MODAL_CLIENT:+$MODAL_CLIENT:}${PYTHONPATH:-}" \
  "$MODAL_PYTHON" - <<'PY' 2>/dev/null || true
import modal
print(modal.Server.from_name("openstatus", "Gateway").get_url() or "")
PY
)"
if [ -n "$GATEWAY_URL" ] && [ "$GATEWAY_URL" != "${OPENSTATUS_PUBLIC_URL:-}" ]; then
  printf 'gateway URL: %s — redeploying with pinned public URL\n' "$GATEWAY_URL"
  OPENSTATUS_PUBLIC_URL="$GATEWAY_URL" modal deploy --env "$MODAL_ENVIRONMENT" infra/modal/app.py::app
fi
