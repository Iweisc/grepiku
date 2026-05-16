import test from "node:test";
import assert from "node:assert/strict";
import { shouldSkipSensitivePath } from "../src/services/indexerPathPolicy.js";

test("indexer skips common secret-bearing env and key files", async () => {
  assert.equal(shouldSkipSensitivePath(".git"), true);
  assert.equal(shouldSkipSensitivePath(".env"), true);
  assert.equal(shouldSkipSensitivePath("config/.env.production"), true);
  assert.equal(shouldSkipSensitivePath("keys/id_rsa"), true);
  assert.equal(shouldSkipSensitivePath("certs/deploy.pem"), true);
  assert.equal(shouldSkipSensitivePath(".kube/config"), true);
  assert.equal(shouldSkipSensitivePath(".docker/config.json"), true);
});

test("indexer skips terraform state and package-manager credential files", async () => {
  assert.equal(shouldSkipSensitivePath("infra/prod.tfstate"), true);
  assert.equal(shouldSkipSensitivePath("infra/prod.tfstate.backup"), true);
  assert.equal(shouldSkipSensitivePath("env/prod.auto.tfvars"), true);
  assert.equal(shouldSkipSensitivePath("env/prod.auto.tfvars.json"), true);
  assert.equal(shouldSkipSensitivePath(".terraform/terraform.tfstate"), true);
  assert.equal(shouldSkipSensitivePath(".terraformrc"), true);
  assert.equal(shouldSkipSensitivePath("credentials.tfrc.json"), true);
  assert.equal(shouldSkipSensitivePath(".pnpmrc"), true);
  assert.equal(shouldSkipSensitivePath(".yarnrc"), true);
  assert.equal(shouldSkipSensitivePath(".yarnrc.yml"), true);
});

test("indexer skips registry and cloud credential stores", async () => {
  assert.equal(shouldSkipSensitivePath(".cargo/credentials.toml"), true);
  assert.equal(shouldSkipSensitivePath(".cargo/credentials"), true);
  assert.equal(shouldSkipSensitivePath(".gem/credentials"), true);
  assert.equal(shouldSkipSensitivePath(".azure/accessTokens.json"), true);
  assert.equal(
    shouldSkipSensitivePath(".config/gcloud/application_default_credentials.json"),
    true
  );
  assert.equal(shouldSkipSensitivePath(".config/gcloud/access_tokens.db"), true);
  assert.equal(shouldSkipSensitivePath(".config/gcloud/credentials.db"), true);
  assert.equal(
    shouldSkipSensitivePath(".config/gcloud/configurations/config_default"),
    true
  );
  assert.equal(shouldSkipSensitivePath("clusters/prod.kubeconfig"), true);
  assert.equal(shouldSkipSensitivePath(".htpasswd"), true);
});

test("indexer skips additional private-key and generic credential-store files", async () => {
  assert.equal(shouldSkipSensitivePath("keys/app.p8"), true);
  assert.equal(shouldSkipSensitivePath("android/release.pk8"), true);
  assert.equal(shouldSkipSensitivePath("keys/deploy.ppk"), true);
  assert.equal(shouldSkipSensitivePath("secrets/prod.jceks"), true);
  assert.equal(shouldSkipSensitivePath("android/upload.keystore"), true);
  assert.equal(shouldSkipSensitivePath("credentials.json"), true);
  assert.equal(shouldSkipSensitivePath("ci/settings.xml"), true);
});

test("indexer skips package-manager and build-tool credential stores", async () => {
  assert.equal(shouldSkipSensitivePath(".bundle/config"), true);
  assert.equal(shouldSkipSensitivePath(".composer/auth.json"), true);
  assert.equal(shouldSkipSensitivePath(".m2/settings.xml"), true);
  assert.equal(shouldSkipSensitivePath("nuget.config"), true);
  assert.equal(shouldSkipSensitivePath(".nuget/NuGet.Config"), true);
  assert.equal(shouldSkipSensitivePath(".sentryclirc"), true);
});

test("indexer skips root auth stores and Python package registry credentials", async () => {
  assert.equal(shouldSkipSensitivePath("auth.json"), true);
  assert.equal(shouldSkipSensitivePath("pip.conf"), true);
  assert.equal(shouldSkipSensitivePath("pip.ini"), true);
  assert.equal(shouldSkipSensitivePath(".config/pypoetry/auth.toml"), true);
  assert.equal(shouldSkipSensitivePath(".pypoetry/auth.toml"), true);
  assert.equal(shouldSkipSensitivePath(".config/composer/auth.json"), true);
});

test("indexer skips git and database client credential stores", async () => {
  assert.equal(shouldSkipSensitivePath(".gitconfig"), true);
  assert.equal(shouldSkipSensitivePath(".pgpass"), true);
  assert.equal(shouldSkipSensitivePath(".my.cnf"), true);
  assert.equal(shouldSkipSensitivePath("keys/id_ecdsa_sk"), true);
  assert.equal(shouldSkipSensitivePath("keys/id_ed25519_sk"), true);
});

test("indexer skips additional build and cloud credential stores", async () => {
  assert.equal(shouldSkipSensitivePath("gradle.properties"), true);
  assert.equal(shouldSkipSensitivePath(".gradle/gradle.properties"), true);
  assert.equal(shouldSkipSensitivePath(".mylogin.cnf"), true);
  assert.equal(shouldSkipSensitivePath(".boto"), true);
  assert.equal(shouldSkipSensitivePath(".s3cfg"), true);
  assert.equal(shouldSkipSensitivePath(".oci/config"), true);
});

test("indexer skips additional local credential-store conventions", async () => {
  assert.equal(shouldSkipSensitivePath(".envrc"), true);
  assert.equal(shouldSkipSensitivePath(".envrc.local"), true);
  assert.equal(shouldSkipSensitivePath(".pulumi/credentials.json"), true);
  assert.equal(shouldSkipSensitivePath(".config/gh/hosts.yml"), true);
  assert.equal(shouldSkipSensitivePath(".dbt/profiles.yml"), true);
});

test("indexer still allows safe template env files and source files", async () => {
  assert.equal(shouldSkipSensitivePath(".env.example"), false);
  assert.equal(shouldSkipSensitivePath("src/index.ts"), false);
});
