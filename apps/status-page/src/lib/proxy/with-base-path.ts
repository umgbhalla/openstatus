/**
 * basePath-aware path helper for proxy rewrites/redirects.
 *
 * When the status-page app is built with a Next.js `basePath` (self-host behind
 * a subpath, e.g. `STATUS_PAGE_BASE_PATH=/status` served at
 * `https://host/status/...`), the middleware receives `req.nextUrl.pathname`
 * with the basePath ALREADY STRIPPED, and `NextResponse.rewrite()` /
 * `NextResponse.redirect()` do NOT auto-prepend it. So every rewrite/redirect
 * target built here must carry the basePath explicitly:
 *   - internal rewrites must include it so Next can match the route (routes
 *     live under the basePath), otherwise → 404;
 *   - browser redirects must include it so the client lands on the public
 *     `${basePath}/...` URL rather than a basePath-less one that the reverse
 *     proxy won't route.
 *
 * When `STATUS_PAGE_BASE_PATH` is empty (hosted openstatus), this is a no-op and
 * behavior is byte-identical to before.
 *
 * Read at call time (not memoized) so the value is a single source of truth and
 * tests can toggle the env. The env is fixed for a process's lifetime at
 * runtime, so the repeated read is inconsequential.
 *
 * Note: the idempotency guard treats a path already under the basePath as done.
 * A page whose slug equals the basePath segment (e.g. basePath `/status` and a
 * page slug `status`) is an accepted edge — it would collide with this guard.
 */

function getBasePath(): string {
  return process.env.STATUS_PAGE_BASE_PATH ?? "";
}

/**
 * Prepend the configured basePath to a leading-slash pathname, unless empty or
 * the path already sits under the basePath.
 */
export function withBasePath(pathname: string): string {
  const basePath = getBasePath();
  if (!basePath) return pathname;
  if (pathname === basePath || pathname.startsWith(`${basePath}/`)) {
    return pathname;
  }
  return `${basePath}${pathname}`;
}

/**
 * Rewrite a URL's pathname through {@link withBasePath}, preserving origin,
 * search, and hash. Returns the same URL instance for convenience.
 */
export function applyBasePath(url: URL): URL {
  url.pathname = withBasePath(url.pathname);
  return url;
}
