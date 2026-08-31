mod client;
mod history;
mod models;
mod responses;
mod websocket;

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio::sync::{Mutex, RwLock};

pub(crate) use self::client::ProviderResponseSession;
use self::client::{ContinuationPolicy, ProviderClient};
pub(crate) use self::models::ModelCatalog;
pub(crate) use self::models::ModelToolMode;
use super::auth::{AuthSession, ChatGptAuth};
use crate::engine::AccountPlanType;
use crate::engine::AccountRateLimitsResponse;
use crate::engine::AutoTopUpSettingsSnapshot;
use crate::engine::CodexModel;
use crate::engine::CreditsSnapshot;
use crate::engine::ModelListResponse;
use crate::engine::PlanPriceSnapshot;
use crate::engine::RateLimitReachedType;
use crate::engine::RateLimitSnapshot;
use crate::engine::RateLimitWindow;
use crate::engine::SpendControlLimitSnapshot;
use crate::engine::UsageResetCredit;
use crate::engine::UsageResetCreditsResponse;
use crate::engine::UsageResetRedemptionResponse;
use crate::error::AppError;

pub(crate) use self::history::normalize_provider_history;
#[cfg(test)]
pub(crate) use self::models::ModelsWire;
pub(crate) use self::models::SelectedModel;
pub(crate) use self::responses::DEFAULT_FUNCTION_NAMESPACE;
pub(crate) use self::responses::FunctionCallOutputContent;
pub(crate) use self::responses::FunctionCallOutputPayload;
pub(crate) use self::responses::ResponseContent;
pub(crate) use self::responses::ResponseEvent;
pub(crate) use self::responses::ResponseItem;
pub(crate) use self::responses::ResponseMessagePhase;
pub(crate) use self::responses::ResponseProtocol;
pub(crate) use self::responses::ResponseRequest;
pub(crate) use self::responses::ResponseRequestSettings;
pub(crate) use self::responses::ResponseStream;
pub(crate) use self::responses::WebSearchAction;

const MAX_MODELS: usize = 100;
const MODEL_CATALOG_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_RATE_LIMIT_BUCKET_ID_BYTES: usize = 128;
const MAX_RATE_LIMIT_BUCKETS: usize = 32;
const MAX_USAGE_RESET_CREDITS: usize = 100;
const MAX_USAGE_RESET_ID_BYTES: usize = 256;
const MAX_USAGE_RESET_TITLE_BYTES: usize = 512;
const MAX_USAGE_RESET_STATUS_BYTES: usize = 64;
const MAX_USAGE_RESET_CODE_BYTES: usize = 128;
const MAX_AUTO_RELOAD_POLICY_BYTES: usize = 128;
const MAX_DECIMAL_DIGIT_BYTES: usize = 32;
const RATE_LIMIT_BODY_MAX_BYTES: usize = 1_048_576;
const USAGE_RESET_CREDITS_BODY_MAX_BYTES: usize = 1_048_576;
const USAGE_RESET_REDEMPTION_BODY_MAX_BYTES: usize = 256 * 1_024;
const AUTO_TOP_UP_SETTINGS_BODY_MAX_BYTES: usize = 256 * 1_024;
const CREDIT_DISCOUNT_OFFER_BODY_MAX_BYTES: usize = 256 * 1_024;
const ACCOUNT_CHECK_BODY_MAX_BYTES: usize = 2 * 1_048_576;
const PLAN_PRICE_BODY_MAX_BYTES: usize = 2 * 1_048_576;
const VOLUME_DISCOUNT_POLICY_PERCENT: u32 = 30;
const VOLUME_DISCOUNT_WITH_AUTO_RELOAD_INCENTIVE_PERCENT: u32 = 40;
const EPOCH_SECONDS_UPPER_BOUND: i64 = 9_999_999_999;
const USAGE_RESET_CREDITS_URL: &str =
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const USAGE_RESET_CONSUME_URL: &str =
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
const AUTO_TOP_UP_SETTINGS_URL: &str = "https://chatgpt.com/backend-api/subscriptions/auto_top_up/settings?include_payment_method=true";
const AUTO_TOP_UP_ENABLE_URL: &str =
    "https://chatgpt.com/backend-api/subscriptions/auto_top_up/enable";
const AUTO_TOP_UP_UPDATE_URL: &str =
    "https://chatgpt.com/backend-api/subscriptions/auto_top_up/update";
const AUTO_TOP_UP_DISABLE_URL: &str =
    "https://chatgpt.com/backend-api/subscriptions/auto_top_up/disable";
const CREDIT_DISCOUNT_OFFER_URL: &str =
    "https://chatgpt.com/backend-api/subscriptions/credits/discount-offer";
