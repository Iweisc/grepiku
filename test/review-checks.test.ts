import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildVerifierErrorChecks,
  readVerifierChecks
} from "../src/review/checks.js";

test("buildVerifierErrorChecks marks all tools as error", () => {
  const checks = buildVerifierErrorChecks({
    headSha: "abc123",
    summary: "verifier failed",
    topErrors: ["boom"]
  });

  assert.equal(checks.head_sha, "abc123");
  assert.deepEqual(checks.checks.lint, {
    status: "error",
    summary: "verifier failed",
    top_errors: ["boom"]
  });
  assert.deepEqual(checks.checks.build, checks.checks.lint);
  assert.deepEqual(checks.checks.test, checks.checks.lint);
});

test("readVerifierChecks falls back to last verifier message", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-review-checks-"));
  const outDir = root;
  try {
    await fs.writeFile(
      path.join(outDir, "last_message_verifier.txt"),
      [
        "Wrote verification results:",
        "",
        "```json",
        JSON.stringify(
          {
            head_sha: "head123",
            checks: {
              lint: { status: "pass", summary: "success", top_errors: [] },
              build: { status: "skipped", summary: "not configured", top_errors: [] },
              test: { status: "fail", summary: "exited with 1", top_errors: ["test failed"] }
            }
          },
          null,
          2
        ),
        "```"
      ].join("\n"),
      "utf8"
    );

    const checks = await readVerifierChecks({
      outDir,
      headSha: "head123"
    });

    assert.equal(checks.checks.lint.status, "pass");
    assert.equal(checks.checks.build.status, "skipped");
    assert.equal(checks.checks.test.status, "fail");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("readVerifierChecks synthesizes error checks when output is missing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "grepiku-review-checks-"));
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  try {
    const checks = await readVerifierChecks({
      outDir: root,
      headSha: "head456",
      stageError: new Error("verifier exited before writing checks")
    });

    assert.equal(checks.head_sha, "head456");
    assert.equal(checks.checks.lint.status, "error");
    assert.match(checks.checks.lint.summary, /verifier stage failed/i);
    assert.match(checks.checks.lint.top_errors[0] || "", /verifier exited before writing checks/i);
    assert.match(String(warnings[0]?.[0] || ""), /using synthesized verifier checks/);
  } finally {
    console.warn = originalWarn;
    await fs.rm(root, { recursive: true, force: true });
  }
});
