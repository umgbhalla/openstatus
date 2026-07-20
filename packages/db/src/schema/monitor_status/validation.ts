import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { z } from "zod";

import { monitorRegionSchema } from "../constants";
import { monitorStatusSchema } from "../monitors";
import { monitorStatusTable } from "./monitor_status";

// Self-host runs ONE checker in a single region; a monitor status row created
// without an explicit region must default to THAT region, not the hosted "ams"
// (a Fly region no self-host checker probes — the monitor would never resolve).
const DEFAULT_REGION = (process.env.SELF_HOST_REGION || "ams") as z.infer<
  typeof monitorRegionSchema
>;

export const selectMonitorStatusSchema = createSelectSchema(
  monitorStatusTable,
  {
    status: monitorStatusSchema.default("active"),
    region: monitorRegionSchema.default(DEFAULT_REGION),
  },
);

export const insertMonitorStatusSchema = createInsertSchema(
  monitorStatusTable,
  {
    status: monitorStatusSchema.default("active"),
    region: monitorRegionSchema.default(DEFAULT_REGION),
  },
);

// export type InsertMonitorStatus = z.infer<typeof insertMonitorStatusSchema>;
// export type MonitorStatus = z.infer<typeof selectMonitorStatusSchema>;