const ACCOUNTS_CHECK_URL: &str = "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27";
const CHECKOUT_PRICING_CONFIG_BASE_URL: &str =
    "https://chatgpt.com/backend-api/checkout_pricing_config/configs";

#[derive(Default)]
pub struct ChatGptCodexProvider {
    client: ProviderClient,
    catalog: RwLock<Option<CachedModelCatalog>>,
    refresh_gate: Mutex<()>,
}

struct CachedModelCatalog {
    catalog: Arc<ModelCatalog>,
    etag: Option<String>,
    fetched_at: Instant,
}

impl CachedModelCatalog {
    fn get_if_fresh(&self, now: Instant) -> Option<Arc<ModelCatalog>> {
        model_catalog_cache_is_fresh(self.fetched_at, now).then(|| Arc::clone(&self.catalog))
    }
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
        let catalog = self.catalog(app, auth).await?;
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
        let catalog = self.catalog(app, auth).await?;
        catalog.select(requested)
    }

    pub async fn multi_agent_models(
        &self,
        app: &AppHandle,
        auth: &ChatGptAuth,
    ) -> Result<Vec<CodexModel>, AppError> {
        Ok(self.catalog(app, auth).await?.multi_agent_models())
    }

    pub async fn reconcile_catalog_etag(&self, incoming_etag: &str) {
        let mut cached = self.catalog.write().await;
        match cached.as_mut() {
            Some(entry) if model_catalog_etag_changed(entry.etag.as_deref(), incoming_etag) => {
                *cached = None;
            }
            Some(entry) => entry.fetched_at = Instant::now(),
            None => {}
        }
    }

    pub fn response_session(&self, thread_id: &str) -> ProviderResponseSession {
        self.client.response_session(thread_id)
    }

    pub fn startup_response_session(&self, thread_id: &str) -> Option<ProviderResponseSession> {
        self.client.startup_response_session(thread_id)
    }

    pub fn close_response_session(&self, thread_id: &str) {
        self.client.close_response_session(thread_id);
    }

    pub fn shutdown_response_sessions(&self) {
        self.client.shutdown_response_sessions();
    }

    pub async fn start_response(
        &self,
        app: &AppHandle,
        auth: &ChatGptAuth,
        response_session: &mut ProviderResponseSession,
        request: ResponseRequest<'_>,
        turn_state: Option<&str>,
        cancellation: &mut tokio::sync::watch::Receiver<bool>,
    ) -> Result<ResponseStream, AppError> {
        let session = auth.session(app).await?;
        self.client
            .start_response(
                &session,
                response_session,
                request,
                ContinuationPolicy::Preserve,
                turn_state,
                cancellation,
            )
            .await
    }

    pub async fn start_compaction_response(
        &self,
        app: &AppHandle,
        auth: &ChatGptAuth,
        response_session: &mut ProviderResponseSession,
        request: ResponseRequest<'_>,
        turn_state: Option<&str>,
        cancellation: &mut tokio::sync::watch::Receiver<bool>,
    ) -> Result<ResponseStream, AppError> {
        let session = auth.session(app).await?;
        self.client
            .start_response(
                &session,
                response_session,
                request,
                ContinuationPolicy::ResetAfterResponse,
                turn_state,
                cancellation,
            )
            .await
    }

    pub async fn preconnect_response(
        &self,
        app: &AppHandle,
        auth: &ChatGptAuth,
        response_session: &mut ProviderResponseSession,
        uses_responses_lite: bool,
        cancellation: &mut tokio::sync::watch::Receiver<bool>,
    ) -> Result<Option<String>, AppError> {
        let session = auth.session(app).await?;
        self.client
            .preconnect_response(
                &session,
                response_session,
                uses_responses_lite,
                cancellation,
            )
            .await
    }

    pub async fn prewarm_response(
        &self,
        response_session: &mut ProviderResponseSession,
        request: ResponseRequest<'_>,
        turn_state: Option<&str>,
    ) -> Result<Option<ResponseStream>, AppError> {
        self.client
            .prewarm_response(response_session, request, turn_state)
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
            .get_json(
                &session,
                client::USAGE_URL,
                "rate limits",
                RATE_LIMIT_BODY_MAX_BYTES,
            )
            .await?;
        let plan_type = payload.plan_type;
        let mut response = payload.into_domain()?;
        response.plan_price = self
            .read_plan_price(&session, session.account_id(), plan_type)
            .await
            .ok()
            .flatten();
        Ok(response)
    }

    pub async fn read_usage_resets(
        &self,
        app: &AppHandle,
        auth: &ChatGptAuth,
    ) -> Result<UsageResetCreditsResponse, AppError> {
        let session = auth.session(app).await?;
        let payload: UsageResetCreditsWire = self
            .client
            .get_json(
                &session,
                USAGE_RESET_CREDITS_URL,
                "usage reset credits",
                USAGE_RESET_CREDITS_BODY_MAX_BYTES,
            )
            .await?;
        payload.into_domain()
    }

    pub async fn redeem_usage_reset(
        &self,
        app: &AppHandle,
        auth: &ChatGptAuth,
        credit_id: Option<&str>,
        redeem_request_id: &str,
    ) -> Result<UsageResetRedemptionResponse, AppError> {
        let session = auth.session(app).await?;
        let body = UsageResetConsumeRequest {
            credit_id,
            redeem_request_id,
        };
        let payload: UsageResetConsumeWire = self
            .client
            .post_json(
                &session,
                USAGE_RESET_CONSUME_URL,
                &body,
                "usage reset redemption",
                USAGE_RESET_REDEMPTION_BODY_MAX_BYTES,
            )
            .await?;
        payload.into_domain(credit_id)
    }

    pub async fn read_auto_top_up(
        &self,
        app: &AppHandle,
        auth: &ChatGptAuth,
    ) -> Result<AutoTopUpSettingsSnapshot, AppError> {
        let session = auth.session(app).await?;
        let settings: AutoTopUpSettingsWire = self
            .client
            .get_json(
                &session,
                AUTO_TOP_UP_SETTINGS_URL,
                "automatic credit reload settings",
                AUTO_TOP_UP_SETTINGS_BODY_MAX_BYTES,
            )
            .await?;
        let discount = self
            .client
            .get_json::<CreditDiscountOfferEnvelopeWire>(
                &session,
                CREDIT_DISCOUNT_OFFER_URL,
                "credit discount offer",
                CREDIT_DISCOUNT_OFFER_BODY_MAX_BYTES,
            )
            .await
            .ok()
            .and_then(|offer| offer.maximum_auto_reload_discount_percent());
        settings.into_domain(discount)
    }

    pub async fn enable_auto_top_up(
        &self,
        app: &AppHandle,
        auth: &ChatGptAuth,
        recharge_threshold: &str,
        recharge_target: &str,
        recharge_monthly_limit: Option<&str>,
    ) -> Result<AutoTopUpSettingsSnapshot, AppError> {
        let session = auth.session(app).await?;
        let discount_offer = self
            .client
            .get_json::<CreditDiscountOfferEnvelopeWire>(
                &session,
                CREDIT_DISCOUNT_OFFER_URL,
                "credit discount offer",
                CREDIT_DISCOUNT_OFFER_BODY_MAX_BYTES,
            )
            .await
            .ok();
        let body = AutoTopUpEnableWire {
            recharge_threshold,
            recharge_target,
            recharge_monthly_limit,
            enroll_in_auto_reload_discount: discount_offer
                .as_ref()
                .is_some_and(CreditDiscountOfferEnvelopeWire::has_auto_reload_offer),
        };
        let payload: AutoTopUpSettingsWire = self
            .client
            .post_json(
                &session,
                AUTO_TOP_UP_ENABLE_URL,
                &body,
                "enable automatic credit reload",
                AUTO_TOP_UP_SETTINGS_BODY_MAX_BYTES,
            )
            .await?;
        payload.into_domain(
            discount_offer
                .as_ref()
                .and_then(CreditDiscountOfferEnvelopeWire::maximum_auto_reload_discount_percent),
        )
    }

    pub async fn update_auto_top_up(
        &self,
        app: &AppHandle,
        auth: &ChatGptAuth,
        recharge_threshold: &str,
        recharge_target: &str,
        recharge_monthly_limit: Option<&str>,
    ) -> Result<AutoTopUpSettingsSnapshot, AppError> {
        self.write_auto_top_up(
            app,
            auth,
            recharge_threshold,
            recharge_target,
            recharge_monthly_limit,
        )
        .await
    }

    pub async fn disable_auto_top_up(
        &self,
        app: &AppHandle,
        auth: &ChatGptAuth,
    ) -> Result<AutoTopUpSettingsSnapshot, AppError> {
        let session = auth.session(app).await?;
        let payload: AutoTopUpSettingsWire = self
            .client
            .post_json(
                &session,
                AUTO_TOP_UP_DISABLE_URL,
                &serde_json::json!({}),
                "disable automatic credit reload",
                AUTO_TOP_UP_SETTINGS_BODY_MAX_BYTES,
            )
            .await?;
        payload.into_domain(None)
    }

    pub async fn clear_session_state(&self) {
        let _refresh_guard = self.refresh_gate.lock().await;
        *self.catalog.write().await = None;
        self.client.clear_response_sessions();
    }

    async fn write_auto_top_up(
        &self,
        app: &AppHandle,
        auth: &ChatGptAuth,
        recharge_threshold: &str,
        recharge_target: &str,
        recharge_monthly_limit: Option<&str>,
    ) -> Result<AutoTopUpSettingsSnapshot, AppError> {
        let session = auth.session(app).await?;
        let body = AutoTopUpUpdateWire {
            recharge_threshold,
            recharge_target,
            recharge_monthly_limit,
        };
        let payload: AutoTopUpSettingsWire = self
            .client
            .post_json(
                &session,
                AUTO_TOP_UP_UPDATE_URL,
                &body,
                "update automatic credit reload",
                AUTO_TOP_UP_SETTINGS_BODY_MAX_BYTES,
            )
            .await?;
        payload.into_domain(None)
    }

    async fn read_plan_price(
        &self,
        session: &AuthSession,
        account_id: &str,
        plan_type: AccountPlanTypeWire,
    ) -> Result<Option<PlanPriceSnapshot>, AppError> {
        let account_check: AccountsCheckWire = self
            .client
            .get_json(
                session,
                ACCOUNTS_CHECK_URL,
                "account billing details",
                ACCOUNT_CHECK_BODY_MAX_BYTES,
            )
            .await?;
        let Some(billing_country) = account_check
            .accounts
            .get(account_id)
            .and_then(|account| account.entitlement.as_ref())
            .and_then(|entitlement| entitlement.billing_currency.as_deref())
            .map(str::trim)
            .filter(|value| {
                (2..=8).contains(&value.len())
                    && value
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            })
        else {
            return Ok(None);
        };
        let url = format!("{CHECKOUT_PRICING_CONFIG_BASE_URL}/{billing_country}");
        let pricing: CheckoutPricingConfigWire = self
            .client
            .get_json(
                session,
                &url,
                "localized plan pricing",
                PLAN_PRICE_BODY_MAX_BYTES,
            )
            .await?;
        pricing.into_plan_price(plan_type)
    }

    async fn catalog(
        &self,
        app: &AppHandle,
        auth: &ChatGptAuth,
    ) -> Result<Arc<ModelCatalog>, AppError> {
        if let Some(catalog) = self
            .catalog
            .read()
            .await
            .as_ref()
            .and_then(|cached| cached.get_if_fresh(Instant::now()))
        {
            return Ok(catalog);
        }
        let _refresh_guard = self.refresh_gate.lock().await;
        if let Some(catalog) = self
            .catalog
            .read()
            .await
            .as_ref()
            .and_then(|cached| cached.get_if_fresh(Instant::now()))
        {
            return Ok(catalog);
        }
        let session = auth.session(app).await?;
        let (catalog, etag) = self.client.fetch_models(&session, MAX_MODELS).await?;
        let catalog = Arc::new(catalog);
        *self.catalog.write().await = Some(CachedModelCatalog {
            catalog: Arc::clone(&catalog),
            etag,
            fetched_at: Instant::now(),
        });
        Ok(catalog)
    }
}

