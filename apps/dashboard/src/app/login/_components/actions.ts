"use server";

import { AuthError } from "next-auth";

import { signIn } from "@/lib/auth";

export async function signInWithResendAction(formData: FormData) {
  try {
    await signIn("resend", formData);
  } catch (e) {
    console.error(e);
  }
}

/**
 * Self-host only (SELF_HOST=true): sign in with email + password via the
 * Credentials provider. Returns an error message on invalid credentials; a
 * successful sign-in throws a redirect that must propagate.
 */
export async function signInWithCredentialsAction(
  formData: FormData,
): Promise<{ error: string } | undefined> {
  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirectTo: (formData.get("redirectTo") as string) || "/",
    });
  } catch (e) {
    // Invalid credentials surface as an AuthError (CredentialsSignin); every
    // other throw (notably the Next.js redirect on success) must propagate.
    if (e instanceof AuthError) {
      return { error: "Invalid email or password." };
    }
    throw e;
  }
}
