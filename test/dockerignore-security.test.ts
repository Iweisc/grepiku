import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

function dockerignoreLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

test("docker build context excludes local secret files while keeping safe env templates", async () => {
  const raw = await fs.readFile(new URL("../.dockerignore", import.meta.url), "utf8");
  const lines = dockerignoreLines(raw);

  assert.ok(lines.includes(".env"), "Expected .dockerignore to exclude .env");
  assert.ok(lines.includes(".env.*"), "Expected .dockerignore to exclude .env.*");
  assert.ok(lines.includes("!.env.example"), "Expected .dockerignore to keep .env.example");
  assert.ok(lines.includes(".envrc"), "Expected .dockerignore to exclude .envrc");
  assert.ok(lines.includes(".envrc.*"), "Expected .dockerignore to exclude .envrc.*");
  assert.ok(lines.includes(".npmrc"), "Expected .dockerignore to exclude .npmrc");
  assert.ok(lines.includes(".pnpmrc"), "Expected .dockerignore to exclude .pnpmrc");
  assert.ok(lines.includes(".netrc"), "Expected .dockerignore to exclude .netrc");
  assert.ok(lines.includes(".docker"), "Expected .dockerignore to exclude .docker");
  assert.ok(lines.includes(".kube"), "Expected .dockerignore to exclude .kube");
  assert.ok(lines.includes(".aws"), "Expected .dockerignore to exclude .aws");
  assert.ok(lines.includes(".ssh"), "Expected .dockerignore to exclude .ssh");
  assert.ok(lines.includes(".bundle"), "Expected .dockerignore to exclude .bundle");
  assert.ok(lines.includes(".cargo"), "Expected .dockerignore to exclude .cargo");
  assert.ok(lines.includes(".composer"), "Expected .dockerignore to exclude .composer");
  assert.ok(lines.includes(".gem"), "Expected .dockerignore to exclude .gem");
  assert.ok(lines.includes(".gradle"), "Expected .dockerignore to exclude .gradle");
  assert.ok(lines.includes(".m2"), "Expected .dockerignore to exclude .m2");
  assert.ok(lines.includes(".nuget"), "Expected .dockerignore to exclude .nuget");
  assert.ok(lines.includes(".terraform"), "Expected .dockerignore to exclude .terraform");
  assert.ok(lines.includes(".terraformrc"), "Expected .dockerignore to exclude .terraformrc");
  assert.ok(lines.includes(".pgpass"), "Expected .dockerignore to exclude .pgpass");
  assert.ok(lines.includes(".my.cnf"), "Expected .dockerignore to exclude .my.cnf");
  assert.ok(lines.includes(".mylogin.cnf"), "Expected .dockerignore to exclude .mylogin.cnf");
  assert.ok(lines.includes(".sentryclirc"), "Expected .dockerignore to exclude .sentryclirc");
  assert.ok(lines.includes("auth.json"), "Expected .dockerignore to exclude root auth.json");
  assert.ok(
    lines.includes(".config/composer"),
    "Expected .dockerignore to exclude Composer XDG config"
  );
});

test("docker build context excludes standalone credential files and private key formats", async () => {
  const raw = await fs.readFile(new URL("../.dockerignore", import.meta.url), "utf8");
  const lines = dockerignoreLines(raw);

  const sensitiveBasenames = [
    ".htpasswd",
    "credentials.json",
    "kubeconfig",
    ".boto",
    ".s3cfg",
    "pip.conf",
    "pip.ini",
    "gradle.properties",
    "settings.xml",
    "application_default_credentials.json",
    "nuget.config",
    "settings-security.xml",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "id_ecdsa_sk",
    "id_ed25519_sk",
    "authorized_keys"
  ];
  const sensitiveExtensionGlobs = [
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "*.p8",
    "*.pk8",
    "*.ppk",
    "*.crt",
    "*.cer",
    "*.der",
    "*.jks",
    "*.jceks",
    "*.keystore",
    "*.kdbx",
    "*.asc",
    "*.gpg",
    "*.ovpn",
    "*.kubeconfig"
  ];
  const sensitiveSuffixGlobs = [
    "*.tfstate",
    "*.tfstate.backup",
    "*.tfvars",
    "*.tfvars.json"
  ];

  for (const entry of sensitiveBasenames) {
    assert.ok(lines.includes(entry), `Expected .dockerignore to exclude ${entry}`);
  }
  for (const entry of sensitiveExtensionGlobs) {
    assert.ok(lines.includes(entry), `Expected .dockerignore to exclude ${entry}`);
  }
  for (const entry of sensitiveSuffixGlobs) {
    assert.ok(lines.includes(entry), `Expected .dockerignore to exclude ${entry}`);
  }
});
