#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MacOsPreferencesPermission {
    None,
    ReadOnly,
    ReadWrite,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MacOsAutomationPermission {
    None,
    All,
    BundleIds(Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MacOsSeatbeltProfileExtensions {
    pub macos_preferences: MacOsPreferencesPermission,
    pub macos_automation: MacOsAutomationPermission,
    pub macos_accessibility: bool,
    pub macos_calendar: bool,
}

impl Default for MacOsSeatbeltProfileExtensions {
    fn default() -> Self {
        Self {
            macos_preferences: MacOsPreferencesPermission::None,
            macos_automation: MacOsAutomationPermission::None,
            macos_accessibility: false,
            macos_calendar: false,
        }
    }
}
