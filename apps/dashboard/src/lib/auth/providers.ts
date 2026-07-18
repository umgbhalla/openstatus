import { verifyUserPassword } from "@openstatus/db/src/utils/password";
import Credentials from "next-auth/providers/credentials";
import GitHub from "next-auth/providers/github";
import Google from "next-auth/providers/google";
import Resend from "next-auth/providers/resend";

export const GitHubProvider = GitHub({
  allowDangerousEmailAccountLinking: true,
});

export const GoogleProvider = Google({
  allowDangerousEmailAccountLinking: true,
  authorization: {
    params: {
      // See https://openid.net/specs/openid-connect-core-1_0.html#AuthRequest
      prompt: "select_account",
      // scope:
      //   "https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email",
    },
  },
});

export const ResendProvider = Resend({
  apiKey: undefined, // REMINDER: keep undefined to avoid sending emails
  async sendVerificationRequest(params) {
    console.log("");
    console.log(`>>> Magic Link: ${params.url}`);
    console.log("");
  },
});

/**
 * Email + password login for self-hosted deployments only (SELF_HOST=true).
 * The user row must already exist (created via magic-link/OAuth first) and have
 * a bcrypt `password_hash` set via `packages/db/src/set-password.mts`.
 */
export const CredentialsProvider = Credentials({
  id: "credentials",
  name: "Email and password",
  credentials: {
    email: { label: "Email", type: "email" },
    password: { label: "Password", type: "password" },
  },
  async authorize(credentials) {
    const email =
      typeof credentials?.email === "string" ? credentials.email : "";
    const password =
      typeof credentials?.password === "string" ? credentials.password : "";
    if (!email || !password) return null;

    const row = await verifyUserPassword(email, password);
    if (!row) return null;

    // Return the full user row (matches the augmented next-auth `User` shape),
    // with the numeric id coerced to the string next-auth expects.
    return { ...row, id: row.id.toString(), email: row.email || "" };
  },
});
