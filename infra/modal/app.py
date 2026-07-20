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
# The deployed @app.server URL. Default MUST be the real one — a bare
# `modal deploy` (no OPENSTATUS_PUBLIC_URL exported) previously fell back to a
# wrong ...modal.run guess, so the cron dispatched to a 404 and ALL monitoring
# silently stopped. The correct shape is <ws>--<app>-<class>.<routing>.modal.direct.
PUBLIC_URL = os.environ.get(
    "OPENSTATUS_PUBLIC_URL",
    "https://umgbhalla--openstatus-gateway.us-east.modal.direct",
).rstrip("/")
# Region policy: a single hard pin (us-west-2) left Modal unable to place the
# container ("waiting to be scheduled on a CPU worker ... Relaxing requirements
# may lead to faster scheduling"). Allow any US region so the scheduler always
# finds capacity; the monitor's probe origin is labeled truthfully via
# SELF_HOST_REGION (see common_env), not tied to this placement.
REGION = os.environ.get("OPENSTATUS_MODAL_REGION", "")
# BROAD region GROUPS (us-east/us-west), not narrow AWS regions (us-east-1/us-west-2):
# the narrow pins starved the scheduler ("waiting to be scheduled on a CPU worker")
# and left the Gateway 502ing during recycles. Groups span every US worker pool.
COMPUTE_REGION: list[str] | str = (
    [r for r in REGION.split(",") if r] if REGION else ["us-east", "us-west"]
)

app = modal.App(APP_NAME)
bootstrap_app = modal.App(f"{APP_NAME}-bootstrap")
image = modal.Image.from_dockerfile(
    ROOT / "Dockerfile.modal",
    context_dir=ROOT,
    add_python="3.13",
    force_build=os.environ.get("OPENSTATUS_FORCE_BUILD") == "1",
).entrypoint([])

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
    # next-auth v5 needs an explicit canonical URL for redirect + cookie/URL
    # construction; without it, the standalone Next server infers its internal
    # bind (0.0.0.0:3002) and login redirects to an unreachable host. Pin both
    # (AUTH_URL is v5, NEXTAUTH_URL the v4 fallback some code paths still read).
    "AUTH_URL": PUBLIC_URL,
    "NEXTAUTH_URL": PUBLIC_URL,
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
    # silently stops the cron from ever dispatching this monitor.
    #
    # In self-host there is exactly ONE checker location: the checker stamps every
    # stored result with FLY_REGION regardless of the monitor's configured region,
    # and region-keyed status/uptime resolution only matches when a monitor's
    # stored region == FLY_REGION. So the sole correct invariant is "every monitor
    # and every historical row uses SELF_HOST_REGION". bootstrap() enforces it
    # idempotently on every deploy (see normalize_regions) — new monitors created
    # with the UI's default free-regions get reconciled to SELF_HOST_REGION.
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
    normalized = "skipped"
    try:
        wait_port(8080)
        subprocess.run(
            ["/usr/local/bin/deno", "run", "-A", "--sloppy-imports", "src/migrate.mts"],
            cwd="/opt/openstatus/packages/db",
            check=True,
        )
        normalized = normalize_regions()
    finally:
        stop_process(sqld)
    libsql_volume.commit()
    workflows_volume.commit()
    return {"database": "migrated", "regions": normalized}


