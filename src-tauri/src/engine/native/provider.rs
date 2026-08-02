mod client;
mod history;
mod models;
mod responses;

use std::sync::Arc;

use serde::Deserialize;
use tauri::AppHandle;
use tokio::sync::RwLock;

use self::client::ProviderClient;
use self::models::ModelCatalog;
use super::auth::ChatGptAuth;
use crate::engine::AccountPlanType;
use crate::engine::AccountRateLimitsResponse;
use crate::engine::CreditsSnapshot;
use crate::engine::ModelListResponse;
use crate::engine::RateLimitReachedType;
use crate::engine::RateLimitSnapshot;
use crate::engine::RateLimitWindow;
use crate::engine::SpendControlLimitSnapshot;
use crate::error::AppError;

pub(crate) use self::history::normalize_provider_history;
pub(crate) use self::models::SelectedModel;
pub(crate) use self::responses::ResponseContent;
pub(crate) use self::responses::ResponseEvent;
pub(crate) use self::responses::ResponseItem;
pub(crate) use self::responses::ResponseMessagePhase;
pub(crate) use self::responses::ResponseRequest;
pub(crate) use self::responses::ResponseRequestSettings;
pub(crate) use self::responses::ResponseStream;

const MAX_MODELS: usize = 100;

#[derive(Default)]
pub struct ChatGptCodexProvider {
    client: ProviderClient,
    catalog: RwLock<Option<Arc<ModelCatalog>>>,
}

impl ChatGptCodexProvider {
    pub async fn initialize(&self) -> Result<(), AppError> {
        self.client.initialize()
    }

    pub async fn list_models(
        &self,
        app: &AppHandle,
        auth: &ChatGptAuth,
    ) -> Result<ModelListResponse, AppError> {
        let catalog = self.refresh_catalog(app, auth).await?;
        Ok(ModelListResponse {
            data: catalog
                .models()
                .iter()
                .map(SelectedModel::summary)
                .collect(),
        })
    }

    pub async fn select_model(
        &self,
        app: &AppHandle,
        auth: &ChatGptAuth,
        requested: Option<&str>,
    ) -> Result<SelectedModel, AppError> {
        let catalog = match self.catalog.read().await.clone() {
            Some(catalog) => catalog,
            None => self.refresh_catalog(app, auth).await?,
        };
        catalog.select(requested)
    }

    pub async fn start_response(
        &self,
        app: &AppHandle,
        auth: &ChatGptAuth,
        request: ResponseRequest,
        thread_id: &str,
        turn_state: Option<&str>,
        cancellation: &mut tokio::sync::watch::Receiver<bool>,
    ) -> Result<ResponseStream, AppError> {
        let session = auth.session(app).await?;
        self.client
            .start_response(&session, request, thread_id, turn_state, cancellation)
            .await
    }

    pub async fn read_rate_limits(
        &self,
        app: &AppHandle,
        auth: &ChatGptAuth,
    ) -> Result<AccountRateLimitsResponse, AppError> {
        let session = auth.session(app).await?;
        let payload: UsagePayload = self
            .client
            .get_json(&session, client::USAGE_URL, "rate limits", 1_048_576)
            .await?;
        payload.into_domain()
    }

    pub async fn clear_session_state(&self) {
        *self.catalog.write().await = None;
    }

    async fn refresh_catalog(
        &self,
        app: &AppHandle,
        auth: &ChatGptAuth,
    ) -> Result<Arc<ModelCatalog>, AppError> {
        let session = auth.session(app).await?;
        let catalog = Arc::new(self.client.fetch_models(&session, MAX_MODELS).await?);
        *self.catalog.write().await = Some(Arc::clone(&catalog));
        Ok(catalog)
    }
}

#[derive(Debug, Deserialize)]
struct UsagePayload {
    plan_type: AccountPlanTypeWire,
    rate_limit: Option<RateLimitDetailsWire>,
    additional_rate_limits: Option<Vec<AdditionalRateLimitWire>>,
    credits: Option<CreditsWire>,
    spend_control: Option<SpendControlWire>,
    rate_limit_reached_type: Option<RateLimitReachedWire>,
}

