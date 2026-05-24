use codex_utils_absolute_path::AbsolutePathBuf;
use std::fs;
use std::path::Path;
use std::path::PathBuf;

use thiserror::Error;

const SYSTEM_SKILLS_DIR_NAME: &str = ".system";
const SKILLS_DIR_NAME: &str = "skills";
const SYSTEM_SKILLS_MARKER_FILENAME: &str = ".codex-system-skills.marker";
const EMPTY_SYSTEM_SKILLS_MARKER: &str = "empty-v1";

/// Returns the on-disk cache location for embedded system skills.
///
/// This is typically located at `CODEX_HOME/skills/.system`.
pub fn system_cache_root_dir(codex_home: &Path) -> PathBuf {
    AbsolutePathBuf::try_from(codex_home)
        .and_then(|codex_home| system_cache_root_dir_abs(&codex_home))
        .map(AbsolutePathBuf::into_path_buf)
        .unwrap_or_else(|_| {
            codex_home
                .join(SKILLS_DIR_NAME)
                .join(SYSTEM_SKILLS_DIR_NAME)
        })
}

fn system_cache_root_dir_abs(codex_home: &AbsolutePathBuf) -> std::io::Result<AbsolutePathBuf> {
    codex_home
        .join(SKILLS_DIR_NAME)?
        .join(SYSTEM_SKILLS_DIR_NAME)
}

/// Prepares `CODEX_HOME/skills/.system` for system skills.
///
/// The slim harness does not bundle sample system skills. This keeps the cache
/// location and marker behavior stable while ensuring any older embedded samples
/// are removed.
pub fn install_system_skills(codex_home: &Path) -> Result<(), SystemSkillsError> {
    let codex_home = AbsolutePathBuf::try_from(codex_home)
        .map_err(|source| SystemSkillsError::io("normalize codex home dir", source))?;
    let skills_root_dir = codex_home
        .join(SKILLS_DIR_NAME)
        .map_err(|source| SystemSkillsError::io("resolve skills root dir", source))?;
    fs::create_dir_all(skills_root_dir.as_path())
        .map_err(|source| SystemSkillsError::io("create skills root dir", source))?;

    let dest_system = system_cache_root_dir_abs(&codex_home)
        .map_err(|source| SystemSkillsError::io("resolve system skills cache root dir", source))?;
    let marker_path = dest_system
        .join(SYSTEM_SKILLS_MARKER_FILENAME)
        .map_err(|source| SystemSkillsError::io("resolve system skills marker path", source))?;

    if dest_system.as_path().is_dir()
        && read_marker(&marker_path).is_ok_and(|marker| marker == EMPTY_SYSTEM_SKILLS_MARKER)
    {
        return Ok(());
    }

    if dest_system.as_path().exists() {
        fs::remove_dir_all(dest_system.as_path())
            .map_err(|source| SystemSkillsError::io("remove existing system skills dir", source))?;
    }
    fs::create_dir_all(dest_system.as_path())
        .map_err(|source| SystemSkillsError::io("create system skills dir", source))?;
    fs::write(
        marker_path.as_path(),
        format!("{EMPTY_SYSTEM_SKILLS_MARKER}\n"),
    )
    .map_err(|source| SystemSkillsError::io("write system skills marker", source))?;
    Ok(())
}

fn read_marker(path: &AbsolutePathBuf) -> Result<String, SystemSkillsError> {
    Ok(fs::read_to_string(path.as_path())
        .map_err(|source| SystemSkillsError::io("read system skills marker", source))?
        .trim()
        .to_string())
}

#[derive(Debug, Error)]
pub enum SystemSkillsError {
    #[error("io error while {action}: {source}")]
    Io {
        action: &'static str,
        #[source]
        source: std::io::Error,
    },
}

impl SystemSkillsError {
    fn io(action: &'static str, source: std::io::Error) -> Self {
        Self::Io { action, source }
    }
}
