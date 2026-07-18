# OpenStatus on Modal

Full self-hosted OpenStatus process group runs inside one Modal Server container. Internal services bind only to loopback; the single nginx exposes public port `8100`.

## Image variant (why Tinybird is embedded)

Analytics in OpenStatus — uptime %, latency p50/p90/p95, response-time charts,
response logs, ping history — are **100% ClickHouse/Tinybird**; there is no libSQL
fallback for them. To make those flow in the single-container Modal deploy we embed
**Tinybird Local**.

**Variant chosen: 2 — `FROM tinybirdco/tinybird-local:latest` as the runtime base**
(the pragmatic call). That base already ships ClickHouse + Redis + `tinybird_server`
+ the `tb` CLI, all managed by its own supervisord and nginx. Replicating those
internals into a `node:24-slim` base (Variant 1) is far more fragile — copying the
ClickHouse/Redis/python rootfs and reconstructing their supervisor entries by hand.
Instead we layer node + deno + sqld + the Go binaries + the Next standalone bundles
onto the tinybird base and **merge** our services into the base's existing include
dirs. There is exactly **one** supervisord and **one** nginx in the container:

- `Dockerfile.modal` final stage: `FROM tinybirdco/tinybird-local:latest`, then
  `COPY --from=node /usr/local/` (node/npm/corepack) + deno + sqld + go bins + Next.
- Our supervisor programs → `/etc/supervisor/conf.d/openstatus.conf`, merged by the
  base's `/etc/supervisor/supervisord.conf` (`[include] files=conf.d/*.conf`).
  We deliberately do **not** add a `[program:nginx]` — the base already runs one.
- Our public `:8100` server → `/etc/nginx/conf.d/openstatus.conf`, served by the
  base's single nginx (its `nginx.conf` includes both `conf.d/*.conf` and
  `sites-enabled/*`). Tinybird's own nginx site owns `:7181`/`:7182`; no collision.

## Topology

| Service | Internal address | Storage |
|---|---|---|
| libSQL | `127.0.0.1:8080` | `openstatus-libsql-v2` |
| Tinybird Local (nginx API) | `127.0.0.1:7181` (`:7182`) | `openstatus-tinybird-clickhouse-v1`, `openstatus-tinybird-redis-v1` |
| Workflows | `127.0.0.1:3000` | `openstatus-workflows-v2` |
| API | `127.0.0.1:3001` | libSQL/Tinybird |
| Dashboard | `127.0.0.1:3002` | libSQL/Tinybird |
| Status page | `127.0.0.1:3003` | libSQL/Tinybird |
| Private-location orchestrator | `127.0.0.1:8081` | libSQL/Tinybird |
| Checker | `127.0.0.1:8082` | libSQL/Tinybird |
| Private probe | daemon, health `127.0.0.1:8083` | reconstructable |
| nginx (single, from base) | public `:8100` + tinybird `:7181`/`:7182` | none |

Tinybird's internal ports (`:8000` tokens, `:8001` clickhouse-http, `:8042` hfi
ingest, `:8043` mcp, redis, clickhouse) stay loopback-only and are not proxied.

Public routes:

- `/` dashboard
- `/status/<slug>` status page
- `/openstatus-api/*` API
- `/healthz` process-group ingress health
- `/internal/workflows/*` authenticated workflow callbacks

No database, analytics, checker, or private-location port is publicly exposed.

## Deploy

```bash
./infra/modal/deploy.sh
```

Deployment order:

1. Create/update Modal secret `openstatus`.
2. `bootstrap()`: start the base's Tinybird stack (ClickHouse/Redis/`tinybird_server`)
   under supervisord with OUR programs disabled, plus a hand-started `sqld`.
3. Poll `http://127.0.0.1:7181/tokens` until the workspace admin token is minted.
4. Apply database migrations (`packages/db/src/migrate.mts`).
5. Deploy Tinybird resources (`cd packages/tinybird && tb --local deploy` — 55
   `.datasource` + 152 `.pipe` defs).
6. Persist the workspace token to `/var/lib/clickhouse/.tb-token` on the durable
   ClickHouse Volume.
