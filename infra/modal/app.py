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
# Region policy: a single hard pin (us-west-2) left Modal unable to place the
# container ("waiting to be scheduled on a CPU worker ... Relaxing requirements
# may lead to faster scheduling"). Allow any US region so the scheduler always
# finds capacity; the monitor's probe origin is labeled truthfully via
# SELF_HOST_REGION (see common_env), not tied to this placement.
REGION = os.environ.get("OPENSTATUS_MODAL_REGION", "")
COMPUTE_REGION: list[str] | str = (
    [r for r in REGION.split(",") if r] if REGION else ["us-east-1", "us-west-2"]
)

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

volumes = {
    "/var/lib/sqld": libsql_volume,
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
    # Analytics served by the in-container Tinybird-protocol shim (tb-shim on
    # :7181, backed by the same libSQL). A non-empty token is required so the TS
    # reader is not NoopTinybird and the Go checker actually sends events; the
    # value itself is a dummy (the shim ignores the bearer). See infra/modal/tb-shim.
    "TINYBIRD_URL": "http://127.0.0.1:7181",
    "TINY_BIRD_API_KEY": "selfhost",
    "TINYBIRD_TOKEN": "selfhost",
    "WORKFLOWS_URL": "http://127.0.0.1:3000",
    "CHECKER_URL": "http://127.0.0.1:8082",
    "OPENSTATUS_INGEST_URL": "http://127.0.0.1:8081",
    "NEXT_PUBLIC_URL": PUBLIC_URL,
    "SITE_URL": PUBLIC_URL,
    "STATUS_PAGE_BASE_URL": f"{PUBLIC_URL}/status",
    "STATUS_PAGE_BASE_PATH": "/status",
    # Honest probe-origin label: the single checker runs in one US Modal
    # datacenter, NOT Amsterdam. "sjc" (San Jose) is a NON-DEPRECATED FLY_REGIONS
    # id nearest Modal's us-west compute. NOTE: "sea" is deprecated in
    # packages/regions, and sendCheckerTasks SKIPS deprecated regions — using it
    # silently stops the cron from ever dispatching this monitor. Persisted
    # monitor.regions rows are migrated to match so region filtering resolves.
    "FLY_REGION": "sjc",
    "SELF_HOST_REGION": "sjc",
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


def checkpoint_libsql() -> None:
    """Force a WAL checkpoint(TRUNCATE) so the on-disk main DB is self-consistent
    (no writes stranded in -wal) before a Volume commit snapshots the files. Best
    effort: sqld exposes SQL over its HTTP endpoint on :8080."""
    body = json.dumps(
        {"statements": ["PRAGMA wal_checkpoint(TRUNCATE)"]}
    ).encode()
    req = urllib.request.Request(
        "http://127.0.0.1:8080/",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        resp.read()


def _persist_loop(interval: float = 45.0) -> None:
    """Bounded-RPO durability: checkpoint + explicitly commit the Volume on a
    timer. Modal's server-side background commit cadence is opaque and its
    snapshot is not coordinated with SQLite's WAL boundary, and @modal.exit only
    fires on graceful shutdown — so on an ungraceful kill everything since the
    last commit is lost and the snapshot may be torn. This loop makes the real
    RPO ~= interval and each snapshot self-consistent (checkpoint first)."""
    while True:
        time.sleep(interval)
        try:
            checkpoint_libsql()
            libsql_volume.commit()
        except Exception as err:  # noqa: BLE001 — never let the loop die
            print(f"[persist] checkpoint/commit failed: {err}")


@bootstrap_app.function(
    image=image,
    volumes=volumes,
    secrets=[secret],
    env=common_env,
    cpu=4,
    memory=8192,
    timeout=900,
    region=COMPUTE_REGION,
)
def bootstrap() -> dict[str, str]:
    sqld = subprocess.Popen(["/usr/local/bin/sqld"], cwd="/var/lib/sqld")
    try:
        wait_port(8080)
        subprocess.run(
            ["/usr/local/bin/deno", "run", "-A", "--sloppy-imports", "src/migrate.mts"],
            cwd="/opt/openstatus/packages/db",
            check=True,
        )
    finally:
        stop_process(sqld)
    libsql_volume.commit()
    workflows_volume.commit()
    return {"database": "migrated"}


@app.server(
    image=image,
    port=8100,
    routing_region="us-east",
    compute_region=COMPUTE_REGION,
    volumes=volumes,
    secrets=[secret],
    env=common_env,
    # Measured live: whole supervisord stack (2x next-server + 3x deno + sqld +
    # go bins + nginx + tb-shim) peaks ~1.9GiB RSS. The old 4cpu/8.8GiB
    # reservation was ~4.6x over-provisioned — the direct cause of both the
    # ~$15.60/day cost AND the "waiting for a CPU worker" scheduling stalls.
    # 2cpu/4GiB = ~2.2x headroom, ~half the cost, schedules immediately.
    cpu=2,
    memory=4096,
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
        self.process = subprocess.Popen(
            ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
        )
        ports = [8080, 7181, 3000, 3001, 8081, 8082, 3002, 3003, 8100]
        if os.environ.get("OPENSTATUS_KEY"):
            ports.append(8083)
        for port in ports:
            wait_port(port, timeout=300)
        # Bounded-RPO durability: periodic checkpoint+commit (daemon thread dies
        # with the container). See _persist_loop.
        import threading

        threading.Thread(target=_persist_loop, daemon=True).start()

    @modal.exit()
    def stop(self) -> None:
        # Checkpoint BEFORE stopping sqld + committing, so the final snapshot is
        # a single self-consistent DB file (no live -wal).
        try:
            checkpoint_libsql()
        except Exception as err:  # noqa: BLE001
            print(f"[exit] checkpoint failed: {err}")
        stop_process(self.process)
        libsql_volume.commit()
        workflows_volume.commit()


@bootstrap_app.function(
    image=image,
    volumes=volumes,
    secrets=[secret],
    env=common_env,
    cpu=2,
    memory=4096,
    timeout=600,
    region=COMPUTE_REGION,
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
