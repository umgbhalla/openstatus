// Tinybird-protocol shim, backed by libSQL (the same sqld on 127.0.0.1:8080).
//
// Speaks ONLY the two Tinybird HTTP surfaces this OpenStatus deployment uses:
//   1. POST /v0/events?name=<datasource>  -> insert rows into a libSQL table.
//   2. GET  /v0/pipes/<name>.json?<params> -> {data:[...], meta:[...]}.
//
// Percentiles are computed IN JS (SQLite has no quantile()). Everything else is
// plain SQL over one wide `tb_ping` table. Unknown pipe names return an empty
// result set (Noop) and NEVER 500 — analytics degrade to blank, never break.
//
// libSQL access is zero-dependency: we speak the Hrana v3 "pipeline" protocol
// (the same wire protocol @libsql/client uses over HTTP) with plain `fetch`.

// Env is read lazily so importing this module for unit tests needs no
// --allow-env: the pure aggregation helpers never touch these.
let _sqldUrl: string | undefined;
function sqldUrl(): string {
  return (_sqldUrl ??=
    Deno.env.get("SQLD_HTTP_URL") ?? "http://127.0.0.1:8080");
}

// ---------------------------------------------------------------------------
// Hrana-over-HTTP client (no external deps)
// ---------------------------------------------------------------------------

type HranaValue =
  | { type: "null" }
  | { type: "integer"; value: string }
  | { type: "float"; value: number }
  | { type: "text"; value: string }
  | { type: "blob"; base64: string };

type SqlArg = string | number | boolean | null | undefined;

let pipelinePath = "/v3/pipeline";

function toHrana(v: SqlArg): HranaValue {
  if (v === null || v === undefined) return { type: "null" };
  if (typeof v === "boolean") return { type: "integer", value: v ? "1" : "0" };
  if (typeof v === "number") {
    return Number.isInteger(v)
      ? { type: "integer", value: String(v) }
      : { type: "float", value: v };
  }
  return { type: "text", value: v };
}

function fromHrana(v: HranaValue): unknown {
  switch (v.type) {
    case "null":
      return null;
    case "integer":
      return Number(v.value);
    case "float":
      return v.value;
    case "text":
      return v.value;
    case "blob":
      return v.base64;
  }
}

