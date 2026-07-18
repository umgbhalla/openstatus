import { AuditLog, Tinybird } from "@openstatus/tinybird";

import { env } from "../env";

// Honor TINYBIRD_URL so self-host audit events reach the in-container shim
// instead of the public api.tinybird.co default. Mirrors how
// `@openstatus/tinybird`'s OSTinybird reader already reads process.env.
const tb = new Tinybird({
  token: env().TINY_BIRD_API_KEY,
  baseUrl: process.env.TINYBIRD_URL || undefined,
});

export const checkerAudit = new AuditLog({ tb });
