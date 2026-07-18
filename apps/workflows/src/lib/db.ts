import { createClient } from "@libsql/client";
import { schema } from "@openstatus/db";
import { drizzle } from "drizzle-orm/libsql";

import { env } from "../env";

// Self-host runs sqld on localhost: an embedded replica buys nothing and its
// construction-time initial sync blocks the process before Deno.serve.
const client =
  process.env.SELF_HOST === "true"
    ? createClient({
        url: env().DATABASE_URL,
        authToken: env().DATABASE_AUTH_TOKEN || undefined,
      })
    : createClient({
        url: `file:${env().NODE_ENV === "development" ? "./dev.db" : "///app/data/replica.db"}`,
        syncUrl: env().DATABASE_URL,
        authToken: env().DATABASE_AUTH_TOKEN,
        syncInterval: 60,
      });

export const db = drizzle({
  client: client,
  schema,
});
