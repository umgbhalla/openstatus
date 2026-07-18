import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";

import { db } from "../db";
import { user } from "../schema";
import type { User } from "../schema";

/**
 * Hash a plaintext password for the self-host email+password login.
 * Mirrors the cost factor used for API-key hashing.
 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

/**
 * Verify an email + password pair for the self-host credentials login.
 *
 * Looks the user up by email and bcrypt-compares against the stored
 * `password_hash`. Returns the full user row on success, or `null` when the
 * user is missing, has no password set, or the password does not match.
 * bcryptjs lives in this package, so callers (e.g. the dashboard) never take a
 * direct bcrypt dependency.
 */
export async function verifyUserPassword(
  email: string,
  password: string,
): Promise<User | null> {
  if (!email || !password) return null;

  const row = await db.select().from(user).where(eq(user.email, email)).get();

  if (!row?.passwordHash) return null;

  const ok = await bcrypt.compare(password, row.passwordHash);
  if (!ok) return null;

  return row;
}
