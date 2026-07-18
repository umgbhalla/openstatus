import { getLogger } from "@logtape/logtape";
import {
  and,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  notInArray,
} from "@openstatus/db";
import {
  type MonitorStatus,
  maintenance,
  monitor,
  monitorStatusTable,
  selectMonitorSchema,
  selectMonitorStatusSchema,
} from "@openstatus/db/src/schema";
import type { Region } from "@openstatus/db/src/schema/constants";
import type { monitorPeriodicitySchema } from "@openstatus/db/src/schema/constants";
import {
  maintenancesToPageComponents,
  pageComponent,
} from "@openstatus/db/src/schema/page_components";
import { regionDict } from "@openstatus/regions";
import {
  type DNSPayloadSchema,
  type httpPayloadSchema,
  type tpcPayloadSchema,
  transformHeaders,
} from "@openstatus/utils";
import { Effect, Either, Schedule } from "effect";
import { z } from "zod";

import { env } from "../env";
import { db } from "../lib/db";

type TaskInput = {
  row: z.infer<typeof selectMonitorSchema>;
  timestamp: number;
  status: MonitorStatus;
  region: Region;
};

export const isAuthorizedDomain = (url: string) => {
  return url.includes(env().SITE_URL);
};

const logger = getLogger("workflow");

export async function sendCheckerTasks(
  periodicity: z.infer<typeof monitorPeriodicitySchema>,
): Promise<{ success: number; failed: number }> {
  const timestamp = Date.now();

  const currentMaintenance = db
    .select({ id: maintenance.id })
    .from(maintenance)
    .where(
      and(lte(maintenance.from, new Date()), gte(maintenance.to, new Date())),
    )
    .as("currentMaintenance");

  const currentMaintenanceMonitors = db
    .select({ id: pageComponent.monitorId })
    .from(maintenancesToPageComponents)
    .innerJoin(
      currentMaintenance,
      eq(maintenancesToPageComponents.maintenanceId, currentMaintenance.id),
    )
    .innerJoin(
      pageComponent,
      eq(maintenancesToPageComponents.pageComponentId, pageComponent.id),
    )
    .where(isNotNull(pageComponent.monitorId));

  const result = await db
    .select()
    .from(monitor)
    .where(
      and(
        eq(monitor.periodicity, periodicity),
        eq(monitor.active, true),
        notInArray(monitor.id, currentMaintenanceMonitors),
      ),
    )
    .all();

  logger.info("Starting cron job", {
    periodicity,
    monitor_count: result.length,
  });

  const monitors = z.array(selectMonitorSchema).safeParse(result);
  const taskInputs: TaskInput[] = [];
  if (!monitors.success) {
    logger.error(`Error while fetching the monitors ${monitors.error}`);
    throw new Error("Error while fetching the monitors");
  }

  if (monitors.data.length === 0) {
    logger.info("No monitors to check", { periodicity });
    return { success: 0, failed: 0 };
  }

  // Batch fetch all monitor statuses in a single query (N+1 fix)
  const monitorIds = monitors.data.map((m) => m.id);
  const rawStatuses = await db
    .select()
    .from(monitorStatusTable)
    .where(inArray(monitorStatusTable.monitorId, monitorIds))
    .all();

  const statusMap = new Map<
    number,
    z.infer<typeof selectMonitorStatusSchema>[]
  >();
  for (const raw of rawStatuses) {
    const parsed = selectMonitorStatusSchema.safeParse(raw);
    if (!parsed.success) {
      logger.error("Failed to parse monitor status row", {
        monitor_id: raw.monitorId,
        error_message: parsed.error.message,
      });
      continue;
    }
    const list = statusMap.get(raw.monitorId) ?? [];
    list.push(parsed.data);
    statusMap.set(raw.monitorId, list);
  }

  for (const row of monitors.data) {
    const monitorStatuses = statusMap.get(row.id) ?? [];

    for (const region of row.regions) {
      const status =
        monitorStatuses.find((m) => region === m.region)?.status || "active";

      const r = regionDict[region as keyof typeof regionDict];

      if (!r) {
        logger.error(`Invalid region ${region}`);
        continue;
      }
      if (r.deprecated) {
        // Let's uncomment this when we are ready to remove deprecated regions
        // We should not use deprecated regions anymore
        logger.error(`Deprecated region ${region}`);
        continue;
      }
      taskInputs.push({ row, timestamp, status, region });
      if (periodicity === "30s") {
        const scheduledAt = timestamp + 30 * 1000;
        taskInputs.push({
          row,
          timestamp: scheduledAt,
          status,
          region,
        });
      }
    }
  }

  const results = await Effect.runPromise(
    Effect.forEach(
      taskInputs,
      (input) =>
        Effect.tryPromise({
          try: () => createCronTask(input),
          catch: (err) => {
            if (err instanceof Error && "code" in err && err.code === 6) {
              return "ALREADY_EXISTS" as const;
            }
            return new Error(
              `Failed creating task for monitor ${input.row.id} in region ${input.region}`,
            );
          },
        }).pipe(
          Effect.catchIf(
            (err): err is "ALREADY_EXISTS" => err === "ALREADY_EXISTS",
            () => Effect.void,
          ),
          Effect.retry({
            times: 3,
            schedule: Schedule.exponential("1000 millis"),
          }),
          Effect.either,
        ),
      { concurrency: 100 },
    ),
  );

  for (const result of results) {
    if (Either.isLeft(result)) {
      logger.error("Task creation failed after retries", {
        error_message: result.left.message,
      });
    }
  }

  const success = results.filter(Either.isRight).length;
  const failed = results.filter(Either.isLeft).length;

  logger.info("Completed cron job", {
    periodicity,
    total_tasks: taskInputs.length,
    success_count: success,
    failed_count: failed,
    duration_ms: Date.now() - timestamp,
  });
  if (failed > 0) {
    logger.error("Cron job had failures", {
      periodicity,
      failed_count: failed,
      success_count: success,
    });
  }

  return { success, failed };
}
// timestamp needs to be in ms
const createCronTask = async ({
  row,
  timestamp,
  status,
  region,
}: TaskInput) => {
  let payload:
    | z.infer<typeof httpPayloadSchema>
    | z.infer<typeof tpcPayloadSchema>
    | z.infer<typeof DNSPayloadSchema>
    | null = null;

  //
  if (row.jobType === "http") {
    payload = {
      workspaceId: String(row.workspaceId),
      monitorId: String(row.id),
      url: row.url,
      method: row.method || "GET",
      cronTimestamp: timestamp,
      body: row.body,
      headers: row.headers,
      status: status,
      assertions: row.assertions ? JSON.parse(row.assertions) : null,
      degradedAfter: row.degradedAfter,
      timeout: row.timeout,
      trigger: "cron",
      otelConfig: row.otelEndpoint
        ? {
            endpoint: row.otelEndpoint,
            headers: transformHeaders(row.otelHeaders),
          }
        : undefined,
      retry: row.retry || 3,
      followRedirects:
        row.followRedirects === null ? true : row.followRedirects,
    };
  }
  if (row.jobType === "tcp") {
    payload = {
      workspaceId: String(row.workspaceId),
      monitorId: String(row.id),
      uri: row.url,
      status: status,
      assertions: row.assertions ? JSON.parse(row.assertions) : null,
      cronTimestamp: timestamp,
      degradedAfter: row.degradedAfter,
      timeout: row.timeout,
      trigger: "cron",
      retry: row.retry || 3,
      otelConfig: row.otelEndpoint
        ? {
            endpoint: row.otelEndpoint,
            headers: transformHeaders(row.otelHeaders),
          }
        : undefined,
    };
  }
  if (row.jobType === "dns") {
    payload = {
      workspaceId: String(row.workspaceId),
      monitorId: String(row.id),
      uri: row.url,
      cronTimestamp: timestamp,
      status: status,
      assertions: row.assertions ? JSON.parse(row.assertions) : null,
      degradedAfter: row.degradedAfter,
      timeout: row.timeout,
      trigger: "cron",
      otelConfig: row.otelEndpoint
        ? {
            endpoint: row.otelEndpoint,
            headers: transformHeaders(row.otelHeaders),
          }
        : undefined,
      retry: row.retry || 3,
    };
  }

  if (!payload) {
    throw new Error("Invalid jobType");
  }
  const delay = timestamp - Date.now();
  if (delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  const response = await fetch(
    `${env().CHECKER_URL}/checker/${row.jobType}?monitor_id=${row.id}`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${env().CRON_SECRET}`,
        "Content-Type": "application/json",
        "fly-prefer-region": region,
      },
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok) {
    throw new Error(`Checker returned ${response.status}`);
  }
};