impl UsagePayload {
    fn into_domain(self) -> Result<AccountRateLimitsResponse, AppError> {
        let plan_type = Some(self.plan_type.into_domain());
        let reached = self
            .rate_limit_reached_type
            .map(|value| value.kind.into_domain());
        let primary = RateLimitSnapshot {
            limit_id: Some("codex".into()),
            limit_name: None,
            primary: self
                .rate_limit
                .as_ref()
                .and_then(|limit| limit.primary_window.as_ref())
                .map(RateLimitWindowWire::to_domain),
            secondary: self
                .rate_limit
                .as_ref()
                .and_then(|limit| limit.secondary_window.as_ref())
                .map(RateLimitWindowWire::to_domain),
            credits: self.credits.map(CreditsWire::into_domain),
            individual_limit: self
                .spend_control
                .as_ref()
                .and_then(|control| control.individual_limit.as_ref())
                .map(SpendLimitWire::to_domain),
            spend_control_reached: self.spend_control.map(|control| control.reached),
            plan_type,
            rate_limit_reached_type: reached,
        };
        validate_snapshot(&primary)?;

        let mut by_id = std::collections::BTreeMap::new();
        by_id.insert("codex".into(), primary.clone());
        for additional in self.additional_rate_limits.unwrap_or_default() {
            if additional.metered_feature.trim().is_empty()
                || additional.metered_feature.len() > 128
                || by_id.len() >= 32
            {
                return Err(AppError::Provider(
                    "the rate-limit response contains an invalid bucket".into(),
                ));
            }
            let snapshot = RateLimitSnapshot {
                limit_id: Some(additional.metered_feature.clone()),
                limit_name: Some(additional.limit_name),
                primary: additional
                    .rate_limit
                    .as_ref()
                    .and_then(|limit| limit.primary_window.as_ref())
                    .map(RateLimitWindowWire::to_domain),
                secondary: additional
                    .rate_limit
                    .as_ref()
                    .and_then(|limit| limit.secondary_window.as_ref())
                    .map(RateLimitWindowWire::to_domain),
                credits: None,
                individual_limit: None,
                spend_control_reached: None,
                plan_type,
                rate_limit_reached_type: None,
            };
            validate_snapshot(&snapshot)?;
            if by_id.insert(additional.metered_feature, snapshot).is_some() {
                return Err(AppError::Provider(
                    "the rate-limit response contains duplicate bucket ids".into(),
                ));
            }
        }
        Ok(AccountRateLimitsResponse {
            rate_limits: primary,
            rate_limits_by_limit_id: by_id,
        })
    }
}

