import { createClient } from "@libsql/client";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";

import { env } from "../env.mjs";
import { user } from "./schema";

/**
 * Set (or reset) the email+password credential for an EXISTING user, used by the
 * self-host email+password login (SELF_HOST=true).
 *
 * The user must already exist — create it first via magic-link/OAuth sign-in.
 * This script only stamps a bcrypt `password_hash`; it does NOT create the user
 * row or a workspace.
 *
 * Usage:
 *   deno run -A --env-file src/set-password.mts <email> <password>
 */
async function main() {
  const [email, password] = process.argv.slice(2);

  if (!email || !password) {
    console.error(
      "Usage: deno run -A --env-file src/set-password.mts <email> <password>",
    );
    process.exit(1);
  }

  if (password.length < 8) {
    console.error("Password must be at least 8 characters long.");
    process.exit(1);
  }

  const db = drizzle(
    createClient({ url: env.DATABASE_URL, authToken: env.DATABASE_AUTH_TOKEN }),
  );

  const existing = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .get();

  if (!existing) {
    console.error(
      `No user found with email "${email}". Sign in once via magic-link/OAuth to create the user, then re-run this script.`,
    );
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 10);

  await db
    .update(user)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(user.id, existing.id))
    .run();

  console.log(`Password set for "${email}" (user id ${existing.id}).`);
  process.exit(0);
}

main().catch((e) => {
  console.error("Failed to set password");
  console.error(e);
  process.exit(1);
});
