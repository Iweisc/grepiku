import path from "path";

const SAFE_ENV_TEMPLATE_BASENAMES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template"
]);

const SENSITIVE_BASENAMES = new Set([
  ".git",
  ".gitconfig",
  ".env",
  ".htpasswd",
  ".git-credentials",
  "credentials.json",
  "kubeconfig",
  ".pgpass",
  ".my.cnf",
  ".mylogin.cnf",
  ".npmrc",
  ".pnpmrc",
  ".pypirc",
  ".boto",
  ".s3cfg",
  "pip.conf",
  "pip.ini",
  ".sentryclirc",
  ".netrc",
  ".dockercfg",
  ".terraformrc",
  ".yarnrc",
  ".yarnrc.yml",
  "gradle.properties",
  "settings.xml",
  "application_default_credentials.json",
  "credentials.tfrc.json",
  "nuget.config",
  "settings-security.xml",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_ecdsa_sk",
  "id_ed25519_sk",
  "authorized_keys"
]);

const SENSITIVE_SUFFIXES = [
  ".tfstate",
  ".tfstate.backup",
  ".tfvars",
  ".tfvars.json"
];

const SENSITIVE_EXTENSIONS = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".p8",
  ".pk8",
  ".ppk",
  ".crt",
  ".cer",
  ".der",
  ".jks",
  ".jceks",
  ".keystore",
  ".kdbx",
  ".asc",
  ".gpg",
  ".ovpn",
  ".kubeconfig"
]);

const SENSITIVE_DIRECTORY_SEGMENTS = new Set([
  ".azure",
  ".aws",
  ".gradle",
  ".bundle",
  ".cargo",
  ".composer",
  ".m2",
  ".gem",
  ".docker",
  ".kube",
  ".nuget",
  ".oci",
  ".terraform",
  ".ssh",
  ".gnupg"
]);

const SENSITIVE_SEARCH_GLOBS = [
  "!**/.env",
  "!**/.env.*",
  "!**/.envrc",
  "!**/.envrc.*",
  "!auth.json",
  "!**/*.tfstate",
  "!**/*.tfstate.backup",
  "!**/*.tfvars",
  "!**/*.tfvars.json",
  "!**/*.pem",
  "!**/*.key",
  "!**/*.p12",
  "!**/*.pfx",
  "!**/*.p8",
  "!**/*.pk8",
  "!**/*.ppk",
  "!**/*.crt",
  "!**/*.cer",
  "!**/*.der",
  "!**/*.jks",
  "!**/*.jceks",
  "!**/*.keystore",
  "!**/*.kdbx",
  "!**/*.asc",
  "!**/*.gpg",
  "!**/*.ovpn",
  "!**/*.kubeconfig",
  "!**/.aws/**",
  "!**/.azure/**",
  "!**/.bundle/**",
  "!**/.cargo/**",
  "!**/.composer/**",
  "!**/.dbt/profiles.yml",
  "!**/.docker/**",
  "!**/.gem/**",
  "!**/.gnupg/**",
  "!**/.gradle/**",
  "!**/.kube/**",
  "!**/.m2/**",
  "!**/.nuget/**",
  "!**/.oci/**",
  "!**/.pulumi/credentials.json",
  "!**/.pypoetry/auth.toml",
  "!**/.config/composer/auth.json",
  "!**/.config/gcloud/**",
  "!**/.config/gh/hosts.yml",
  "!**/.config/pypoetry/auth.toml",
  "!**/.ssh/**",
  "!**/.terraform/**"
];

export function shouldBlockSensitiveRepoPath(relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/").toLowerCase();
  const base = path.posix.basename(normalized);
  if (!normalized) return false;
  if (SAFE_ENV_TEMPLATE_BASENAMES.has(base)) {
    return false;
  }
  if (normalized === "auth.json") {
    return true;
  }
  if (base === ".env" || base.startsWith(".env.")) {
    return true;
  }
  if (base === ".envrc" || base.startsWith(".envrc.")) {
    return true;
  }
  if (SENSITIVE_BASENAMES.has(base)) {
    return true;
  }
  if (SENSITIVE_SUFFIXES.some((suffix) => base.endsWith(suffix))) {
    return true;
  }
  if (SENSITIVE_EXTENSIONS.has(path.posix.extname(base))) {
    return true;
  }

  const segments = normalized.split("/").filter(Boolean);
  if (
    base === "auth.toml" &&
    segments.some((segment) => segment === ".pypoetry" || segment === "pypoetry")
  ) {
    return true;
  }
  if (
    base === "auth.json" &&
    segments.some((segment, index) => segment === "composer" && segments[index - 1] === ".config")
  ) {
    return true;
  }
  if (
    base === "credentials.json" &&
    segments.some((segment) => segment === ".pulumi")
  ) {
    return true;
  }
  if (
    base === "hosts.yml" &&
    segments.some((segment, index) => segment === "gh" && segments[index - 1] === ".config")
  ) {
    return true;
  }
  if (
    segments.some((segment, index) => segment === "gcloud" && segments[index - 1] === ".config")
  ) {
    return true;
  }
  if (
    base === "profiles.yml" &&
    segments.some((segment) => segment === ".dbt")
  ) {
    return true;
  }
  return segments.some((segment) => SENSITIVE_DIRECTORY_SEGMENTS.has(segment));
}

export function buildSensitiveReadonlySearchGlobs() {
  return [...SENSITIVE_SEARCH_GLOBS];
}