fn model_catalog_cache_is_fresh(fetched_at: Instant, now: Instant) -> bool {
    now.saturating_duration_since(fetched_at) < MODEL_CATALOG_CACHE_TTL
}

fn model_catalog_etag_changed(cached: Option<&str>, incoming: &str) -> bool {
    cached != Some(incoming)
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
            .map(|value| value.value.into_domain());
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
                || additional.metered_feature.len() > MAX_RATE_LIMIT_BUCKET_ID_BYTES
                || by_id.len() >= MAX_RATE_LIMIT_BUCKETS
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
            plan_price: None,
        })
    }
}

#[derive(Debug, Deserialize)]
struct UsageResetCreditsWire {
    #[serde(default)]
    credits: Option<Vec<UsageResetCreditWire>>,
    #[serde(default)]
    available_count: u64,
    #[serde(default)]
    immediate_reset_purchase_eligible: bool,
}

impl UsageResetCreditsWire {
    fn into_domain(self) -> Result<UsageResetCreditsResponse, AppError> {
        let credits = self.credits.unwrap_or_default();
        if credits.len() > MAX_USAGE_RESET_CREDITS {
            return Err(AppError::Provider(
                "the usage reset response contains too many credits".into(),
            ));
        }
        let available_count = u32::try_from(self.available_count).map_err(|_| {
            AppError::Provider("the usage reset response contains an invalid count".into())
        })?;
        Ok(UsageResetCreditsResponse {
            credits: credits
                .into_iter()
                .map(UsageResetCreditWire::into_domain)
                .collect::<Result<Vec<_>, _>>()?,
            available_count,
            immediate_reset_purchase_eligible: self.immediate_reset_purchase_eligible,
        })
    }
}

