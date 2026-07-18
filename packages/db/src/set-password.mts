import { createClient } from "@libsql/client";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";

import { env } from "../env.mjs";
import { user, usersToWorkspaces, workspace } from "./schema";

/**
 * Create (or reset) an email+password credential for the self-host login
 * (SELF_HOST=true). With no email/OAuth provider configured this is the only
 * way to bootstrap the first admin, so it creates the user + a workspace when
 * the email does not yet exist.
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

  const passwordHash = await bcrypt.hash(password, 10);

  let existing = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .get();

  if (!existing) {
    const newUser = await db
      .insert(user)
      .values({ email })
      .returning({ id: user.id })
      .get();

    let slug = `workspace-${Date.now().toString(36)}`;
    for (let i = 0; ; i++) {
      const candidate = i === 0 ? slug : `${slug}-${i}`;
      const clash = await db
        .select({ id: workspace.id })
        .from(workspace)
        .where(eq(workspace.slug, candidate))
        .get();
      if (!clash) {
        slug = candidate;
        break;
      }
    }

    const newWorkspace = await db
      .insert(workspace)
      .values({ slug, name: "" })
      .returning({ id: workspace.id })
      .get();

    await db
      .insert(usersToWorkspaces)
      .values({
        userId: newUser.id,
        workspaceId: newWorkspace.id,
        role: "owner",
      })
      .run();

    existing = newUser;
    console.log(`Created user + workspace for "${email}".`);
  }

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