async function pipelineFetch(body: string): Promise<Response> {
  return await fetch(`${sqldUrl()}${pipelinePath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

/** Execute one SQL statement with positional `?` args; returns row objects. */
async function sql(
  query: string,
  args: SqlArg[] = [],
): Promise<Record<string, unknown>[]> {
  const body = JSON.stringify({
    requests: [
      {
        type: "execute",
        stmt: { sql: query, args: args.map(toHrana), want_rows: true },
      },
      { type: "close" },
    ],
  });

  let res = await pipelineFetch(body);
  if (res.status === 404 && pipelinePath !== "/v2/pipeline") {
    // Older sqld only exposes v2; fall back once and remember.
    pipelinePath = "/v2/pipeline";
    res = await pipelineFetch(body);
  }
  if (!res.ok) {
    throw new Error(`sqld ${res.status}: ${await res.text()}`);
  }

  const json = await res.json();
  const first = json?.results?.[0];
  if (!first || first.type !== "ok") {
    throw new Error(
      `sqld statement error: ${first?.error?.message ?? "unknown"}`,
    );
  }
  const result = first.response?.result;
  if (!result) return [];
  const cols: string[] = result.cols.map((c: { name: string }) => c.name);
  return result.rows.map((row: HranaValue[]) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < cols.length; i++) obj[cols[i]] = fromHrana(row[i]);
    return obj;
  });
}

// ---------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------

async function initSchema(): Promise<void> {
  // One wide table holds http/tcp/dns raw checks, discriminated by `type`.
  await sql(`CREATE TABLE IF NOT EXISTS tb_ping (
    id TEXT,
    workspace_id TEXT,
    monitor_id TEXT,
    url TEXT,
    method TEXT,
    region TEXT,
    message TEXT,
    timing TEXT,
    headers TEXT,
    assertions TEXT,
    body TEXT,
    trigger TEXT,
    request_status TEXT,
    latency INTEGER,
    cron_timestamp INTEGER,
    timestamp INTEGER,
    status_code INTEGER,
    error INTEGER,
    type TEXT DEFAULT 'http',
    uri TEXT,
    records TEXT,
    error_message TEXT
  )`);
  await sql(
    `CREATE INDEX IF NOT EXISTS idx_ping_mon_ts ON tb_ping(monitor_id, cron_timestamp)`,
  );
  await sql(
    `CREATE INDEX IF NOT EXISTS idx_ping_type_mon_ts ON tb_ping(type, monitor_id, cron_timestamp)`,
  );

  await sql(`CREATE TABLE IF NOT EXISTS tb_audit (
    id TEXT,
    action TEXT,
    timestamp INTEGER,
    version INTEGER,
    actor TEXT,
    targets TEXT,
    metadata TEXT
  )`);
  await sql(
    `CREATE INDEX IF NOT EXISTS idx_audit_id_ts ON tb_audit(id, timestamp)`,
  );

  await sql(`CREATE TABLE IF NOT EXISTS tb_ondemand_http (
    request_id INTEGER,
    workspace_id INTEGER,
    status_code INTEGER,
    latency INTEGER,
    body TEXT,
    headers TEXT,
    timing TEXT,
    region TEXT,
    timestamp INTEGER
  )`);
  await sql(
    `CREATE INDEX IF NOT EXISTS idx_ondemand_req ON tb_ondemand_http(request_id)`,
  );
}

// ---------------------------------------------------------------------------
// Ingest (POST /v0/events)
// ---------------------------------------------------------------------------

// datasource -> { table, columns: {sqlColumn: eventField}, consts: {sqlColumn: value} }
type IngestSpec = {
  table: string;
  columns: Record<string, string>;
  consts?: Record<string, SqlArg>;
  drop?: (e: Record<string, unknown>) => boolean;
};

const PING_COMMON: Record<string, string> = {
  id: "id",
  workspace_id: "workspaceId",
  monitor_id: "monitorId",
  region: "region",
  timing: "timing",
  trigger: "trigger",
  request_status: "requestStatus",
  latency: "latency",
  cron_timestamp: "cronTimestamp",
  timestamp: "timestamp",
  error: "error",
};

const INGEST: Record<string, IngestSpec> = {
  ping_response__v8: {
    table: "tb_ping",
    columns: {
      ...PING_COMMON,
      url: "url",
      method: "method",
      message: "message",
      headers: "headers",
      assertions: "assertions",
      body: "body",
      status_code: "statusCode",
    },
    consts: { type: "http" },
  },
  tcp_response__v0: {
    table: "tb_ping",
    columns: { ...PING_COMMON, uri: "uri", error_message: "errorMessage" },
    consts: { type: "tcp" },
  },
  dns_response__v0: {
    table: "tb_ping",
    columns: {
      ...PING_COMMON,
      uri: "uri",
      error_message: "errorMessage",
      assertions: "assertions",
      records: "records",
    },
    consts: { type: "dns" },
  },
  audit_log__v0: {
    table: "tb_audit",
    columns: {
      id: "id",
      action: "action",
      timestamp: "timestamp",
      version: "version",
      actor: "actor",
      targets: "targets",
      metadata: "metadata",
    },
  },
  check_response_http__v0: {
    table: "tb_ondemand_http",
    columns: {
      request_id: "requestId",
      workspace_id: "workspaceId",
      status_code: "statusCode",
      latency: "latency",
      body: "body",
      headers: "headers",
      timing: "timing",
      region: "region",
      timestamp: "timestamp",
    },
    drop: (e) => !e.requestId,
  },
};

// Columns stored as TEXT even though the writer may send a number (monitorId,
// workspaceId arrive as int64 from tcp/dns). Coerce to string so the reader,
// which queries monitorId as text, matches.
const TEXT_COLUMNS = new Set([
  "id",
  "workspace_id",
  "monitor_id",
  "region",
  "url",
  "method",
  "message",
  "timing",
  "headers",
  "assertions",
  "body",
  "trigger",
  "request_status",
  "type",
  "uri",
  "records",
  "error_message",
  "action",
  "actor",
  "targets",
  "metadata",
]);

function coerceCol(col: string, value: unknown): SqlArg {
  if (value === null || value === undefined) return null;
  if (TEXT_COLUMNS.has(col))
    return typeof value === "string" ? value : String(value);
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseBody(raw: string): Record<string, unknown>[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  // Accept a JSON array, a single JSON object, or NDJSON (one object per line).
  if (trimmed[0] === "[") {
    const arr = JSON.parse(trimmed);
    return Array.isArray(arr) ? arr : [arr];
  }
  const out: Record<string, unknown>[] = [];
  for (const line of trimmed.split("\n")) {
    const l = line.trim();
    if (l) out.push(JSON.parse(l));
  }
  return out;
}

async function insertRow(
  spec: IngestSpec,
  event: Record<string, unknown>,
): Promise<void> {
  const cols: string[] = [];
  const vals: SqlArg[] = [];
  for (const [col, field] of Object.entries(spec.columns)) {
    cols.push(col);
    vals.push(coerceCol(col, event[field]));
  }
  for (const [col, value] of Object.entries(spec.consts ?? {})) {
    cols.push(col);
    vals.push(value);
  }
  const placeholders = cols.map(() => "?").join(", ");
  await sql(
    `INSERT INTO ${spec.table} (${cols.join(", ")}) VALUES (${placeholders})`,
    vals,
  );
}

async function handleEvents(req: Request, name: string): Promise<Response> {
  const raw = await req.text();
  let events: Record<string, unknown>[];
  try {
    events = parseBody(raw);
  } catch {
    // Malformed body: quarantine rather than 500 so writers don't error-loop.
    return json({ successful_rows: 0, quarantined_rows: 0 }, 202);
  }

  const spec = INGEST[name];
  if (!spec) {
    // Unknown datasource: accept + drop (Noop). Never break the writer.
    return json({ successful_rows: events.length, quarantined_rows: 0 }, 202);
  }

  let ok = 0;
  for (const event of events) {
    if (spec.drop?.(event)) continue;
    try {
      await insertRow(spec, event);
      ok++;
    } catch (err) {
      console.error(`insert into ${spec.table} failed:`, err);
    }
  }
  return json({ successful_rows: ok, quarantined_rows: 0 }, 202);
}

// ---------------------------------------------------------------------------
// Aggregation helpers (pure — unit-tested in self_check.ts)
// ---------------------------------------------------------------------------

export const PERIOD_MS: Record<string, number> = {
  "1d": 86_400_000,
  "7d": 604_800_000,
  "14d": 1_209_600_000,
  "30d": 2_592_000_000,
  "90d": 7_776_000_000,
};

// Default time-bucket (minutes) per period when the caller omits `interval`.
const DEFAULT_INTERVAL_MIN: Record<string, number> = {
  "1d": 30,
  "7d": 120,
  "14d": 240,
  "30d": 240,
  "90d": 1440,
};

const PCTL: Array<[string, number]> = [
  ["p50", 0.5],
  ["p75", 0.75],
  ["p90", 0.9],
  ["p95", 0.95],
  ["p99", 0.99],
];

/** Linear-interpolation quantile (numpy default). Returns null on empty input. */
export function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function sortedLatencies(rows: Record<string, unknown>[]): number[] {
  return rows
    .map((r) => r.latency)
    .filter((n): n is number => typeof n === "number")
    .sort((a, b) => a - b);
}

/** {p50Latency..p99Latency} from a row set. `round` forces integer output. */
function latencyPercentiles(
  rows: Record<string, unknown>[],
  round: boolean,
): Record<string, number | null> {
  const sorted = sortedLatencies(rows);
  const out: Record<string, number | null> = {};
  for (const [name, q] of PCTL) {
    const v = quantile(sorted, q);
    out[`${name}Latency`] = v === null ? null : round ? Math.round(v) : v;
  }
  return out;
}

function isError(r: Record<string, unknown>): boolean {
  return r.request_status === "error" || r.error === 1;
}

/** Single summary row: percentiles + success/degraded/error/ok counts. */
export function summarizeMetrics(
  rows: Record<string, unknown>[],
): Record<string, unknown> {
  const count = rows.length;
  const success = rows.filter((r) => r.request_status === "success").length;
  const degraded = rows.filter((r) => r.request_status === "degraded").length;
  const error = rows.filter(isError).length;
  const lastTimestamp = count
    ? Math.max(...rows.map((r) => Number(r.cron_timestamp) || 0))
    : null;
  return {
    ...latencyPercentiles(rows, false),
    count,
    success,
    degraded,
    error,
    ok: count - error, // v0 pipes read {count, ok}
    lastTimestamp,
  };
}

/**
 * The two-row payload the overview summary + percentile tiles read.
 * GlobalUptimeSection.defineMetrics() REQUIRES exactly two rows — the current
 * window and the one immediately before it — to compute the trend badges, and
 * returns all-zero tiles on any other row count. The real Tinybird pipe
 * UNION ALLs current+previous; mirror that. The previous row's lastTimestamp is
 * nulled so the reader (which sorts the row carrying a lastTimestamp last) folds
 * the current window's values in last and trends them against the previous one.
 */
export function metricsSummaryRows(
  current: Record<string, unknown>[],
  previous: Record<string, unknown>[],
): Record<string, unknown>[] {
  return [
    { ...summarizeMetrics(previous), lastTimestamp: null },
    summarizeMetrics(current),
  ];
}

function bucketOf(cronTs: unknown, bucketMs: number): number {
  return Math.floor((Number(cronTs) || 0) / bucketMs) * bucketMs;
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const g = m.get(k);
    if (g) g.push(it);
    else m.set(k, [it]);
  }
  return m;
}

/** Latency percentiles per time bucket. */
export function bucketLatency(
  rows: Record<string, unknown>[],
  bucketMs: number,
): Record<string, unknown>[] {
  const groups = groupBy(rows, (r) =>
    String(bucketOf(r.cron_timestamp, bucketMs)),
  );
  const out: Record<string, unknown>[] = [];
  for (const [bucket, g] of groups) {
    out.push({ timestamp: Number(bucket), ...latencyPercentiles(g, true) });
  }
  return out.sort((a, b) => (a.timestamp as number) - (b.timestamp as number));
}

/** Latency percentiles per (region, time bucket). */
function bucketRegionLatency(
  rows: Record<string, unknown>[],
  bucketMs: number,
): Record<string, unknown>[] {
  const groups = groupBy(
    rows,
    (r) => `${r.region} ${bucketOf(r.cron_timestamp, bucketMs)}`,
  );
  const out: Record<string, unknown>[] = [];
  for (const [key, g] of groups) {
    const [region, bucket] = key.split(" ");
    out.push({
      region,
      timestamp: Number(bucket),
      ...latencyPercentiles(g, false),
    });
  }
  return out.sort(
    (a, b) =>
      String(a.region).localeCompare(String(b.region)) ||
      (a.timestamp as number) - (b.timestamp as number),
  );
}

/** Per-region totals + percentiles (no time bucket). */
function regionTotals(
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  const groups = groupBy(rows, (r) => String(r.region));
  const out: Record<string, unknown>[] = [];
  for (const [region, g] of groups) {
    const error = g.filter(isError).length;
    out.push({
      region,
      count: g.length,
      ok: g.length - error,
      ...latencyPercentiles(g, false),
    });
  }
  return out.sort((a, b) => String(a.region).localeCompare(String(b.region)));
}

const PHASES: Array<[string, string, string]> = [
  ["Dns", "dnsStart", "dnsDone"],
  ["Connect", "connectStart", "connectDone"],
  ["Tls", "tlsHandshakeStart", "tlsHandshakeDone"],
  ["Ttfb", "firstByteStart", "firstByteDone"],
  ["Transfer", "transferStart", "transferDone"],
];

function phaseDuration(start: number, done: number): number {
  // 0 = hook never fired; subtracting absolute epoch clocks would be garbage.
  if (!start || !done) return 0;
  return done - start;
}

/** Per time bucket: p{50..99}{Dns,Connect,Tls,Ttfb,Transfer}. */
export function timingPhasePercentiles(
  rows: Record<string, unknown>[],
  bucketMs: number,
): Record<string, unknown>[] {
  const groups = groupBy(rows, (r) =>
    String(bucketOf(r.cron_timestamp, bucketMs)),
  );
  const out: Record<string, unknown>[] = [];
  for (const [bucket, g] of groups) {
    const perPhase: Record<string, number[]> = {};
    for (const [label] of PHASES) perPhase[label] = [];
    for (const r of g) {
      if (typeof r.timing !== "string" || !r.timing) continue;
      let t: Record<string, number>;
      try {
        t = JSON.parse(r.timing);
      } catch {
        continue;
      }
      for (const [label, s, d] of PHASES) {
        perPhase[label].push(
          phaseDuration(Number(t[s]) || 0, Number(t[d]) || 0),
        );
      }
    }
    const row: Record<string, unknown> = { timestamp: Number(bucket) };
    for (const [pName, q] of PCTL) {
      for (const [label] of PHASES) {
        const sorted = [...perPhase[label]].sort((a, b) => a - b);
        const v = quantile(sorted, q);
        row[`${pName}${label}`] = v === null ? 0 : Math.round(v);
      }
    }
    out.push(row);
  }
  return out.sort((a, b) => (a.timestamp as number) - (b.timestamp as number));
}

/** Bucketed success/degraded/error counts (uptime chart). */
function uptimeBuckets(
  rows: Record<string, unknown>[],
  bucketMs: number,
): Record<string, unknown>[] {
  const groups = groupBy(rows, (r) =>
    String(bucketOf(r.cron_timestamp, bucketMs)),
  );
  const out: Record<string, unknown>[] = [];
  for (const [bucket, g] of groups) {
    out.push({
      interval: Number(bucket),
      success: g.filter((r) => r.request_status === "success").length,
      degraded: g.filter((r) => r.request_status === "degraded").length,
      error: g.filter(isError).length,
    });
  }
  return out.sort((a, b) => (a.interval as number) - (b.interval as number));
}

// ---------------------------------------------------------------------------
// Pipe reader (GET /v0/pipes/<name>.json)
// ---------------------------------------------------------------------------

type Params = URLSearchParams;

function num(p: Params, key: string): number | undefined {
  const v = p.get(key);
  return v == null ? undefined : Number(v);
}

function toMs(v: string | null): number | undefined {
  if (v == null) return undefined;
  if (/^-?\d+$/.test(v)) return Number(v);
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

function list(p: Params, key: string): string[] | undefined {
  const v = p.get(key);
  if (v == null || v === "") return undefined;
  // zod-bird serializes arrays via Array.toString() -> comma-joined.
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function bucketMsFor(period: string, p: Params): number {
  const interval = num(p, "interval"); // minutes
  const mins =
    interval && interval > 0 ? interval : (DEFAULT_INTERVAL_MIN[period] ?? 30);
  return mins * 60_000;
}

/** Fetch raw check rows for one monitor within a window, optional region filter. */
async function fetchRows(
  type: string,
  monitorId: string,
  fromMs: number,
  toMs: number,
  cols: string,
  regions?: string[],
): Promise<Record<string, unknown>[]> {
  const rows = await sql(
    `SELECT ${cols} FROM tb_ping
     WHERE type = ? AND monitor_id = ?
       AND cron_timestamp >= ? AND cron_timestamp <= ?
     ORDER BY cron_timestamp DESC`,
    [type, monitorId, fromMs, toMs],
  );
  if (regions && regions.length) {
    const set = new Set(regions);
    return rows.filter((r) => set.has(String(r.region)));
  }
  return rows;
}

const METRIC_COLS =
  "latency, request_status, error, cron_timestamp, region, timing";

function normalizeRequestStatus(v: unknown): string | null {
  return v === "success" || v === "degraded" || v === "error" ? v : null;
}

function normalizeTrigger(v: unknown): string | null {
  return v === "cron" || v === "api" ? v : null;
}

function nullableInt(v: unknown): number | null {
  return typeof v === "number" && v !== 0 ? v : v === 0 ? 0 : null;
}

// Regex families. Each returns the data rows (already reader-shaped).
type Family = {
  re: RegExp;
  run: (m: RegExpMatchArray, p: Params) => Promise<Record<string, unknown>[]>;
};

const PERIOD = "(1d|7d|14d|30d|90d)";

const FAMILIES: Family[] = [
  // --- response-log list -------------------------------------------------
  {
    re: new RegExp(`^endpoint__(http|tcp|dns)_list_${PERIOD}(_multi)?__v[01]$`),
    run: async (m, p) => {
      const type = m[1];
      const period = m[2];
      const monitorId = p.get("monitorId") ?? "";
      const fromMs =
        toMs(p.get("fromDate")) ??
        Date.now() - (PERIOD_MS[period] ?? PERIOD_MS["14d"]);
      const toMsV = toMs(p.get("toDate")) ?? Date.now();
      const limit = num(p, "limit");
      const offset = num(p, "offset") ?? 0;
      let rows = await sql(
        `SELECT id, latency, status_code, monitor_id, request_status, region,
                cron_timestamp, trigger, timestamp, timing, url, method, message,
                headers, assertions, body, uri, records, error_message, workspace_id, error
         FROM tb_ping
         WHERE type = ? AND monitor_id = ?
           AND cron_timestamp >= ? AND cron_timestamp <= ?
         ORDER BY cron_timestamp DESC`,
        [type, monitorId, fromMs, toMsV],
      );
      if (limit != null) rows = rows.slice(offset, offset + limit);
      return rows.map((r) => shapeListRow(type, r));
    },
  },
  // --- summary tiles (percentiles + status counts) -----------------------
  // Returns TWO rows (current + previous window). The reader bails to all-zero
  // tiles unless it gets exactly two — see metricsSummaryRows.
  {
    re: new RegExp(`^endpoint__(http|tcp|dns)_metrics_${PERIOD}__v[01]$`),
    run: async (m, p) => {
      const type = m[1];
      const period = m[2];
      const monitorId = p.get("monitorId") ?? "";
      const regions = list(p, "regions");
      const fromMs =
        toMs(p.get("fromDate")) ??
        Date.now() - (PERIOD_MS[period] ?? PERIOD_MS["1d"]);
      const toMsV = toMs(p.get("toDate")) ?? Date.now();
      const windowLen = toMsV - fromMs;
      const current = await fetchRows(
        type,
        monitorId,
        fromMs,
        toMsV,
        METRIC_COLS,
        regions,
      );
      const previous = await fetchRows(
        type,
        monitorId,
        fromMs - windowLen,
        fromMs - 1,
        METRIC_COLS,
        regions,
      );
      return metricsSummaryRows(current, previous);
    },
  },
  // --- latency-over-time (single + multi monitor) ------------------------
  {
    re: new RegExp(
      `^endpoint__(http|tcp|dns)_metrics_latency_${PERIOD}(_multi)?__v[01]$`,
    ),
    run: async (m, p) => {
      const type = m[1];
      const period = m[2];
      const multi = !!m[3];
      const fromMs =
        toMs(p.get("fromDate")) ??
        Date.now() - (PERIOD_MS[period] ?? PERIOD_MS["1d"]);
      const toMsV = toMs(p.get("toDate")) ?? Date.now();
      const bucketMs = bucketMsFor(period, p);
      const regions = list(p, "regions");
      if (multi) {
        const ids = list(p, "monitorIds") ?? [];
        const out: Record<string, unknown>[] = [];
        for (const id of ids) {
          const rows = await fetchRows(
            type,
            id,
            fromMs,
            toMsV,
            "latency, cron_timestamp, region",
            regions,
          );
          for (const b of bucketLatency(rows, bucketMs))
            out.push({ ...b, monitorId: id });
        }
        return out;
      }
      const monitorId = p.get("monitorId") ?? "";
      const rows = await fetchRows(
        type,
        monitorId,
        fromMs,
        toMsV,
        "latency, cron_timestamp, region",
        regions,
      );
      return bucketLatency(rows, bucketMs);
    },
  },
  // --- per-region x interval (regions / by_interval) ---------------------
  {
    re: new RegExp(
      `^endpoint__(http|tcp|dns)_metrics_(?:regions|by_interval)_${PERIOD}__v[01]$`,
    ),
    run: async (m, p) => {
      const [rows] = await windowRows(
        m[1],
        m[2],
        p,
        "latency, cron_timestamp, region",
      );
      return bucketRegionLatency(rows, bucketMsFor(m[2], p));
    },
  },
  // --- per-region totals (no bucket) -------------------------------------
  {
    re: new RegExp(
      `^endpoint__(http|tcp|dns)_metrics_by_region_${PERIOD}__v[01]$`,
    ),
    run: async (m, p) => {
      const [rows] = await windowRows(
        m[1],
        m[2],
        p,
        "latency, request_status, error, region",
      );
      return regionTotals(rows);
    },
  },
  // --- timing phases (http only in practice) -----------------------------
  {
    re: new RegExp(`^endpoint__(http|tcp|dns)_timing_phases_${PERIOD}__v[01]$`),
    run: async (m, p) => {
      const [rows] = await windowRows(
        m[1],
        m[2],
        p,
        "cron_timestamp, timing, region",
      );
      return timingPhasePercentiles(rows, bucketMsFor(m[2], p));
    },
  },
  // --- daily ok/degraded/error tracker (45d) -----------------------------
  {
    re: /^endpoint__(http|tcp|dns)_status_45d__v[01]$/,
    run: async (m, p) => statusDaily(m[1], p, 45),
  },
  {
    re: /^endpoint__(http|tcp|dns)_status_7d__v[01]$/,
    run: async (m, p) => statusDaily(m[1], p, 7),
  },
  // --- bucketed uptime counts --------------------------------------------
  {
    re: /^endpoint__(http|tcp|dns)_uptime_(7d|30d|90d)__v[01]$/,
    run: async (m, p) => {
      const type = m[1];
      const period = m[2];
      const monitorId = p.get("monitorId") ?? "";
      const fromMs =
        toMs(p.get("fromDate")) ??
        Date.now() - (PERIOD_MS[period] ?? PERIOD_MS["30d"]);
      const toMsV = toMs(p.get("toDate")) ?? Date.now();
      const rows = await fetchRows(
        type,
        monitorId,
        fromMs,
        toMsV,
        "request_status, error, cron_timestamp, region",
        list(p, "regions"),
      );
      return uptimeBuckets(rows, bucketMsFor(period, p));
    },
  },
  // --- workspace-level daily counts --------------------------------------
  {
    re: /^endpoint__(http|tcp|dns)_workspace_30d__v[01]$/,
    run: async (m, p) => {
      const type = m[1];
      const workspaceId = p.get("workspaceId") ?? "";
      const rows = await sql(
        `SELECT strftime('%Y-%m-%d 00:00:00', cron_timestamp/1000, 'unixepoch') AS day,
                COUNT(*) AS count
         FROM tb_ping
         WHERE type = ? AND workspace_id = ? AND cron_timestamp >= ?
         GROUP BY day ORDER BY day`,
        [type, workspaceId, Date.now() - PERIOD_MS["30d"]],
      );
      return rows;
    },
  },
  // --- global per-monitor metrics ----------------------------------------
  {
    re: /^endpoint__(http|tcp|dns)_metrics_global_1d__v[01]$/,
    run: async (m, p) => {
      const type = m[1];
      const ids = list(p, "monitorIds") ?? [];
      const fromMs = Date.now() - PERIOD_MS["1d"];
      const out: Record<string, unknown>[] = [];
      for (const id of ids) {
        const rows = await fetchRows(type, id, fromMs, Date.now(), METRIC_COLS);
        const sorted = sortedLatencies(rows);
        if (!sorted.length) continue;
        const pct = latencyPercentiles(rows, true);
        out.push({
          minLatency: sorted[0],
          maxLatency: sorted[sorted.length - 1],
          p50Latency: pct.p50Latency ?? 0,
          p75Latency: pct.p75Latency ?? 0,
          p90Latency: pct.p90Latency ?? 0,
          p95Latency: pct.p95Latency ?? 0,
          p99Latency: pct.p99Latency ?? 0,
          lastTimestamp: Math.max(
            ...rows.map((r) => Number(r.cron_timestamp) || 0),
          ),
          count: rows.length,
          monitorId: id,
        });
      }
      return out;
    },
  },
  // --- detail get (14d / 30d) --------------------------------------------
  {
    re: new RegExp(`^endpoint__(http|tcp|dns)_get_${PERIOD}__v[01]$`),
    run: async (m, p) => {
      const type = m[1];
      const period = m[2];
      const monitorId = p.get("monitorId") ?? "";
      const id = p.get("id");
      const region = p.get("region");
      const cronTs = num(p, "cronTimestamp");
      const fromMs = Date.now() - (PERIOD_MS[period] ?? PERIOD_MS["14d"]);
      let rows = await sql(
        `SELECT id, latency, status_code, monitor_id, request_status, region,
                cron_timestamp, trigger, timestamp, timing, url, method, message,
                headers, assertions, body, uri, records, error_message, workspace_id, error
         FROM tb_ping
         WHERE type = ? AND monitor_id = ? AND cron_timestamp >= ?
         ORDER BY cron_timestamp DESC`,
        [type, monitorId, fromMs],
      );
      if (id) rows = rows.filter((r) => String(r.id) === id);
      if (region) rows = rows.filter((r) => String(r.region) === region);
      if (cronTs != null)
        rows = rows.filter((r) => Number(r.cron_timestamp) === cronTs);
      return rows.map((r) => shapeGetRow(type, r));
    },
  },
  // --- audit log ---------------------------------------------------------
  {
    re: /^endpoint_?_audit_log__v[01]$/,
    run: async (_m, p) => {
      const monitorId = p.get("monitorId") ?? "";
      const intervalDays = num(p, "interval") ?? 30;
      const fromMs = Date.now() - intervalDays * PERIOD_MS["1d"];
      return await sql(
        `SELECT action, id, metadata, timestamp FROM tb_audit
         WHERE id = ? AND timestamp >= ? ORDER BY timestamp DESC`,
        [monitorId, fromMs],
      );
    },
  },
  // --- on-demand http check result ---------------------------------------
  {
    re: /^get_result_for_on_demand_check_http$/,
    run: async (_m, p) => {
      const monitorId = p.get("monitorId");
      const rows = await sql(
        `SELECT request_id, status_code, latency, body, headers, timing, region, timestamp
         FROM tb_ondemand_http
         WHERE request_id = ? ORDER BY timestamp DESC LIMIT 1`,
        [monitorId ? Number(monitorId) : 0],
      );
      return rows.map((r) => ({
        latency: Number(r.latency) || 0,
        statusCode: nullableInt(r.status_code),
        monitorId: monitorId ?? "",
        error: 0,
        region: r.region,
        timestamp: Number(r.timestamp) || 0,
        message: null,
        timing: typeof r.timing === "string" ? r.timing : null,
      }));
    },
  },
  // --- global home stats -------------------------------------------------
  {
    re: /^endpoint__stats_global__v[01]$/,
    run: async () => {
      const rows = await sql(`SELECT COUNT(*) AS count FROM tb_ping`);
      return [{ count: Number(rows[0]?.count) || 0 }];
    },
  },
];

/** Shared: fetch the standard window row set for metric families. */
async function windowRows(
  type: string,
  period: string,
  p: Params,
  cols: string,
): Promise<[Record<string, unknown>[], number]> {
  const monitorId = p.get("monitorId") ?? "";
  const fromMs =
    toMs(p.get("fromDate")) ??
    Date.now() - (PERIOD_MS[period] ?? PERIOD_MS["1d"]);
  const toMsV = toMs(p.get("toDate")) ?? Date.now();
  const rows = await fetchRows(
    type,
    monitorId,
    fromMs,
    toMsV,
    cols,
    list(p, "regions"),
  );
  return [rows, fromMs];
}

async function statusDaily(
  type: string,
  p: Params,
  days: number,
): Promise<Record<string, unknown>[]> {
  const ids = list(p, "monitorIds") ?? list(p, "monitorId") ?? [];
  if (!ids.length) return [];
  const fromMs = Date.now() - days * PERIOD_MS["1d"];
  const placeholders = ids.map(() => "?").join(", ");
  return await sql(
    `SELECT strftime('%Y-%m-%d 00:00:00', cron_timestamp/1000, 'unixepoch') AS day,
            monitor_id AS monitorId,
            COUNT(*) AS count,
            SUM(CASE WHEN request_status = 'success' THEN 1 ELSE 0 END) AS ok,
            SUM(CASE WHEN request_status = 'degraded' THEN 1 ELSE 0 END) AS degraded,
            SUM(CASE WHEN request_status = 'error' OR error = 1 THEN 1 ELSE 0 END) AS error
     FROM tb_ping
     WHERE type = ? AND monitor_id IN (${placeholders}) AND cron_timestamp >= ?
     GROUP BY day, monitor_id ORDER BY day`,
    [type, ...ids, fromMs],
  );
}

function shapeListRow(
  type: string,
  r: Record<string, unknown>,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    type,
    id: r.id == null ? null : String(r.id),
    latency: Number(r.latency) || 0,
    monitorId: String(r.monitor_id ?? ""),
    requestStatus: normalizeRequestStatus(r.request_status),
    region: r.region,
    cronTimestamp: Number(r.cron_timestamp) || 0,
    trigger: normalizeTrigger(r.trigger),
    timestamp: Number(r.timestamp) || Number(r.cron_timestamp) || 0,
  };
  if (type === "http") {
    base.statusCode = nullableInt(r.status_code);
    base.timing = typeof r.timing === "string" ? r.timing : null;
  } else {
    base.uri = String(r.uri ?? "");
    if (type === "dns")
      base.records = typeof r.records === "string" ? r.records : "{}";
  }
  return base;
}

function shapeGetRow(
  type: string,
  r: Record<string, unknown>,
): Record<string, unknown> {
  const base = shapeListRow(type, r);
  base.url = r.url ?? "";
  base.message = r.message == null ? null : String(r.message);
  base.headers = typeof r.headers === "string" ? r.headers : null;
  base.assertions = r.assertions == null ? null : String(r.assertions);
  base.body = r.body == null ? null : String(r.body);
  base.workspaceId = String(r.workspace_id ?? "");
  base.error = Number(r.error) || 0;
  base.timing = typeof r.timing === "string" ? r.timing : null;
  if (type !== "http")
    base.errorMessage =
      r.error_message == null ? null : String(r.error_message);
  return base;
}

async function handlePipe(name: string, p: Params): Promise<Response> {
  for (const fam of FAMILIES) {
    const m = name.match(fam.re);
    if (m) {
      try {
        const data = await fam.run(m, p);
        return json({ meta: [], data });
      } catch (err) {
        console.error(`pipe ${name} failed:`, err);
        return json({ meta: [], data: [] }); // degrade, never 500
      }
    }
  }
  // Unknown pipe -> Noop empty result set.
  return json({ meta: [], data: [] });
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "POST" && path === "/v0/events") {
    const name = url.searchParams.get("name") ?? "";
    return await handleEvents(req, name);
  }

  if (
    req.method === "GET" &&
    path.startsWith("/v0/pipes/") &&
    path.endsWith(".json")
  ) {
    const name = path.slice("/v0/pipes/".length, -".json".length);
    return await handlePipe(name, url.searchParams);
  }

  if (path === "/" || path === "/health" || path === "/healthz") {
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
}

if (import.meta.main) {
  const host = Deno.env.get("TB_SHIM_HOST") ?? "127.0.0.1";
  const port = Number(Deno.env.get("TB_SHIM_PORT") ?? "7181");
  // Supervisor priority orders start, not readiness — sqld may not be listening
  // yet. Retry schema bootstrap until it succeeds (or we give up and serve
  // anyway; pipes degrade to empty until the DB is reachable).
  for (let i = 0; i < 60; i++) {
    try {
      await initSchema();
      break;
    } catch (err) {
      if (i === 59) console.error("tb-shim: schema init still failing:", err);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  console.error(
    `tb-shim listening on http://${host}:${port} -> sqld ${sqldUrl()}`,
  );
  Deno.serve({ hostname: host, port }, handler);
}
