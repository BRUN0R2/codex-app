use std::fmt;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub(in crate::engine::native) struct AgentPath(String);

impl AgentPath {
    pub const ROOT: &str = "/root";
    const ROOT_SEGMENT: &str = "root";

    pub fn root() -> Self {
        Self(Self::ROOT.to_string())
    }

    pub fn from_string(path: String) -> Result<Self, String> {
        validate_absolute_path(&path)?;
        Ok(Self(path))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn is_root(&self) -> bool {
        self.as_str() == Self::ROOT
    }

    pub fn join(&self, agent_name: &str) -> Result<Self, String> {
        validate_agent_name(agent_name)?;
        Self::from_string(format!("{self}/{agent_name}"))
    }

    pub fn resolve(&self, reference: &str) -> Result<Self, String> {
        if reference.is_empty() {
            return Err("agent path must not be empty".to_string());
        }
        if reference == Self::ROOT {
            return Ok(Self::root());
        }
        if reference.starts_with('/') {
            return Self::try_from(reference);
        }

        validate_relative_reference(reference)?;
        Self::from_string(format!("{self}/{reference}"))
    }
}

impl TryFrom<String> for AgentPath {
    type Error = String;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::from_string(value)
    }
}

impl TryFrom<&str> for AgentPath {
    type Error = String;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        Self::from_string(value.to_string())
    }
}

impl From<AgentPath> for String {
    fn from(value: AgentPath) -> Self {
        value.0
    }
}

impl fmt::Display for AgentPath {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

fn validate_agent_name(agent_name: &str) -> Result<(), String> {
    if agent_name.is_empty() {
        return Err("agent_name must not be empty".to_string());
    }
    if agent_name == AgentPath::ROOT_SEGMENT {
        return Err("agent_name `root` is reserved".to_string());
    }
    if matches!(agent_name, "." | "..") {
        return Err(format!("agent_name `{agent_name}` is reserved"));
    }
    if agent_name.contains('/') {
        return Err("agent_name must not contain `/`".to_string());
    }
    if !agent_name.chars().all(|character| {
        character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
    }) {
        return Err(
            "agent_name must use only lowercase letters, digits, and underscores".to_string(),
        );
    }
    Ok(())
}

fn validate_absolute_path(path: &str) -> Result<(), String> {
    let Some(stripped) = path.strip_prefix('/') else {
        return Err("absolute agent paths must start with `/root`".to_string());
    };
    let mut segments = stripped.split('/');
    let Some(root) = segments.next() else {
        return Err("absolute agent path must not be empty".to_string());
    };
    if root != AgentPath::ROOT_SEGMENT {
        return Err("absolute agent paths must start with `/root`".to_string());
    }
    if stripped.ends_with('/') {
        return Err("absolute agent path must not end with `/`".to_string());
    }
    for segment in segments {
        validate_agent_name(segment)?;
    }
    Ok(())
}

fn validate_relative_reference(reference: &str) -> Result<(), String> {
    if reference.ends_with('/') {
        return Err("relative agent path must not end with `/`".to_string());
    }
    for segment in reference.split('/') {
        validate_agent_name(segment)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::AgentPath;

    #[test]
    fn resolves_relative_and_canonical_agent_references() {
        let current = AgentPath::try_from("/root/researcher").expect("path should be valid");
        assert_eq!(
            current
                .resolve("worker")
                .expect("relative reference should resolve")
                .as_str(),
            "/root/researcher/worker"
        );
        assert_eq!(
            current
                .resolve("/root/other")
                .expect("canonical reference should resolve")
                .as_str(),
            "/root/other"
        );
    }

    #[test]
    fn rejects_ambiguous_or_unsafe_agent_names() {
        assert!(AgentPath::root().join("BadName").is_err());
        assert!(AgentPath::root().resolve("../sibling").is_err());
        assert!(AgentPath::try_from("/other").is_err());
        assert!(AgentPath::root().join("root").is_err());
    }
}
