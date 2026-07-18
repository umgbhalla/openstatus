/**
 * Computes the prefix used for client-side navigation links.
 *
 * - Hostname routing (subdomain / custom domain): locale only (empty for default)
 * - Pathname routing: always `{slug}/{locale}`
 *
 * The `slug` is the `[domain]` route param, NOT parsed from the pathname: under
 * path-based routing a `basePath` (e.g. `/status`) prefixes `location.pathname`,
 * so `pathname.split("/")[1]` would resolve to the basePath segment, not the
 * page slug. Self-host + managed deployment hosts (`*.modal.run`,
 * `*.modal.direct`) always use path-based routing — mirror the server-side
 * `resolveRoute` classification so nav links keep the slug.
 */
export function resolvePathnamePrefix({
  hostname,
  slug,
  customDomain,
  locale,
  defaultLocale,
  isSelfHost = false,
}: {
  hostname: string;
  /** The `[domain]` route param (the page slug). */
  slug: string;
  customDomain: string | undefined;
  locale: string;
  defaultLocale: string;
  isSelfHost?: boolean;
}): string {
  const hostnames = hostname.split(".");
  const isCustomDomain =
    !isSelfHost && !!customDomain && hostname === customDomain;

  // acme.localhost → ["acme", "localhost"] (length 2, but is a subdomain)
  // acme.stpg.dev → ["acme", "stpg", "dev"] (length 3+)
  // localhost → ["localhost"] (length 1, pathname routing)
  const hasLocalhostSubdomain =
    hostnames.length === 2 && /^localhost(:\d+)?$/.test(hostnames[1]);
  const isSubdomain =
    !isSelfHost &&
    (hostnames.length > 2 || hasLocalhostSubdomain) &&
    hostnames[0] !== "www" &&
    !hostname.endsWith(".vercel.app") &&
    !hostname.endsWith(".modal.run") &&
    !hostname.endsWith(".modal.direct");

  if (isCustomDomain || isSubdomain) {
    // Subdomain or custom domain — the slug lives in the host, not the path
    return locale !== defaultLocale ? locale : "";
  }

  // Pathname routing — always {slug}/{locale}
  return `${slug}/${locale}`;
}