#[derive(Debug, Deserialize)]
struct UsageResetCreditWire {
    id: String,
    title: Option<String>,
    status: Option<String>,
    expires_at: Option<UsageResetTimestampWire>,
}

impl UsageResetCreditWire {
    fn into_domain(self) -> Result<UsageResetCredit, AppError> {
        let id = validate_usage_reset_text("credit id", self.id, MAX_USAGE_RESET_ID_BYTES)?;
        let title = self
            .title
            .map(|value| {
                validate_usage_reset_text("credit title", value, MAX_USAGE_RESET_TITLE_BYTES)
            })
            .transpose()?;
        let status = validate_usage_reset_text(
            "credit status",
            self.status.unwrap_or_else(|| "unknown".into()),
            MAX_USAGE_RESET_STATUS_BYTES,
        )?;
        let expires_at = self
            .expires_at
            .map(UsageResetTimestampWire::into_timestamp_ms)
            .transpose()?;
        Ok(UsageResetCredit {
            id,
            title,
            status,
            expires_at,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum UsageResetTimestampWire {
    Integer(i64),
    Float(f64),
    Text(String),
}

impl UsageResetTimestampWire {
    fn into_timestamp_ms(self) -> Result<i64, AppError> {
        let value = match self {
            Self::Integer(value) => to_js_timestamp_ms(value),
            Self::Float(value)
                if value.is_finite() && value >= i64::MIN as f64 && value <= i64::MAX as f64 =>
            {
                to_js_timestamp_ms(value.round() as i64)
            }
            Self::Float(_) => {
                return Err(AppError::Provider(
                    "the usage reset response contains an invalid expiration".into(),
                ));
            }
            Self::Text(value) => {
                if let Ok(numeric) = value.parse::<i64>() {
                    to_js_timestamp_ms(numeric)
                } else {
                    chrono::DateTime::parse_from_rfc3339(&value)
                        .map_err(|_| {
                            AppError::Provider(
                                "the usage reset response contains an invalid expiration".into(),
                            )
                        })?
                        .timestamp_millis()
                }
            }
        };
        if value < 0 {
            return Err(AppError::Provider(
                "the usage reset response contains a negative expiration".into(),
            ));
        }
        Ok(value)
    }
}

#[derive(Debug, Serialize)]
struct UsageResetConsumeRequest<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    credit_id: Option<&'a str>,
    redeem_request_id: &'a str,
}

#[derive(Debug, Deserialize)]
struct UsageResetConsumeWire {
    code: String,
    credit: Option<UsageResetConsumedCreditWire>,
}

impl UsageResetConsumeWire {
    fn into_domain(
        self,
        requested_credit_id: Option<&str>,
    ) -> Result<UsageResetRedemptionResponse, AppError> {
        let code =
            validate_usage_reset_text("redemption code", self.code, MAX_USAGE_RESET_CODE_BYTES)?;
        let credit_id = self
            .credit
            .map(|credit| {
                validate_usage_reset_text("redeemed credit id", credit.id, MAX_USAGE_RESET_ID_BYTES)
            })
            .transpose()?
            .or_else(|| requested_credit_id.map(str::to_owned));
        Ok(UsageResetRedemptionResponse { code, credit_id })
    }
}

#[derive(Debug, Deserialize)]
struct UsageResetConsumedCreditWire {
    id: String,
}

#[derive(Debug, Deserialize)]
struct AutoTopUpSettingsWire {
    #[serde(default)]
    is_enabled: bool,
    payment_method: Option<serde_json::Value>,
    recharge_threshold: Option<String>,
    recharge_target: Option<String>,
    recharge_monthly_limit: Option<String>,
    auto_reload_credit_discount_policy: Option<String>,
    immediate_top_up_status: Option<String>,
}

impl AutoTopUpSettingsWire {
    fn into_domain(
        self,
        offer_discount_percent: Option<u32>,
    ) -> Result<AutoTopUpSettingsSnapshot, AppError> {
        if matches!(
            self.immediate_top_up_status.as_deref(),
            Some("failed" | "payment_declined")
        ) {
            return Err(AppError::Provider(
                "automatic credit reload could not be completed; verify the payment method and try again"
                    .into(),
            ));
        }
        let recharge_threshold =
            validate_optional_decimal("automatic reload threshold", self.recharge_threshold)?;
        let recharge_target =
            validate_optional_decimal("automatic reload target", self.recharge_target)?;
        let recharge_monthly_limit = validate_optional_decimal(
            "automatic reload monthly limit",
            self.recharge_monthly_limit,
        )?;
        let policy = self
            .auto_reload_credit_discount_policy
            .map(|value| {
                validate_usage_reset_text(
                    "automatic reload discount policy",
                    value,
                    MAX_AUTO_RELOAD_POLICY_BYTES,
                )
            })
            .transpose()?;
        let policy_discount = match policy.as_deref() {
            Some("volume_discount_v1") => Some(VOLUME_DISCOUNT_POLICY_PERCENT),
            Some("volume_discount_with_auto_reload_incentive_v1") => {
                Some(VOLUME_DISCOUNT_WITH_AUTO_RELOAD_INCENTIVE_PERCENT)
            }
            _ => None,
        };
        Ok(AutoTopUpSettingsSnapshot {
            available: true,
            is_enabled: self.is_enabled,
            has_payment_method: self.payment_method.is_some(),
            recharge_threshold,
            recharge_target,
            recharge_monthly_limit,
            auto_reload_credit_discount_policy: policy,
            maximum_discount_percent: policy_discount.max(offer_discount_percent),
        })
    }
}

#[derive(Debug, Serialize)]
struct AutoTopUpEnableWire<'a> {
    recharge_threshold: &'a str,
    recharge_target: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    recharge_monthly_limit: Option<&'a str>,
    #[serde(skip_serializing_if = "is_false")]
    enroll_in_auto_reload_discount: bool,
}

#[derive(Debug, Serialize)]
struct AutoTopUpUpdateWire<'a> {
    recharge_threshold: &'a str,
    recharge_target: &'a str,
    recharge_monthly_limit: Option<&'a str>,
}

#[derive(Debug, Deserialize)]
struct CreditDiscountOfferEnvelopeWire {
    offer: Option<CreditDiscountOfferWire>,
}

impl CreditDiscountOfferEnvelopeWire {
    fn has_auto_reload_offer(&self) -> bool {
        self.offer
            .as_ref()
            .and_then(|offer| offer.auto_reload.as_ref())
            .is_some()
    }