def normalize_regions() -> str:
    """Idempotently force every monitor + historical result onto SELF_HOST_REGION.
    Self-host runs ONE checker that stamps FLY_REGION on all results, so region-keyed
    status/uptime resolution only works when stored monitor/ping regions match it —
    otherwise a genuinely-down monitor silently renders "active". Requires sqld on
    :8080 (bootstrap's single-writer instance). Only touches rows that differ, so
    it's a no-op once converged."""
    region = os.environ["SELF_HOST_REGION"]
    stmts = [
        f"UPDATE monitor SET regions = '{region}' WHERE regions <> '{region}'",
        f"UPDATE monitor_status SET region = '{region}' WHERE region <> '{region}'",
        # tb_ping is the self-host durable ping store (the Tinybird-protocol shim);
        # its region drives the uptime/latency dashboard pipes.
        f"UPDATE tb_ping SET region = '{region}' WHERE region <> '{region}'",
    ]
    changed = 0
    for stmt in stmts:
        try:
            req = urllib.request.Request(
                "http://127.0.0.1:8080/",
                data=json.dumps({"statements": [stmt]}).encode(),
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = json.loads(resp.read().decode())
                changed += int(body[0].get("results", {}).get("rows_written", 0))
        except Exception as err:  # noqa: BLE001 — a missing table pre-first-migrate is fine
            print(f"[bootstrap] normalize_regions: {stmt[:40]}... -> {err}")
    return f"region={region} rows_written={changed}"


@app.server(
    image=image,
    port=8100,
    routing_region="us-east",
    compute_region=COMPUTE_REGION,
    volumes=volumes,
    secrets=[secret],
    env=common_env,
    # Measured live: whole supervisord stack (2x next-server + 3x deno + sqld +
    # go bins + nginx + tb-shim) peaks ~1.9GiB RSS. 1cpu/3GiB = ~1.5x headroom,
    # the smallest safe always-on size (do NOT cut memory to the ~2GiB floor:
    # per the snapshot-cost pincer, an OOM-kill bypasses @modal.exit and can drop
    # the check write between 45s persist ticks). ~$1.7/day at standard rates,
    # ~78% under the old 4cpu/8.8GiB ($15.60/day) reservation.
    #
    # Why NOT scale-to-zero + memory snapshot (the obvious "cheaper" move): the
    # pincer proved it corrupts the uptime DB here. Snapshot captures the whole
    # container (subprocs + sockets survive restore), but a snapshotted sqld holds
    # a boot-era page cache while the Volume advances (last-write-wins) → restore
    # serves stale pages, passes integrity_check, then commits over newer data and
    # rewinds history. Snapshot is only safe on a STATELESS dashboard tier (future
    # split), never on the sqld-owning container. Always-on + rightsized it is.
    cpu=1,
    memory=3072,
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
        # Substitute the real public host into the nginx conf BEFORE nginx starts.
        # Modal's edge forwards Host as an internal IP, so nginx must pin the public
        # host (Server Actions + next-auth abort on an Origin/X-Forwarded-Host
        # mismatch). Derived from OPENSTATUS_PUBLIC_URL so the same image works on any
        # workspace (umgbhalla, zonko, ...) — a hardwired host breaks login elsewhere.
        # Use NEXT_PUBLIC_URL: it is baked into common_env at deploy time (the
        # deploy.sh URL-pin pass resolves it to THIS workspace's gateway URL).
        # OPENSTATUS_PUBLIC_URL is only set in the deploy shell, NOT the container
        # runtime, so reading it here would fall back to the hardwired umgbhalla
        # default and mis-pin every non-umgbhalla deploy (breaks Server Actions/login).
        host = (
            (os.environ.get("NEXT_PUBLIC_URL") or PUBLIC_URL)
            .split("://", 1)[-1]
            .split("/", 1)[0]
        )
        conf = Path("/etc/nginx/conf.d/openstatus.conf")
        conf.write_text(conf.read_text().replace("__PUBLIC_HOST__", host))
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
        # Check dispatch runs IN-CONTAINER (see _cron_loop), not as a Modal @app.function
        # + modal.Cron. Reasons: (1) the Gateway is already always-on so a 60s thread is
        # free; (2) it needs zero scheduled-function slots (a Modal plan cap — 5 on the
        # zonko workspace, already full — that otherwise blocks deploy); (3) it dispatches
        # to localhost:3000 directly, eliminating the external cron->gateway hop and the
        # PUBLIC_URL-pin 404 class of bug.
        threading.Thread(target=_cron_loop, daemon=True).start()

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


# NOTE: there is deliberately NO one-off `exec()` maintenance function here.
# A second sqld started against the same libSQL Volume while the always-on Gateway
# is up (it always is: min_containers=1) produces split-brain divergent commits and
# a corrupted last-write-wins snapshot (confirmed HIGH by the self-host audit). Run
# ad-hoc SQL / set-password via `modal container exec` INTO the live Gateway
# container's running sqld instead (see infra/modal/README.md + deploy.sh).


def call_workflow(path: str) -> None:
    """Dispatch one cron period to the in-container workflows service. Isolated
    per-call: a transient failure on one period must NOT abort the rest of the
    tick — a single flaky call must never silently stop ALL monitor dispatch.
    Retries once, then logs and returns."""
    # Direct to the workflows deno service on localhost (nginx :8100 rewrites
    # /internal/workflows/(.*) -> /$1 on :3000; we skip the hop). No PUBLIC_URL,
    # so no external-cron URL-pin 404 footgun. 15s is generous for a localhost
    # trigger that normally returns sub-second.
    url = f"http://127.0.0.1:3000{path}"
    for attempt in (1, 2):
        try:
            request = urllib.request.Request(
                url, headers={"Authorization": os.environ["CRON_SECRET"]}
            )
            with urllib.request.urlopen(request, timeout=15) as response:
                if response.status == 200:
                    return
                print(f"[cron] {path} -> HTTP {response.status}")
        except Exception as err:  # noqa: BLE001
            print(f"[cron] {path} attempt {attempt} failed: {err}")
            if attempt == 1:
                time.sleep(3)


def _dispatch_tick(minute: int) -> None:
    """Dispatch all check periods due this minute. Order 1m first — the common
    case — so the primary cadence is never starved by a rarer period failing."""
    periods = ["1m", "30s"]
    if minute % 5 == 0:
        periods.append("5m")
    if minute % 10 == 0:
        periods.append("10m")
    if minute % 30 == 0:
        periods.append("30m")
    if minute % 60 == 0:
        periods.append("1h")
    # Bound the tick so it can't overlap the next minute's tick under a hung
    # workflows service (1m/30s run first, so the primary cadence is always
    # attempted; rarer long periods are shed and retried next tick).
    deadline = time.time() + 50
    for p in periods:
        if time.time() >= deadline:
            print(f"[cron] tick budget exhausted; skipping: {periods[periods.index(p):]}")
            break
        call_workflow(f"/cron/checker/{p}")


def _cron_loop() -> None:
    """In-container per-minute scheduler (replaces a Modal @app.function +
    modal.Cron). Runs as a daemon thread on the always-on Gateway. Sleeps to each
    minute boundary, then dispatches the due periods. Dies with the container;
    Gateway.start relaunches it on every (re)start, so a recycle only pauses
    checks for the boot window — same as the old external cron."""
    while True:
        now = time.time()
        time.sleep(max(1.0, 60.0 - (now % 60.0)))
        try:
            _dispatch_tick(int(time.time() // 60))
        except Exception as err:  # noqa: BLE001
            print(f"[cron] tick error: {err}")
