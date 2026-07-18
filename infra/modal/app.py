from __future__ import annotations

import json
import os
import socket
import subprocess
import time
import urllib.request
from pathlib import Path

import modal

# Container mounts this file at /root/app.py; ROOT is only meaningful locally
# (from_dockerfile build context). In-container it is never dereferenced.
ROOT = Path(__file__).parents[2] if modal.is_local() else Path("/opt/openstatus")
APP_NAME = "openstatus"
PUBLIC_URL = os.environ.get(
    "OPENSTATUS_PUBLIC_URL", "https://umgbhalla--openstatus-gateway.modal.run"
).rstrip("/")
REGION = os.environ.get("OPENSTATUS_MODAL_REGION", "us-west-2")
# Tinybird workspace admin token, minted by bootstrap() and read by Gateway.start().
# Persisted on the durable ClickHouse Volume so it survives across deploys.
TOKEN_FILE = Path("/var/lib/clickhouse/.tb-token")

app = modal.App(APP_NAME)
bootstrap_app = modal.App(f"{APP_NAME}-bootstrap")
image = modal.Image.from_dockerfile(
    ROOT / "Dockerfile.modal",
    context_dir=ROOT,
    add_python="3.13",
).entrypoint([])
cron_image = modal.Image.debian_slim(python_version="3.13")

libsql_volume = modal.Volume.from_name(
    "openstatus-libsql-v2", create_if_missing=True, version=2
)
workflows_volume = modal.Volume.from_name(
    "openstatus-workflows-v2", create_if_missing=True, version=2
)
# Tinybird Local durable state: ClickHouse (analytics rows) + Redis (tinybird
# server state). Fresh -v1 volumes — bootstrap re-mints the workspace token into
# the ClickHouse volume (TOKEN_FILE) on first boot.
tinybird_clickhouse_volume = modal.Volume.from_name(
    "openstatus-tinybird-clickhouse-v1", create_if_missing=True, version=2
)
tinybird_redis_volume = modal.Volume.from_name(
    "openstatus-tinybird-redis-v1", create_if_missing=True, version=2
)

volumes = {
    "/var/lib/sqld": libsql_volume,
    "/var/lib/clickhouse": tinybird_clickhouse_volume,
    "/redis-data": tinybird_redis_volume,
    "/app/data": workflows_volume,
}
secret = modal.Secret.from_name(
    "openstatus",
    required_keys=["AUTH_SECRET", "CRON_SECRET", "RESEND_API_KEY", "SUPER_ADMIN_TOKEN"],
)

common_env = {
    "NODE_ENV": "production",
    "SELF_HOST": "true",
    "AUTH_TRUST_HOST": "true",
    "DATABASE_URL": "http://127.0.0.1:8080",
    "DATABASE_AUTH_TOKEN": "",
    "DB_URL": "http://127.0.0.1:8080",
    "DB_AUTH_TOKEN": "",
    # Analytics via embedded Tinybird Local (ClickHouse). The URL is static (the
    # base's nginx serves the tinybird API on :7181); the workspace token is
    # runtime-injected by Gateway.start() from TOKEN_FILE — empty here is fine at
    # build time and on the very first boot (before bootstrap has minted it).
    # TINY_BIRD_API_KEY feeds the TS readers/writers; TINYBIRD_TOKEN feeds the Go
    # checker; both read TINYBIRD_URL.
    "TINYBIRD_URL": "http://127.0.0.1:7181",
    "TINY_BIRD_API_KEY": "",
    "TINYBIRD_TOKEN": "",
    "WORKFLOWS_URL": "http://127.0.0.1:3000",
    "CHECKER_URL": "http://127.0.0.1:8082",
    "OPENSTATUS_INGEST_URL": "http://127.0.0.1:8081",
    "NEXT_PUBLIC_URL": PUBLIC_URL,
    "SITE_URL": PUBLIC_URL,
    "STATUS_PAGE_BASE_URL": f"{PUBLIC_URL}/status",
    "STATUS_PAGE_BASE_PATH": "/status",
    "FLY_REGION": "ams",
    "SELF_HOST_REGION": "ams",
    "SQLD_NODE": "primary",
    "SQLD_DB_PATH": "/var/lib/sqld/data",
    "SQLD_HTTP_LISTEN_ADDR": "127.0.0.1:8080",
    "GIN_MODE": "release",
    "UPSTASH_REDIS_REST_URL": "",
    "UPSTASH_REDIS_REST_TOKEN": "",
    "QSTASH_TOKEN": "",
    "QSTASH_CURRENT_SIGNING_KEY": "",
    "QSTASH_NEXT_SIGNING_KEY": "",
    "SCREENSHOT_SERVICE_URL": "",
    "UNKEY_API_ID": "",
    "UNKEY_TOKEN": "",
    "AXIOM_TOKEN": "",
    "AXIOM_DATASET": "",
    "STRIPE_SECRET_KEY": "",
    "PROJECT_ID_VERCEL": "",
    "TEAM_ID_VERCEL": "",
    "VERCEL_AUTH_BEARER_TOKEN": "",
}