    fn maximum_auto_reload_discount_percent(&self) -> Option<u32> {
        self.offer
            .as_ref()?
            .auto_reload
            .as_ref()?
            .tiers
            .iter()
            .filter_map(|tier| {
                (tier.percent_off.is_finite() && (0.0..=100.0).contains(&tier.percent_off))
                    .then_some(tier.percent_off.round() as u32)
            })
            .max()
    }
}

#[derive(Debug, Deserialize)]
struct CreditDiscountOfferWire {
    auto_reload: Option<CreditDiscountTierGroupWire>,
}

#[derive(Debug, Deserialize)]
struct CreditDiscountTierGroupWire {
    #[serde(default)]
    tiers: Vec<CreditDiscountTierWire>,
}

#[derive(Debug, Deserialize)]
struct CreditDiscountTierWire {
    percent_off: f64,
}

fn is_false(value: &bool) -> bool {
    !value
}

fn validate_usage_reset_text(
    label: &str,
    value: String,
    maximum_bytes: usize,
) -> Result<String, AppError> {
    let value = value.trim().to_string();
    if value.is_empty() || value.len() > maximum_bytes {
        return Err(AppError::Provider(format!(
            "the usage response contains an invalid {label}"
        )));
    }
    Ok(value)
}

fn validate_optional_decimal(
    label: &str,
    value: Option<String>,
) -> Result<Option<String>, AppError> {
    value
        .map(|value| {
            let value = value.trim().to_string();
            if value.is_empty()
                || value.len() > MAX_DECIMAL_DIGIT_BYTES
                || !value.bytes().all(|byte| byte.is_ascii_digit())
            {
                return Err(AppError::Provider(format!(
                    "the usage response contains an invalid {label}"
                )));
            }
            Ok(value)
        })
        .transpose()
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
            resets_at: self.reset_at.map(to_js_timestamp_ms),
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
            resets_at: to_js_timestamp_ms(self.reset_at),
        }
    }
}

