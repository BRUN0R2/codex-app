use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolRisk {
    ReadOnly,
    WorkspaceWrite,
    Process,
    Network,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescriptor {
    pub id: &'static str,
    pub name: &'static str,
    pub risk: ToolRisk,
}

#[derive(Debug)]
pub struct ToolRegistry {
    tools: Vec<ToolDescriptor>,
}

impl Default for ToolRegistry {
    fn default() -> Self {
        Self {
            tools: vec![
                ToolDescriptor {
                    id: "workspace.read_file",
                    name: "Ler arquivo",
                    risk: ToolRisk::ReadOnly,
                },
                ToolDescriptor {
                    id: "workspace.search",
                    name: "Pesquisar workspace",
                    risk: ToolRisk::ReadOnly,
                },
                ToolDescriptor {
                    id: "workspace.apply_patch",
                    name: "Aplicar alteração",
                    risk: ToolRisk::WorkspaceWrite,
                },
                ToolDescriptor {
                    id: "system.exec",
                    name: "Executar processo",
                    risk: ToolRisk::Process,
                },
                ToolDescriptor {
                    id: "network.fetch",
                    name: "Acessar rede",
                    risk: ToolRisk::Network,
                },
            ],
        }
    }
}

impl ToolRegistry {
    pub fn descriptors(&self) -> &[ToolDescriptor] {
        &self.tools
    }

    pub fn contains(&self, id: &str) -> bool {
        self.tools.iter().any(|tool| tool.id == id)
    }
}

#[cfg(test)]
mod tests {
    use super::ToolRegistry;

    #[test]
    fn default_registry_has_explicit_workspace_and_process_tools() {
        let registry = ToolRegistry::default();
        assert!(registry.contains("workspace.read_file"));
        assert!(registry.contains("workspace.apply_patch"));
        assert!(registry.contains("system.exec"));
    }
}
