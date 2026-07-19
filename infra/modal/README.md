# OpenStatus on Modal

Full self-hosted OpenStatus process group runs inside one Modal Server container. Internal services bind only to loopback; nginx exposes port `8000`.

## Topology

| Service | Internal address | Storage |
|---|---|---|
| libSQL | `127.0.0.1:8080` | `openstatus-libsql-v2` |
| Tinybird shim | `127.0.0.1:7181` | libSQL (`tb_ping`/`tb_audit`/`tb_ondemand_http`) |
| Workflows | `127.0.0.1:3000` | `openstatus-workflows-v2` |
| API | `127.0.0.1:3001` | libSQL/Tinybird |
| Dashboard | `127.0.0.1:3002` | libSQL/Tinybird |
| Status page | `127.0.0.1:3003` | libSQL/Tinybird |
| Private-location orchestrator | `127.0.0.1:8081` | libSQL/Tinybird |
| Checker | `127.0.0.1:8082` | libSQL/Tinybird |
| Private probe | daemon, health `127.0.0.1:8083` | reconstructable |
| nginx | public `:8000` | none |

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
2. Start libSQL against its persistent Volume.
3. Apply database migrations.
4. Deploy `openstatus` Modal Server and scheduled checker dispatcher.

Analytics (uptime, latency percentiles, response logs, tracker, audit log) are
served by the in-container `tb-shim` (Deno, `:7181`) which speaks the Tinybird
HTTP API and stores rows in the same libSQL. No ClickHouse/Tinybird/Redis. See
`infra/modal/tb-shim/`.

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

Region: single self-host checker region is `sjc` (`FLY_REGION`/`SELF_HOST_REGION`) —
a non-deprecated FLY_REGIONS id near Modal's us-west compute (`sea` is deprecated and
`sendCheckerTasks` silently skips deprecated regions). Create monitors with region
`sjc` only — other regions trigger fly-replay semantics that have no proxy here, and
region-keyed status/uptime resolution only matches the region the checker stamps
(`FLY_REGION`). `bootstrap()` reconciles any monitor/ping rows to `SELF_HOST_REGION`
on every deploy, so a monitor created with the UI's default free-regions is healed
on the next deploy — but prefer creating it as `sjc` up front.

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