fn to_js_timestamp_ms(value: i64) -> i64 {
    if (0..=EPOCH_SECONDS_UPPER_BOUND).contains(&value) {
        value * 1_000
    } else {
        value
    }
}

#[derive(Debug, Deserialize)]
struct RateLimitReachedWire {
    #[serde(rename = "type")]
    value: RateLimitReachedKindWire,
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

#[derive(Debug, Deserialize)]
struct AccountsCheckWire {
    #[serde(default)]
    accounts: std::collections::BTreeMap<String, AccountsCheckAccountWire>,
}

#[derive(Debug, Deserialize)]
struct AccountsCheckAccountWire {
    entitlement: Option<AccountEntitlementWire>,
}

#[derive(Debug, Deserialize)]
struct AccountEntitlementWire {
    billing_currency: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CheckoutPricingConfigWire {
    currency_config: Option<PricingCurrencyWire>,
}

impl CheckoutPricingConfigWire {
    fn into_plan_price(
        self,
        plan_type: AccountPlanTypeWire,
    ) -> Result<Option<PlanPriceSnapshot>, AppError> {
        let Some(config) = self.currency_config else {
            return Ok(None);
        };
        let plan = match plan_type {
            AccountPlanTypeWire::Free => config.free,
            AccountPlanTypeWire::Go => config.go,
            AccountPlanTypeWire::Plus => config.plus,
            AccountPlanTypeWire::Prolite => config.prolite,
            AccountPlanTypeWire::Pro => config.pro,
            AccountPlanTypeWire::Team
            | AccountPlanTypeWire::SelfServeBusinessProlite
            | AccountPlanTypeWire::SelfServeBusinessUsageBased
            | AccountPlanTypeWire::Business
            | AccountPlanTypeWire::Ent26
            | AccountPlanTypeWire::EnterpriseCbpUsageBased
            | AccountPlanTypeWire::Enterprise
            | AccountPlanTypeWire::Edu => None,
        };
        let Some(amount) = plan
            .and_then(|plan| plan.month)
            .and_then(|monthly| monthly.amount)
            .filter(|amount| *amount > 0)
        else {
            return Ok(None);
        };
        let currency = config
            .symbol_code
            .as_deref()
            .map(str::trim)
            .filter(|currency| {
                currency.len() == 3 && currency.bytes().all(|byte| byte.is_ascii_alphabetic())
            })
            .map(str::to_uppercase)
            .ok_or_else(|| {
                AppError::Provider("the plan pricing response contains an invalid currency".into())
            })?;
        let exponent = config.minor_unit_exponent.unwrap_or(2);
        let minor_unit_exponent = u8::try_from(exponent)
            .ok()
            .filter(|value| *value <= 6)
            .ok_or_else(|| {
                AppError::Provider(
                    "the plan pricing response contains an invalid currency exponent".into(),
                )
            })?;
        Ok(Some(PlanPriceSnapshot {
            amount,
            currency,
            minor_unit_exponent,
        }))
    }
}

#[derive(Debug, Deserialize)]
struct PricingCurrencyWire {
    symbol_code: Option<String>,
    minor_unit_exponent: Option<i64>,
    free: Option<PlanPricingWire>,
    go: Option<PlanPricingWire>,
    plus: Option<PlanPricingWire>,
    prolite: Option<PlanPricingWire>,
    pro: Option<PlanPricingWire>,
}

#[derive(Debug, Deserialize)]
struct PlanPricingWire {
    month: Option<PlanMonthlyPriceWire>,
}

#[derive(Debug, Deserialize)]
struct PlanMonthlyPriceWire {
    amount: Option<i64>,
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
    use std::time::{Duration, Instant};

