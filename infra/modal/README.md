# OpenStatus on Modal

Full self-hosted OpenStatus process group runs inside one Modal Server container. Internal services bind only to loopback; nginx exposes port `8000`.

## Topology

| Service | Internal address | Storage |
|---|---|---|
| libSQL | `127.0.0.1:8080` | `openstatus-libsql-v2` |
| Tinybird Local | `127.0.0.1:7181` | `openstatus-tinybird-clickhouse-v2`, `openstatus-tinybird-redis-v2` |
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
2. Start libSQL and Tinybird against persistent Volumes.
3. Apply database migrations.
4. Deploy Tinybird resources.
5. Persist Tinybird workspace token inside Tinybird Volume.
6. Deploy `openstatus` Modal Server and scheduled checker dispatcher.

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
