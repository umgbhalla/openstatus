import { expect } from "@std/expect";
import { afterEach, describe, test } from "@std/testing/bdd";

import type { ResolvedRoute } from "../resolve-route";
import { resolveDefaultRewrite } from "./resolve-default-rewrite";

const hostnameRoute: ResolvedRoute = {
  type: "hostname",
  prefix: "acme",
  locale: "en",
  localeExplicit: false,
  rewritePath: "/acme/en",
};

const pathnameRoute: ResolvedRoute = {
  type: "pathname",
  prefix: "acme",
  locale: "en",
  localeExplicit: true,
  rewritePath: "/acme/en",
};

describe("resolveDefaultRewrite", () => {
  test("rewritePath matches pathname (non-openstatus host): passes (null)", () => {
    expect(
      resolveDefaultRewrite({
        route: pathnameRoute,
        host: "localhost:3000",
        pathname: "/acme/en",
        search: "",
        requestUrl: "http://localhost:3000/acme/en",
      }),
    ).toBeNull();
  });

  test("rewritePath differs from pathname: rewrite to rewritePath", () => {
    const action = resolveDefaultRewrite({
      route: hostnameRoute,
      host: "acme.localhost:3000",
      pathname: "/",
      search: "",
      requestUrl: "http://acme.localhost:3000/",
    });
    expect(action?.type).toBe("rewrite");
    expect(action?.reason).toBe("default-rewrite");
    expect(action?.url?.pathname).toBe("/acme/en");
  });

  test("openstatus.dev host always rewrites (even if paths match)", () => {
    const action = resolveDefaultRewrite({
      route: pathnameRoute,
      host: "openstatus.dev",
      pathname: "/acme/en",
      search: "",
      requestUrl: "https://openstatus.dev/acme/en",
    });
    expect(action?.reason).toBe("default-rewrite");
    expect(action?.url?.pathname).toBe("/acme/en");
  });

  test("openstatus.dev host rewrites when paths differ", () => {
    const action = resolveDefaultRewrite({
      route: hostnameRoute,
      host: "openstatus.dev",
      pathname: "/",
      search: "",
      requestUrl: "https://openstatus.dev/",
    });
    expect(action?.url?.pathname).toBe("/acme/en");
  });

  test("preserves search params", () => {
    const action = resolveDefaultRewrite({
      route: hostnameRoute,
      host: "acme.localhost:3000",
      pathname: "/",
      search: "?foo=bar",
      requestUrl: "http://acme.localhost:3000/",
    });
    expect(action?.url?.search).toBe("?foo=bar");
  });

  test("null host, paths match: passes (null)", () => {
    expect(
      resolveDefaultRewrite({
        route: pathnameRoute,
        host: null,
        pathname: "/acme/en",
        search: "",
        requestUrl: "http://localhost:3000/acme/en",
      }),
    ).toBeNull();
  });

  test("host with openstatus.dev substring (e.g. docs.openstatus.dev): triggers rewrite", () => {
    const action = resolveDefaultRewrite({
      route: pathnameRoute,
      host: "docs.openstatus.dev",
      pathname: "/acme/en",
      search: "",
      requestUrl: "https://www.openstatus.dev/docs/acme/en",
    });
    expect(action?.reason).toBe("default-rewrite");
  });
});

describe("resolveDefaultRewrite with basePath (self-host subpath)", () => {
  afterEach(() => {
    delete process.env.STATUS_PAGE_BASE_PATH;
  });

  // Regression: `/status/harp` (basePath stripped to `/harp`) must rewrite to
  // `/status/harp/en`, not `/harp/en` — the latter drops the basePath and Next
  // can't match the route → 404.
  test("basePath set + path differs: rewrite target includes basePath", () => {
    process.env.STATUS_PAGE_BASE_PATH = "/status";
    const action = resolveDefaultRewrite({
      route: { ...pathnameRoute, prefix: "harp", rewritePath: "/harp/en" },
      // Next strips basePath from the middleware pathname.
      host: "umgbhalla--openstatus-gateway.us-east.modal.direct",
      pathname: "/harp",
      search: "",
      requestUrl: "http://0.0.0.0:3003/harp",
    });
    expect(action?.type).toBe("rewrite");
    expect(action?.url?.pathname).toBe("/status/harp/en");
  });

  test("basePath set + path matches: passes (null) — /status/harp/en passthrough", () => {
    process.env.STATUS_PAGE_BASE_PATH = "/status";
    const action = resolveDefaultRewrite({
      route: { ...pathnameRoute, prefix: "harp", rewritePath: "/harp/en" },
      host: "umgbhalla--openstatus-gateway.us-east.modal.direct",
      pathname: "/harp/en",
      search: "",
      requestUrl: "http://0.0.0.0:3003/harp/en",
    });
    expect(action).toBeNull();
  });
});
