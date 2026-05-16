import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const projectRoot = process.cwd();

test("package manifests do not include the unused simple-git dependency", async () => {
  const packageJson = JSON.parse(
    await fs.readFile(path.join(projectRoot, "package.json"), "utf8")
  ) as { dependencies?: Record<string, string> };
  const packageLock = JSON.parse(
    await fs.readFile(path.join(projectRoot, "package-lock.json"), "utf8")
  ) as {
    packages?: Record<string, { dependencies?: Record<string, string> }>;
  };
  const pnpmLock = await fs.readFile(path.join(projectRoot, "pnpm-lock.yaml"), "utf8");

  assert.equal(packageJson.dependencies?.["simple-git"], undefined);
  assert.equal(packageLock.packages?.[""]?.dependencies?.["simple-git"], undefined);
  assert.doesNotMatch(packageLockTextWithoutWhitespace(packageLock), /"node_modules\/simple-git"/);
  assert.doesNotMatch(pnpmLock, /\n\s+simple-git:/);
  assert.doesNotMatch(pnpmLock, /\nsimple-git@/);
});

test("Docker builds install dependencies from the tracked npm lockfile", async () => {
  const dockerfile = await fs.readFile(path.join(projectRoot, "Dockerfile"), "utf8");

  assert.match(dockerfile, /COPY package\.json package-lock\.json \.\//);
  assert.match(dockerfile, /\bnpm ci\b/);
  assert.doesNotMatch(dockerfile, /\bnpm install\b/);
});

function packageLockTextWithoutWhitespace(value: unknown): string {
  return JSON.stringify(value);
}
