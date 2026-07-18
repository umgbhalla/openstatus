import { expect } from "@std/expect";
import { describe, test } from "@std/testing/bdd";

import { resolvePathnamePrefix } from "./resolve-pathname-prefix";

const defaultLocale = "en";

describe("resolvePathnamePrefix", () => {
  describe("hostname routing (subdomain)", () => {
    test("acme.localhost + en → empty (default locale)", () => {
      expect(
        resolvePathnamePrefix({
          hostname: "acme.localhost",
          slug: "acme",
          customDomain: undefined,
          locale: "en",
          defaultLocale,
        }),
      ).toBe("");
    });

    test("acme.localhost + fr → 'fr'", () => {
      expect(
        resolvePathnamePrefix({
          hostname: "acme.localhost",
          slug: "acme",
          customDomain: undefined,
          locale: "fr",
          defaultLocale,
        }),
      ).toBe("fr");
    });

    test("acme.stpg.dev + fr → 'fr'", () => {
      expect(
        resolvePathnamePrefix({
          hostname: "acme.stpg.dev",
          slug: "acme",
          customDomain: undefined,
          locale: "fr",
          defaultLocale,
        }),
      ).toBe("fr");
    });
  });

  describe("custom domain routing", () => {
    test("status.acme.com + en → empty (default locale)", () => {
      expect(
        resolvePathnamePrefix({
          hostname: "status.acme.com",
          slug: "acme",
          customDomain: "status.acme.com",
          locale: "en",
          defaultLocale,
        }),
      ).toBe("");
    });

    test("status.acme.com + fr → 'fr'", () => {
      expect(
        resolvePathnamePrefix({
          hostname: "status.acme.com",
          slug: "acme",
          customDomain: "status.acme.com",
          locale: "fr",
          defaultLocale,
        }),
      ).toBe("fr");
    });
  });

  describe("pathname routing", () => {
    test("localhost + acme + en → 'acme/en'", () => {
      expect(
        resolvePathnamePrefix({
          hostname: "localhost",
          slug: "acme",
          customDomain: undefined,
          locale: "en",
          defaultLocale,
        }),
      ).toBe("acme/en");
    });

    test("localhost + acme + fr → 'acme/fr'", () => {
      expect(
        resolvePathnamePrefix({
          hostname: "localhost",
          slug: "acme",
          customDomain: undefined,
          locale: "fr",
          defaultLocale,
        }),
      ).toBe("acme/fr");
    });
  });

  describe("self-host + managed deployment (path-based routing)", () => {
    // Regression: the modal host has 4 labels and was misclassified as a
    // subdomain, dropping the slug from nav links (→ /status/events 404).
    test("*.modal.direct keeps the slug (pathname routing)", () => {
      expect(
        resolvePathnamePrefix({
          hostname: "umgbhalla--openstatus-gateway.us-east.modal.direct",
          slug: "harp",
          customDomain: undefined,
          locale: "en",
          defaultLocale,
        }),
      ).toBe("harp/en");
    });

    test("*.modal.run keeps the slug (pathname routing)", () => {
      expect(
        resolvePathnamePrefix({
          hostname: "umgbhalla--openstatus-gateway.modal.run",
          slug: "harp",
          customDomain: undefined,
          locale: "en",
          defaultLocale,
        }),
      ).toBe("harp/en");
    });

    test("isSelfHost forces pathname routing even on a multi-label host", () => {
      expect(
        resolvePathnamePrefix({
          hostname: "status.acme.com",
          slug: "harp",
          customDomain: undefined,
          locale: "en",
          defaultLocale,
          isSelfHost: true,
        }),
      ).toBe("harp/en");
    });

    test("isSelfHost ignores customDomain (always path-based)", () => {
      expect(
        resolvePathnamePrefix({
          hostname: "status.acme.com",
          slug: "harp",
          customDomain: "status.acme.com",
          locale: "en",
          defaultLocale,
          isSelfHost: true,
        }),
      ).toBe("harp/en");
    });
  });

  describe("edge cases", () => {
    test("www subdomain is treated as pathname routing", () => {
      expect(
        resolvePathnamePrefix({
          hostname: "www.openstatus.dev",
          slug: "acme",
          customDomain: undefined,
          locale: "en",
          defaultLocale,
        }),
      ).toBe("acme/en");
    });

    test("vercel.app preview is treated as pathname routing", () => {
      expect(
        resolvePathnamePrefix({
          hostname: "my-app.vercel.app",
          slug: "acme",
          customDomain: undefined,
          locale: "fr",
          defaultLocale,
        }),
      ).toBe("acme/fr");
    });

    test("no custom domain match falls through to hostname check", () => {
      // hostname has 3+ segments but customDomain doesn't match
      expect(
        resolvePathnamePrefix({
          hostname: "acme.openstatus.dev",
          slug: "acme",
          customDomain: "other.domain.com",
          locale: "fr",
          defaultLocale,
        }),
      ).toBe("fr");
    });
  });
});
