use crate::protocol::SandboxPolicy;
use codex_network_proxy::NetworkProxy;
use std::path::Path;
use std::path::PathBuf;

pub const MACOS_PATH_TO_SEATBELT_EXECUTABLE: &str = "/usr/bin/sandbox-exec";

pub fn create_seatbelt_command_args(
    command: Vec<String>,
    _policy: &SandboxPolicy,
    _sandbox_policy_cwd: &Path,
    _enforce_managed_network: bool,
    _network: Option<&NetworkProxy>,
    _allowed_unix_sockets: &[PathBuf],
) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        "(version 1)".to_string(),
        "--".to_string(),
    ];
    args.extend(command);
    args
}