def wait_port(port: int, *, timeout: float = 180.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return
        except OSError:
            time.sleep(0.5)
    raise TimeoutError(f"port {port} did not become ready")


def stop_process(process: subprocess.Popen[bytes]) -> None:
    process.terminate()
    try:
        process.wait(timeout=60)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)


def fetch_tinybird_token(*, timeout: float = 300.0) -> str:
    """Poll the Tinybird Local tokens endpoint until the workspace admin token is
    minted. :7181 (nginx) opens early, but the token only exists once the base's
    `setup` program has provisioned the default workspace — so retry, don't
    single-shot."""
    deadline = time.monotonic() + timeout
    last_err: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen("http://127.0.0.1:7181/tokens", timeout=10) as response:
                tokens = json.load(response)
            token = tokens.get("workspace_admin_token") or tokens.get("workspace_token")
            if token:
                return str(token)
        except Exception as err:  # noqa: BLE001 — endpoint 404/500s until setup finishes
            last_err = err
        time.sleep(2)
    raise RuntimeError(f"Tinybird workspace token not available in time: {last_err}")


@bootstrap_app.function(
    image=image,
    volumes=volumes,
    secrets=[secret],
    env=common_env,
    cpu=8,
    memory=16384,
    timeout=1800,
    region=REGION,
)
def bootstrap() -> dict[str, str]:
    # Run only the base's tinybird stack (clickhouse/redis/tinybird_server/setup)
    # under supervisord during bootstrap; disable OUR programs so the node apps
    # and checker don't spin/error before the token exists. sqld is one of ours,
    # so start it by hand for the DB migration.
    conf = Path("/etc/supervisor/conf.d/openstatus.conf")
    disabled = conf.with_suffix(".disabled")
    if conf.exists():
        conf.rename(disabled)

    sqld = subprocess.Popen(["/usr/local/bin/sqld"], cwd="/var/lib/sqld")
    supervisor = subprocess.Popen(
        ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
    )
    try:
        wait_port(8080)
        wait_port(7181, timeout=300)
        token = fetch_tinybird_token()

        env = {
            **os.environ,
            "DATABASE_URL": common_env["DATABASE_URL"],
            "DATABASE_AUTH_TOKEN": "",
            "TB_TOKEN": token,
            "TINY_BIRD_API_KEY": token,
            "TINYBIRD_TOKEN": token,
            "TINYBIRD_URL": common_env["TINYBIRD_URL"],
        }
        subprocess.run(
            ["/usr/local/bin/deno", "run", "-A", "--sloppy-imports", "src/migrate.mts"],
            cwd="/opt/openstatus/packages/db",
            env=env,
            check=True,
        )
        # Push all .datasource + .pipe defs into the local workspace.
        subprocess.run(
            ["/usr/local/bin/tb", "--local", "deploy"],
            cwd="/opt/openstatus/packages/tinybird",
            env=env,
            check=True,
        )
        TOKEN_FILE.write_text(token, encoding="utf-8")
        TOKEN_FILE.chmod(0o600)
    finally:
        stop_process(supervisor)
        stop_process(sqld)
        if disabled.exists():
            disabled.rename(conf)

    libsql_volume.commit()
    tinybird_clickhouse_volume.commit()
    tinybird_redis_volume.commit()
    workflows_volume.commit()
    return {"database": "migrated", "tinybird": "deployed"}


