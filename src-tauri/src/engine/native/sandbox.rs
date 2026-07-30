use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SandboxMode {
    ReadOnly,
    WorkspaceWrite,
    DangerFullAccess,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalPolicy {
    Untrusted,
    OnRequest,
    Never,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionProfile {
    pub sandbox: SandboxMode,
    pub approvals: ApprovalPolicy,
}

impl PermissionProfile {
    pub const fn read_only() -> Self {
        Self {
            sandbox: SandboxMode::ReadOnly,
            approvals: ApprovalPolicy::Untrusted,
        }
    }

    pub const fn approve_for_me() -> Self {
        Self {
            sandbox: SandboxMode::WorkspaceWrite,
            approvals: ApprovalPolicy::OnRequest,
        }
    }

    pub const fn full_access() -> Self {
        Self {
            sandbox: SandboxMode::DangerFullAccess,
            approvals: ApprovalPolicy::Never,
        }
    }

    pub const fn supported_presets() -> [Self; 3] {
        [
            Self::read_only(),
            Self::approve_for_me(),
            Self::full_access(),
        ]
    }

    pub const fn preset_name(self) -> &'static str {
        match (self.sandbox, self.approvals) {
            (SandboxMode::ReadOnly, ApprovalPolicy::Untrusted) => "read-only",
            (SandboxMode::WorkspaceWrite, ApprovalPolicy::OnRequest) => "approve-for-me",
            (SandboxMode::DangerFullAccess, ApprovalPolicy::Never) => "full-access",
            _ => "custom",
        }
    }
}

impl Default for PermissionProfile {
    fn default() -> Self {
        Self::approve_for_me()
    }
}

#[cfg(test)]
mod tests {
    use super::ApprovalPolicy;
    use super::PermissionProfile;
    use super::SandboxMode;

    #[test]
    fn semantic_permission_presets_are_deterministic() {
        assert_eq!(
            PermissionProfile::approve_for_me().preset_name(),
            "approve-for-me"
        );
        assert_eq!(
            PermissionProfile::full_access().preset_name(),
            "full-access"
        );
        assert_eq!(PermissionProfile::read_only().preset_name(), "read-only");
        assert_eq!(
            PermissionProfile {
                sandbox: SandboxMode::ReadOnly,
                approvals: ApprovalPolicy::Never,
            }
            .preset_name(),
            "custom"
        );
    }
}
