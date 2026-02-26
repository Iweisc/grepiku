import assert from "node:assert/strict";
import test from "node:test";
import { selectSameShaWorktreesForCleanup } from "../src/providers/repoCheckout.js";

test("selectSameShaWorktreesForCleanup prunes stale entries while keeping recent ones", () => {
  const now = 1_000_000;
  const candidates = [
    { path: "/wt/newest", mtimeMs: now - 60_000, registered: true },
    { path: "/wt/newer", mtimeMs: now - 120_000, registered: true },
    { path: "/wt/stale-1", mtimeMs: now - 7 * 60 * 60 * 1000, registered: true },
    { path: "/wt/stale-2", mtimeMs: now - 8 * 60 * 60 * 1000, registered: false },
    { path: "/wt/stale-3", mtimeMs: now - 9 * 60 * 60 * 1000, registered: true }
  ];

  const stale = selectSameShaWorktreesForCleanup({
    candidates,
    nowMs: now,
    ttlMs: 6 * 60 * 60 * 1000,
    keepRecent: 2
  });

  assert.deepEqual(
    stale.map((item) => item.path),
    ["/wt/stale-3", "/wt/stale-2", "/wt/stale-1"]
  );
});

test("selectSameShaWorktreesForCleanup returns empty when no entry is stale", () => {
  const now = 2_000_000;
  const candidates = [
    { path: "/wt/a", mtimeMs: now - 30_000, registered: true },
    { path: "/wt/b", mtimeMs: now - 60_000, registered: true },
    { path: "/wt/c", mtimeMs: now - 90_000, registered: false }
  ];

  const stale = selectSameShaWorktreesForCleanup({
    candidates,
    nowMs: now,
    ttlMs: 6 * 60 * 60 * 1000,
    keepRecent: 2
  });

  assert.deepEqual(stale, []);
});
