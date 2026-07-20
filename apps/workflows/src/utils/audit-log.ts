import { AuditLog, Tinybird } from "@openstatus/tinybird";

import { env } from "../env";

// Honor TINYBIRD_URL so self-host audit events reach the in-container shim
// instead of the public api.tinybird.co default. Mirrors how
// `@openstatus/tinybird`'s OSTinybird reader already reads process.env.
const tb = new Tinybird({
  token: env().TINY_BIRD_API_KEY,
  baseUrl: process.env.TINYBIRD_URL || undefined,
});

const _audit = new AuditLog({ tb });

// An audit-log write must NEVER abort the status/notification path: publishAuditLog
// is awaited un-wrapped at the incident/recover/degrade/fail sites in checker/index.ts,
// so a transient Tinybird/shim failure there would swallow the alert (the exact job
// of a monitor). Make it non-fatal — log and continue.
export const checkerAudit = {
  publishAuditLog: async (
    ...args: Parameters<AuditLog["publishAuditLog"]>
  ): Promise<void> => {
    try {
      await _audit.publishAuditLog(...args);
    } catch (err) {
      console.error("audit-log publish failed (non-fatal):", err);
    }
  },
};
