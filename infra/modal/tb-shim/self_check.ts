// Self-check for the Tinybird shim aggregation core. No DB required: it feeds
// sample check rows (exactly the shape stored in tb_ping) through the pure
// aggregation helpers and asserts the metrics pipe would return sane values.
//
//   deno test infra/modal/tb-shim/self_check.ts
//
import {
  bucketLatency,
  metricsSummaryRows,
  PERIOD_MS,
  quantile,
  summarizeMetrics,
  timingPhasePercentiles,
} from "./server.ts";

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(
      `assertion failed: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`,
    );
  }
}

// A minute of sample checks: latencies 100..600, one degraded, one error.
function sampleRows() {
  const base = 1_700_000_000_000;
  const latencies = [100, 200, 300, 400, 500, 600];
  return latencies.map((latency, i) => ({
    latency,
    request_status: i === 5 ? "error" : i === 4 ? "degraded" : "success",
    error: i === 5 ? 1 : 0,
    cron_timestamp: base + i * 1000,
    region: i % 2 === 0 ? "ams" : "fra",
    timing: JSON.stringify({
      dnsStart: 1,
      dnsDone: 1 + latency / 10,
      connectStart: 0,
      connectDone: 0,
      tlsHandshakeStart: 0,
      tlsHandshakeDone: 0,
      firstByteStart: 10,
      firstByteDone: 10 + latency / 2,
      transferStart: 0,
      transferDone: 0,
    }),
  }));
}

Deno.test("quantile: linear interpolation", () => {
  const s = [100, 200, 300, 400, 500, 600];
  assertEquals(quantile([], 0.5), null);
  assertEquals(quantile([42], 0.99), 42);
  assertEquals(quantile(s, 0.5), 350); // midpoint of 300 and 400
  assertEquals(quantile(s, 0), 100);
  assertEquals(quantile(s, 1), 600);
});

Deno.test("summarizeMetrics: sane p50/p95 + status counts", () => {
  const [row] = [summarizeMetrics(sampleRows())];
  assertEquals(row.count, 6);
  assertEquals(row.success, 4);
  assertEquals(row.degraded, 1);
  assertEquals(row.error, 1);
  assertEquals(row.ok, 5); // count - error
  assertEquals(row.p50Latency, 350);
  // p95 of 6 sorted values interpolates between 500 and 600.
  const p95 = row.p95Latency as number;
  if (!(p95 > 500 && p95 <= 600)) {
    throw new Error(`p95 out of range: ${p95}`);
  }
  assertEquals(row.lastTimestamp, 1_700_000_000_000 + 5 * 1000);
});

Deno.test("metricsSummaryRows: two rows, current folds last", () => {
  // The overview tiles (uptime/degraded/failing/requests/lastChecked + p50..p99)
  // read this pipe. GlobalUptimeSection returns all-zero tiles unless it gets
  // EXACTLY two rows — regression guard for the single-row bug.
  const rows = metricsSummaryRows(sampleRows(), sampleRows().slice(0, 3));
  assertEquals(rows.length, 2);
  // Previous window comes first and MUST carry a null lastTimestamp so the
  // reader sorts (and folds) the current window last.
  assertEquals(rows[0].lastTimestamp, null);
  assertEquals(rows[0].count, 3);
  // Current window carries the real aggregate + max cron_timestamp.
  assertEquals(rows[1].count, 6);
  assertEquals(rows[1].success, 4);
  assertEquals(rows[1].degraded, 1);
  assertEquals(rows[1].error, 1);
  assertEquals(rows[1].p50Latency, 350);
  assertEquals(rows[1].lastTimestamp, 1_700_000_000_000 + 5 * 1000);
});

Deno.test("bucketLatency: one bucket, integer percentiles", () => {
  const out = bucketLatency(sampleRows(), PERIOD_MS["1d"]);
  assertEquals(out.length, 1);
  assertEquals(out[0].p50Latency, 350);
  assertEquals(Number.isInteger(out[0].p95Latency), true);
});

Deno.test("timingPhasePercentiles: phase durations computed", () => {
  const out = timingPhasePercentiles(sampleRows(), PERIOD_MS["1d"]);
  assertEquals(out.length, 1);
  // ttfb = firstByteDone - firstByteStart = latency/2; p50 over 100..600 -> ~175.
  const p50Ttfb = out[0].p50Ttfb as number;
  if (!(p50Ttfb > 100 && p50Ttfb < 200)) {
    throw new Error(`p50Ttfb out of range: ${p50Ttfb}`);
  }
  // connect/tls hooks never fired (0 endpoints) -> duration 0.
  assertEquals(out[0].p50Connect, 0);
  assertEquals(out[0].p50Tls, 0);
});