@app.server(
    image=image,
    port=8100,
    routing_region="us-east",
    compute_region=REGION,
    volumes=volumes,
    secrets=[secret],
    env=common_env,
    cpu=8,
    memory=16384,
    ephemeral_disk=20480,
    min_containers=1,
    max_containers=1,
    target_concurrency=100,
    startup_timeout=600,
    exit_grace_period=120,
    unauthenticated=True,
)
class Gateway:
    @modal.enter()
    def start(self) -> None:
        # Inject the Tinybird workspace token BEFORE launching supervisord so every
        # child (Go checker via TINYBIRD_TOKEN, node apps via TINY_BIRD_API_KEY)
        # inherits it. Fail loud if bootstrap has not minted it yet.
        if not TOKEN_FILE.exists():
            raise RuntimeError("run bootstrap before deploying Gateway (missing tb token)")
        token = TOKEN_FILE.read_text(encoding="utf-8").strip()
        if not token:
            raise RuntimeError("Tinybird workspace token is empty")
        os.environ["TINYBIRD_URL"] = common_env["TINYBIRD_URL"]
        os.environ["TINY_BIRD_API_KEY"] = token
        os.environ["TINYBIRD_TOKEN"] = token

        self.process = subprocess.Popen(
            ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
        )
        # 7181 = tinybird API (nginx). clickhouse/redis start at supervisor
        # priority 1 (before our services); tinybird_server is priority 999, so
        # analytics reads/writes self-heal once it is up — the checker tolerates
        # a late Tinybird and the status page falls back to manual mode meanwhile.
        ports = [8080, 7181, 3000, 3001, 8081, 8082, 3002, 3003, 8100]
        if os.environ.get("OPENSTATUS_KEY"):
            ports.append(8083)
        for port in ports:
            wait_port(port, timeout=300)

    @modal.exit()
    def stop(self) -> None:
        stop_process(self.process)
        libsql_volume.commit()
        tinybird_clickhouse_volume.commit()
        tinybird_redis_volume.commit()
        workflows_volume.commit()


@bootstrap_app.function(
    image=image,
    volumes=volumes,
    secrets=[secret],
    env=common_env,
    cpu=2,
    memory=4096,
    timeout=600,
    region=REGION,
)
def exec(command: str) -> str:
    """One-off maintenance against the durable libSQL volume (set-password,
    ad-hoc SQL). ``command`` is a shell string. Starts sqld, runs it, tears down."""
    sqld = subprocess.Popen(["/usr/local/bin/sqld"], cwd="/var/lib/sqld")
    try:
        wait_port(8080)
        result = subprocess.run(
            ["/bin/sh", "-c", command],
            capture_output=True,
            text=True,
            cwd="/opt/openstatus",
        )
    finally:
        stop_process(sqld)
    libsql_volume.commit()
    out = f"rc={result.returncode}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    print(out)
    return out


def call_workflow(path: str) -> None:
    request = urllib.request.Request(
        f"{PUBLIC_URL}/internal/workflows{path}",
        headers={"Authorization": os.environ["CRON_SECRET"]},
    )
    with urllib.request.urlopen(request, timeout=240) as response:
        if response.status != 200:
            raise RuntimeError(f"workflow returned {response.status}")


@app.function(
    image=cron_image,
    secrets=[secret],
    # PUBLIC_URL is a module global re-evaluated in the cron container's own
    # import — pin it so the container resolves the deployer's URL.
    env={"OPENSTATUS_PUBLIC_URL": PUBLIC_URL},
    schedule=modal.Cron("* * * * *"),
    timeout=300,
)
def scheduled_checks() -> None:
    minute = int(time.time() // 60)
    # 30s periodicity: one dispatch per minute — sendCheckerTasks enqueues the
    # +30s twin itself.
    call_workflow("/cron/checker/30s")
    call_workflow("/cron/checker/1m")
    if minute % 5 == 0:
        call_workflow("/cron/checker/5m")
    if minute % 10 == 0:
        call_workflow("/cron/checker/10m")
    if minute % 30 == 0:
        call_workflow("/cron/checker/30m")
    if minute % 60 == 0:
        call_workflow("/cron/checker/1h")
