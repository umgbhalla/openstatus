/**
 * Self-host-aware public URL builders.
 *
 * The hosted product serves each status page on its own subdomain
 * (`<slug>.openstatus.dev`); a self-host serves EVERY page from one origin by
 * path (`<base><basePath>/<slug>`). Historically ~40 call sites hand-rolled
 * `https://${slug}.openstatus.dev`, producing dead links on any self-host.
 * Route all public-URL construction through here.
 *
 * Env (all optional; sane self-host defaults):
 * - NEXT_PUBLIC_STATUS_PAGE_URL — status-page origin. Falls back to
 *   NEXT_PUBLIC_URL (correct when one reverse proxy serves dashboard + status
 *   page on ONE origin, path-routed — the Modal single-container deploy).
 * - NEXT_PUBLIC_STATUS_PAGE_PATH — status-page basePath (default "/status").
 * - NEXT_PUBLIC_DASHBOARD_URL / NEXT_PUBLIC_URL — dashboard origin.
 * - NEXT_PUBLIC_API_URL — integration/server origin.
 * NEXT_PUBLIC_* so the values are inlined into client bundles too.
 */

const stripTrailingSlash = (s: string) => s.replace(/\/+$/, "");
const isSelfHost = () => process.env.SELF_HOST === "true";

/** Public URL of a status page (or a sub-path of it, e.g. /verify/<token>). */
export function getStatusPageUrl({
  slug,
  customDomain,
  path = "",
}: {
  slug?: string | null;
  customDomain?: string | null;
  path?: string;
}): string {
  if (customDomain) return `https://${customDomain}${path}`;
  const prefix = process.env.NEXT_PUBLIC_STATUS_PAGE_PATH ?? "/status";
  // Explicit separate status-page origin (multi-origin deploys) wins.
  const explicit = stripTrailingSlash(
    process.env.NEXT_PUBLIC_STATUS_PAGE_URL || "",
  );
  if (explicit) return `${explicit}${prefix}/${slug}${path}`;
  // Default (this self-host fork, single origin): RELATIVE URL. Any env
  // (NEXT_PUBLIC_URL, SELF_HOST) is inlined at BUILD time into client bundles —
  // it carries the build default (e.g. localhost:8100), NOT the runtime deploy
  // origin — so it cannot be trusted client-side. A relative href/src/window.open
  // resolves against the CURRENT origin, always the real public URL.
  return `${prefix}/${slug}${path}`;
}

/** Status-page badge image URL. */
export function getBadgeUrl(args: {
  slug?: string | null;
  customDomain?: string | null;
}): string {
  return getStatusPageUrl({ ...args, path: "/badge/v2" });
}

/** Dashboard (app) URL for a path like "/invite". */
export function getDashboardUrl(path = ""): string {
  const base = stripTrailingSlash(
    process.env.NEXT_PUBLIC_DASHBOARD_URL ||
      process.env.NEXT_PUBLIC_URL ||
      (isSelfHost() ? "" : "https://app.openstatus.dev"),
  );
  return `${base}${path}`;
}

/** Integration/server API URL for a path. */
export function getApiUrl(path = ""): string {
  const base = stripTrailingSlash(
    process.env.NEXT_PUBLIC_API_URL ||
      (isSelfHost()
        ? process.env.NEXT_PUBLIC_URL || ""
        : process.env.NODE_ENV === "production"
          ? "https://api.openstatus.dev"
          : "http://localhost:3000"),
  );
  return `${base}${path}`;
}
