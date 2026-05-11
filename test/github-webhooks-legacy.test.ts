import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("legacy github webhook helper does not register direct queueing handlers", async () => {
  const script = await fs.readFile(
    new URL("../src/github/webhooks.ts", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(script, /\bwebhooks\.on\s*\(/);
  assert.doesNotMatch(script, /\breviewQueue\b/);
});