7. Deploy `openstatus` Modal Server (reads the token file at `start()` and exports
   `TINYBIRD_URL` / `TINY_BIRD_API_KEY` / `TINYBIRD_TOKEN` into the environment
   before launching supervisord) and the scheduled checker dispatcher.

Token flow: `TINY_BIRD_API_KEY` feeds the TS readers/writers (`OSTinybird`,
`packages/api` tRPC tinybird router); `TINYBIRD_TOKEN` feeds the Go checker
(`apps/checker`); both read `TINYBIRD_URL=http://127.0.0.1:7181`. Empty tokens at
build time / first boot are fine (TS → `NoopTinybird`, Go checker drops events);
they are replaced at runtime once bootstrap has run.

Resources: the Gateway and bootstrap run at `cpu=8`, `memory=16384` (ClickHouse is
heavy). The ClickHouse (`/var/lib/clickhouse`) and Redis (`/redis-data`) volumes are
`-v1`; libSQL/workflows remain `-v2`.

Default URL:

```text
https://umgbhalla--openstatus-gateway.modal.run
```

Override with `OPENSTATUS_PUBLIC_URL` before deploy when Modal assigns a different URL.

## Authentication

`infra/modal/.env.modal` is generated locally and ignored by Git. It initially contains:

- `AUTH_SECRET`
- `CRON_SECRET`
- `SUPER_ADMIN_TOKEN`
- placeholder `RESEND_API_KEY`

For GitHub login, create an OAuth App at <https://github.com/settings/developers>:

- Homepage URL: `https://umgbhalla--openstatus-gateway.modal.run`
- Callback URL: `https://umgbhalla--openstatus-gateway.modal.run/api/auth/callback/github`

Add to `infra/modal/.env.modal`:

```dotenv
AUTH_GITHUB_ID=...
AUTH_GITHUB_SECRET=...
```

Re-run deploy script. OpenStatus dashboard access follows users admitted by GitHub OAuth plus workspace membership. No hosted OpenStatus account is involved.

Magic-link login: in self-host mode the auth provider prints the magic link to
container stdout instead of emailing it — read it with `modal app logs
openstatus`. GitHub OAuth is the primary login path. A real `RESEND_API_KEY`
only matters after patching the dashboard auth provider to actually send email.

### Email + password login

Self-host mode (`SELF_HOST=true`, always set here) also enables an email +
password login on `/login` via the Auth.js Credentials provider. This uses the
JWT session strategy (only when `SELF_HOST=true`) and a nullable
`user.password_hash` column (migration `0081_fine_iron_patriot`).

The user row must already exist — sign in once with GitHub/Google/magic-link to
create the user and its workspace, then stamp a bcrypt password hash with the
`set-password` script.

libSQL binds to loopback (`127.0.0.1:8080`) inside the running Gateway
container, so run the script INSIDE that live container (never spin up a second
`sqld` against the Volume — that breaks the single-writer fence). Exec into the
running container:

```bash
CID=$(modal container list --env "$MODAL_ENVIRONMENT" | grep openstatus | awk '{print $1}')
modal container exec "$CID" sh -c \
  'cd /opt/openstatus/packages/db && \
   DATABASE_URL=http://127.0.0.1:8080 DATABASE_AUTH_TOKEN= \
   /usr/local/bin/deno run -A --sloppy-imports src/set-password.mts \
   admin@example.com "correct-horse-battery"'
```

The script errors clearly if no user with that email exists (it never creates a
user or workspace). Passwords must be at least 8 characters. Re-running it resets
the password for that user.

Region: single self-host checker region is `ams` (`FLY_REGION`/`SELF_HOST_REGION`).
Create monitors with region `ams` only — other regions trigger fly-replay
semantics that have no proxy here.

## Harp monitor

Target:

```text
https://umgbhalla--harp-ingress.modal.run/readyz
```

Header:

```text
Authorization: Bearer <HARP_UPTIME_PROBE_SECRET>
```

Assertions:

- status `200`
- body contains `"ok":true`
- body contains `"environment":"umang"`
- body contains `"database":"ok"`
