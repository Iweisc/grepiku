use crate::config::Config;
use crate::config::ConfigToml;
use crate::config::profile::ConfigProfile;
use crate::config::types::WindowsSandboxModeToml;
use crate::features::Feature;
use crate::features::Features;
use crate::features::FeaturesToml;
use codex_protocol::config_types::WindowsSandboxLevel;
use std::collections::BTreeMap;

/// Keep legacy toggle wiring intact even in Linux-only builds.
pub const ELEVATED_SANDBOX_NUX_ENABLED: bool = true;

pub trait WindowsSandboxLevelExt {
    fn from_config(config: &Config) -> WindowsSandboxLevel;
    fn from_features(features: &Features) -> WindowsSandboxLevel;
}

impl WindowsSandboxLevelExt for WindowsSandboxLevel {
    fn from_config(config: &Config) -> WindowsSandboxLevel {
        match config.permissions.windows_sandbox_mode {
            Some(WindowsSandboxModeToml::Elevated) => WindowsSandboxLevel::Elevated,
            Some(WindowsSandboxModeToml::Unelevated) => WindowsSandboxLevel::RestrictedToken,
            None => Self::from_features(&config.features),
        }
    }

    fn from_features(features: &Features) -> WindowsSandboxLevel {
        if features.enabled(Feature::WindowsSandboxElevated) {
            return WindowsSandboxLevel::Elevated;
        }
        if features.enabled(Feature::WindowsSandbox) {
            WindowsSandboxLevel::RestrictedToken
        } else {
            WindowsSandboxLevel::Disabled
        }
    }
}

pub fn windows_sandbox_level_from_config(config: &Config) -> WindowsSandboxLevel {
    WindowsSandboxLevel::from_config(config)
}

pub fn windows_sandbox_level_from_features(features: &Features) -> WindowsSandboxLevel {
    WindowsSandboxLevel::from_features(features)
}

pub fn resolve_windows_sandbox_mode(
    cfg: &ConfigToml,
    profile: &ConfigProfile,
) -> Option<WindowsSandboxModeToml> {
    if let Some(mode) = legacy_windows_sandbox_mode(profile.features.as_ref()) {
        return Some(mode);
    }
    if legacy_windows_sandbox_keys_present(profile.features.as_ref()) {
        return None;
    }

    profile
        .windows
        .as_ref()
        .and_then(|windows| windows.sandbox)
        .or_else(|| cfg.windows.as_ref().and_then(|windows| windows.sandbox))
        .or_else(|| legacy_windows_sandbox_mode(cfg.features.as_ref()))
}

fn legacy_windows_sandbox_keys_present(features: Option<&FeaturesToml>) -> bool {
    let Some(entries) = features.map(|features| &features.entries) else {
        return false;
    };

    entries.contains_key(Feature::WindowsSandboxElevated.key())
        || entries.contains_key(Feature::WindowsSandbox.key())
        || entries.contains_key("enable_experimental_windows_sandbox")
}

pub fn legacy_windows_sandbox_mode(
    features: Option<&FeaturesToml>,
) -> Option<WindowsSandboxModeToml> {
    let entries = features.map(|features| &features.entries)?;
    legacy_windows_sandbox_mode_from_entries(entries)
}

pub fn legacy_windows_sandbox_mode_from_entries(
    entries: &BTreeMap<String, bool>,
) -> Option<WindowsSandboxModeToml> {
    if entries
        .get(Feature::WindowsSandboxElevated.key())
        .copied()
        .unwrap_or(false)
    {
        return Some(WindowsSandboxModeToml::Elevated);
    }

    if entries
        .get(Feature::WindowsSandbox.key())
        .copied()
        .unwrap_or(false)
        || entries
            .get("enable_experimental_windows_sandbox")
            .copied()
            .unwrap_or(false)
    {
        Some(WindowsSandboxModeToml::Unelevated)
    } else {
        None
    }
}
