use serde_json::Value;

#[derive(Debug, Clone)]
pub struct CompatibilityStartResponse {
    pub executable: String,
    pub initialize: Value,
}
