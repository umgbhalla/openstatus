import { expect } from "@std/expect";
import { afterEach, describe, test } from "@std/testing/bdd";

import { applyBasePath, withBasePath } from "./with-base-path";

const KEY = "STATUS_PAGE_BASE_PATH";

afterEach(() => {
  delete process.env[KEY];
});

describe("withBasePath", () => {
  test("no basePath configured: returns pathname unchanged", () => {
    delete process.env[KEY];
    expect(withBasePath("/harp/en")).toBe("/harp/en");
    expect(withBasePath("/")).toBe("/");
  });

  test("empty basePath: returns pathname unchanged", () => {
    process.env[KEY] = "";
    expect(withBasePath("/harp/en")).toBe("/harp/en");
  });

  test("basePath configured: prepends to a basePath-less path", () => {
    process.env[KEY] = "/status";
    expect(withBasePath("/harp/en")).toBe("/status/harp/en");
    expect(withBasePath("/")).toBe("/status/");
  });

  test("idempotent: does not double a path already under basePath", () => {
    process.env[KEY] = "/status";
    expect(withBasePath("/status/harp/en")).toBe("/status/harp/en");
    expect(withBasePath("/status")).toBe("/status");
  });

  test("does not treat a sibling prefix as already-prefixed", () => {
    process.env[KEY] = "/status";
    // "/statuspage" must NOT be seen as already under "/status".
    expect(withBasePath("/statuspage/en")).toBe("/status/statuspage/en");
  });
});

describe("applyBasePath", () => {
  test("rewrites only the pathname, preserving origin/search/hash", () => {
    process.env[KEY] = "/status";
    const url = applyBasePath(
      new URL("http://0.0.0.0:3003/harp/en?foo=bar#top"),
    );
    expect(url.pathname).toBe("/status/harp/en");
    expect(url.origin).toBe("http://0.0.0.0:3003");
    expect(url.search).toBe("?foo=bar");
    expect(url.hash).toBe("#top");
  });

  test("no basePath: URL unchanged", () => {
    delete process.env[KEY];
    const url = applyBasePath(new URL("http://0.0.0.0:3003/harp/en"));
    expect(url.pathname).toBe("/harp/en");
  });
});