    use super::{
        AccountPlanTypeWire, AutoTopUpSettingsWire, CheckoutPricingConfigWire, UsagePayload,
        UsageResetConsumeWire, UsageResetCreditsWire, model_catalog_cache_is_fresh,
        model_catalog_etag_changed,
    };
    use crate::engine::contracts::RateLimitReachedType;

    #[test]
    fn rejects_unknown_plan_values_instead_of_falling_back() {
        let result = serde_json::from_str::<UsagePayload>(r#"{"plan_type":"future"}"#);
        assert!(result.is_err());
    }

    #[test]
    fn model_catalog_cache_expires_after_five_minutes() {
        let fetched_at = Instant::now();

        assert!(model_catalog_cache_is_fresh(
            fetched_at,
            fetched_at + Duration::from_secs(299)
        ));
        assert!(!model_catalog_cache_is_fresh(
            fetched_at,
            fetched_at + Duration::from_secs(300)
        ));
    }

    #[test]
    fn model_catalog_etag_only_invalidates_changed_or_unversioned_cache() {
        assert!(!model_catalog_etag_changed(
            Some("catalog-v1"),
            "catalog-v1"
        ));
        assert!(model_catalog_etag_changed(Some("catalog-v1"), "catalog-v2"));
        assert!(model_catalog_etag_changed(None, "catalog-v1"));
    }

    #[test]
    fn decodes_rate_limit_reached_type_from_the_server_type_field() {
        let payload = serde_json::from_str::<UsagePayload>(
            r#"{
                "plan_type": "pro",
                "rate_limit_reached_type": {
                    "type": "workspace_member_usage_limit_reached"
                }
            }"#,
        )
        .expect("the usage payload should decode");

        let response = payload
            .into_domain()
            .expect("the decoded usage payload should be valid");

        assert!(matches!(
            response.rate_limits.rate_limit_reached_type,
            Some(RateLimitReachedType::WorkspaceMemberUsageLimitReached)
        ));
    }