fn validate_snapshot(snapshot: &RateLimitSnapshot) -> Result<(), AppError> {
    for window in [snapshot.primary.as_ref(), snapshot.secondary.as_ref()]
        .into_iter()
        .flatten()
    {
        if !(0.0..=100.0).contains(&window.used_percent)
            || window.window_duration_mins.is_some_and(|value| value <= 0)
            || window.resets_at.is_some_and(|value| value < 0)
        {
            return Err(AppError::Provider(
                "the rate-limit response contains an invalid usage window".into(),
            ));
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct RateLimitDetailsWire {
    primary_window: Option<RateLimitWindowWire>,
    secondary_window: Option<RateLimitWindowWire>,
}

#[derive(Debug, Deserialize)]
struct RateLimitWindowWire {
    used_percent: f64,
    limit_window_seconds: Option<i64>,
    reset_at: Option<i64>,
}

impl RateLimitWindowWire {
    fn to_domain(&self) -> RateLimitWindow {
        RateLimitWindow {
            used_percent: self.used_percent,
            window_duration_mins: self.limit_window_seconds.map(|seconds| seconds / 60),
            resets_at: self.reset_at,
        }
    }
}

#[derive(Debug, Deserialize)]
struct AdditionalRateLimitWire {
    limit_name: String,
    metered_feature: String,
    rate_limit: Option<RateLimitDetailsWire>,
}

#[derive(Debug, Deserialize)]
struct CreditsWire {
    has_credits: bool,
    unlimited: bool,
    balance: Option<String>,
}

impl CreditsWire {
    fn into_domain(self) -> CreditsSnapshot {
        CreditsSnapshot {
            has_credits: self.has_credits,
            unlimited: self.unlimited,
            balance: self.balance,
        }
    }
}

#[derive(Debug, Deserialize)]
struct SpendControlWire {
    reached: bool,
    individual_limit: Option<SpendLimitWire>,
}

#[derive(Debug, Deserialize)]
struct SpendLimitWire {
    limit: String,
    used: String,
    remaining_percent: i64,
    reset_at: i64,
}

impl SpendLimitWire {
    fn to_domain(&self) -> SpendControlLimitSnapshot {
        SpendControlLimitSnapshot {
            limit: self.limit.clone(),
            used: self.used.clone(),
            remaining_percent: self.remaining_percent,
            resets_at: self.reset_at,
        }
    }
}

#[derive(Debug, Deserialize)]
struct RateLimitReachedWire {
    kind: RateLimitReachedKindWire,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RateLimitReachedKindWire {
    RateLimitReached,
    WorkspaceOwnerCreditsDepleted,
    WorkspaceMemberCreditsDepleted,
    WorkspaceOwnerUsageLimitReached,
    WorkspaceMemberUsageLimitReached,
}

impl RateLimitReachedKindWire {
    const fn into_domain(self) -> RateLimitReachedType {
        match self {
            Self::RateLimitReached => RateLimitReachedType::RateLimitReached,
            Self::WorkspaceOwnerCreditsDepleted => {
                RateLimitReachedType::WorkspaceOwnerCreditsDepleted
            }
            Self::WorkspaceMemberCreditsDepleted => {
                RateLimitReachedType::WorkspaceMemberCreditsDepleted
            }
            Self::WorkspaceOwnerUsageLimitReached => {
                RateLimitReachedType::WorkspaceOwnerUsageLimitReached
            }
            Self::WorkspaceMemberUsageLimitReached => {
                RateLimitReachedType::WorkspaceMemberUsageLimitReached
            }
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AccountPlanTypeWire {
    Free,
    Go,
    Plus,
    Pro,
    Prolite,
    Team,
    SelfServeBusinessProlite,
    SelfServeBusinessUsageBased,
    Business,
    Ent26,
    EnterpriseCbpUsageBased,
    Enterprise,
    Edu,
}

impl AccountPlanTypeWire {
    const fn into_domain(self) -> AccountPlanType {
        match self {
            Self::Free => AccountPlanType::Free,
            Self::Go => AccountPlanType::Go,
            Self::Plus => AccountPlanType::Plus,
            Self::Pro => AccountPlanType::Pro,
            Self::Prolite => AccountPlanType::Prolite,
            Self::Team => AccountPlanType::Team,
            Self::SelfServeBusinessProlite => AccountPlanType::SelfServeBusinessProlite,
            Self::SelfServeBusinessUsageBased => AccountPlanType::SelfServeBusinessUsageBased,
            Self::Business => AccountPlanType::Business,
            Self::Ent26 => AccountPlanType::Ent26,
            Self::EnterpriseCbpUsageBased => AccountPlanType::EnterpriseCbpUsageBased,
            Self::Enterprise => AccountPlanType::Enterprise,
            Self::Edu => AccountPlanType::Edu,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::UsagePayload;

    #[test]
    fn rejects_unknown_plan_values_instead_of_falling_back() {
        let result = serde_json::from_str::<UsagePayload>(r#"{"plan_type":"future"}"#);
        assert!(result.is_err());
    }
}
