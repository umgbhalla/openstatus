"use client";

import { Input } from "@openstatus/ui/components/ui/input";
import { Label } from "@openstatus/ui/components/ui/label";
import { useFormStatus } from "react-dom";
import { toast } from "sonner";

import { signInWithCredentialsAction } from "./actions";
import { LoginButton } from "./login-button";

/**
 * Email + password sign-in, rendered only in self-host mode (SELF_HOST=true).
 * The user must already exist and have a password set via
 * `packages/db/src/set-password.mts`.
 */
export default function PasswordLoginForm({
  redirectTo,
}: {
  redirectTo?: string;
}) {
  const { pending } = useFormStatus();

  return (
    <form
      action={async (formData) => {
        try {
          const result = await signInWithCredentialsAction(formData);
          if (result?.error) {
            toast.error(result.error);
          }
        } catch (e) {
          // A successful sign-in throws a redirect, which Next.js handles;
          // only log genuinely unexpected failures.
          if (e instanceof Error && e.message.includes("NEXT_REDIRECT")) {
            throw e;
          }
          console.error(e);
          toast.error("Something went wrong. Please try again.");
        }
      }}
      className="grid gap-2"
    >
      {redirectTo ? (
        <input type="hidden" name="redirectTo" value={redirectTo} />
      ) : null}
      <div className="grid gap-1.5">
        <Label htmlFor="credentials-email">Email</Label>
        <Input
          id="credentials-email"
          name="email"
          type="email"
          autoComplete="email"
          required
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="credentials-password">Password</Label>
        <Input
          id="credentials-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>
      <LoginButton provider="email" type="submit">
        {pending ? "Signing in..." : "Sign in with password"}
      </LoginButton>
    </form>
  );
}