    #[test]
    fn normalizes_reset_timestamps_to_unix_milliseconds() {
        let payload = serde_json::from_str::<UsagePayload>(
            r#"{
                "plan_type": "pro",
                "rate_limit": {
                    "primary_window": {
                        "used_percent": 100,
                        "limit_window_seconds": 300,
                        "reset_at": 1734000000
                    },
                    "secondary_window": {
                        "used_percent": 50,
                        "limit_window_seconds": 604800,
                        "reset_at": 1734000000000
                    }
                },
                "spend_control": {
                    "reached": false,
                    "individual_limit": {
                        "limit": "100",
                        "used": "25",
                        "remaining_percent": 75,
                        "reset_at": 1735000000
                    }
                }
            }"#,
        )
        .expect("the usage payload should decode");

        let response = payload
            .into_domain()
            .expect("the decoded usage payload should be valid");
        let primary = response
            .rate_limits
            .primary
            .expect("a primary window must be present");
        let secondary = response
            .rate_limits
            .secondary
            .expect("a secondary window must be present");
        let individual_limit = response
            .rate_limits
            .individual_limit
            .expect("an individual spend limit must be present");

        assert_eq!(primary.resets_at, Some(1_734_000_000_000));
        assert_eq!(secondary.resets_at, Some(1_734_000_000_000));
        assert_eq!(individual_limit.resets_at, 1_735_000_000_000);
    }

    #[test]
    fn decodes_available_usage_resets_with_iso_expiration() {
        let payload = serde_json::from_str::<UsageResetCreditsWire>(
            r#"{
                "credits": [{
                    "id": "reset-1",
                    "title": "Full reset",
                    "status": "available",
                    "expires_at": "2026-09-20T21:16:00-03:00"
                }],
                "available_count": 1,
                "immediate_reset_purchase_eligible": true
            }"#,
        )
        .expect("usage reset payload should decode");

        let response = payload
            .into_domain()
            .expect("usage reset payload should validate");

        assert_eq!(response.available_count, 1);
        assert!(response.immediate_reset_purchase_eligible);
        assert_eq!(response.credits[0].id, "reset-1");
        assert_eq!(response.credits[0].expires_at, Some(1_789_949_760_000));
    }

    #[test]
    fn preserves_idempotent_usage_reset_result() {
        let payload = serde_json::from_str::<UsageResetConsumeWire>(
            r#"{"code":"already_redeemed","credit":{"id":"reset-1"}}"#,
        )
        .expect("redemption payload should decode");

        let response = payload
            .into_domain(Some("requested-reset"))
            .expect("redemption payload should validate");

        assert_eq!(response.code, "already_redeemed");
        assert_eq!(response.credit_id.as_deref(), Some("reset-1"));
    }

    #[test]
    fn exposes_auto_top_up_state_and_discount_policy() {
        let payload = serde_json::from_str::<AutoTopUpSettingsWire>(
            r#"{
                "is_enabled": true,
                "payment_method": {"id":"pm-1"},
                "recharge_threshold": "125",
                "recharge_target": "250",
                "recharge_monthly_limit": "1000",
                "auto_reload_credit_discount_policy": "volume_discount_with_auto_reload_incentive_v1"
            }"#,
        )
        .expect("auto top up payload should decode");

        let settings = payload
            .into_domain(None)
            .expect("auto top up payload should validate");

        assert!(settings.is_enabled);
        assert!(settings.has_payment_method);
        assert_eq!(settings.maximum_discount_percent, Some(40));
        assert_eq!(settings.recharge_monthly_limit.as_deref(), Some("1000"));
    }

    #[test]
    fn decodes_localized_monthly_plan_price() {
        let payload = serde_json::from_str::<CheckoutPricingConfigWire>(
            r#"{
                "currency_config": {
                    "symbol_code": "BRL",
                    "minor_unit_exponent": 2,
                    "pro": {"month": {"amount": 52500}}
                }
            }"#,
        )
        .expect("pricing payload should decode");

        let price = payload
            .into_plan_price(AccountPlanTypeWire::Pro)
            .expect("pricing payload should validate")
            .expect("Pro price should exist");

        assert_eq!(price.amount, 52_500);
        assert_eq!(price.currency, "BRL");
        assert_eq!(price.minor_unit_exponent, 2);
    }
}
