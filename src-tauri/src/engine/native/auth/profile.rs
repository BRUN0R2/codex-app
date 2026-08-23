use std::collections::BTreeMap;

use chrono::NaiveDate;
use serde::Deserialize;
use serde::Serialize;

use super::error::AuthError;
use super::token::MAX_PROFILE_NAME_BYTES;
use super::token::clean_profile_picture;
use super::token::clean_profile_text;
use crate::engine::ReasoningEffort;

const MAX_DAILY_USAGE_BUCKETS: usize = 800;
const MAX_INVOCATIONS: usize = 100;
const MAX_INVOCATION_ID_BYTES: usize = 256;
const MAX_INVOCATION_NAME_BYTES: usize = 256;
const MAX_PROFILE_USERNAME_BYTES: usize = 64;

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountProfileResponse {
    pub display_name: Option<String>,
    pub username: Option<String>,
    pub picture: Option<String>,
    pub statistics_status: AccountProfileStatisticsStatus,
    pub summary: AccountProfileSummary,
    pub daily_usage: Option<Vec<AccountProfileDailyUsage>>,
    pub activity_insights: AccountProfileActivityInsights,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AccountProfileStatisticsStatus {
    Available,
    Unavailable,
}

#[derive(Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountProfileSummary {
    pub lifetime_tokens: Option<u64>,
    pub peak_daily_tokens: Option<u64>,
    pub longest_running_turn_seconds: Option<u64>,
    pub current_streak_days: Option<u32>,
    pub longest_streak_days: Option<u32>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountProfileDailyUsage {
    pub date: NaiveDate,
    pub tokens: u64,
}

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountProfileActivityInsights {
    pub fast_mode_percent: Option<f64>,
    pub most_used_reasoning_effort: Option<ReasoningEffort>,
    pub most_used_reasoning_effort_percent: Option<f64>,
    pub unique_skills_used: Option<u64>,
    pub total_skills_used: Option<u64>,
    pub total_threads: Option<u64>,
    pub top_invocations: Option<Vec<AccountProfileInvocation>>,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum AccountProfileInvocation {
    Plugin {
        id: Option<String>,
        name: String,
        usage_count: u64,
    },
    Skill {
        id: Option<String>,
        name: String,
        plugin_name: Option<String>,
        usage_count: u64,
    },
}

#[derive(Default, Deserialize)]
pub(super) struct ChatGptProfileResponse {
    #[serde(default)]
    profile: Option<ChatGptProfileWire>,
    #[serde(default)]
    stats: ChatGptProfileStatsWire,
    #[serde(default)]
    metadata: ChatGptProfileMetadataWire,
}

#[derive(Default, Deserialize)]
struct ChatGptProfileWire {
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    profile_picture_url: Option<String>,
}

#[derive(Default, Deserialize)]
struct ChatGptProfileStatsWire {
    #[serde(default)]
    lifetime_tokens: Option<u64>,
    #[serde(default)]
    peak_daily_tokens: Option<u64>,
    #[serde(default)]
    longest_running_turn_sec: Option<u64>,
    #[serde(default)]
    current_streak_days: Option<u32>,
    #[serde(default)]
    longest_streak_days: Option<u32>,
    #[serde(default)]
    daily_usage_buckets: Option<Vec<AccountProfileDailyUsageWire>>,
    #[serde(default)]
    fast_mode_usage_percentage: Option<f64>,
    #[serde(default)]
    most_used_reasoning_effort: Option<ReasoningEffort>,
    #[serde(default)]
    most_used_reasoning_effort_percentage: Option<f64>,
    #[serde(default)]
    unique_skills_used: Option<u64>,
    #[serde(default)]
    total_skills_used: Option<u64>,
    #[serde(default)]
    total_threads: Option<u64>,
    #[serde(default)]
    top_invocations: Option<Vec<AccountProfileInvocationWire>>,
}

#[derive(Deserialize)]
struct AccountProfileDailyUsageWire {
    start_date: String,
    tokens: u64,
}

#[derive(Deserialize)]
struct AccountProfileInvocationWire {
    #[serde(rename = "type")]
    kind: AccountProfileInvocationKindWire,
    #[serde(default)]
    plugin_id: Option<String>,
    #[serde(default)]
    plugin_name: Option<String>,
    #[serde(default)]
    skill_id: Option<String>,
    #[serde(default)]
    skill_name: Option<String>,
    #[serde(default)]
    usage_count: Option<u64>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum AccountProfileInvocationKindWire {
    Plugin,
    Skill,
}

#[derive(Default, Deserialize)]
struct ChatGptProfileMetadataWire {
    #[serde(default)]
    stats_error: Option<String>,
}

impl TryFrom<ChatGptProfileResponse> for AccountProfileResponse {
    type Error = AuthError;

    fn try_from(response: ChatGptProfileResponse) -> Result<Self, Self::Error> {
        let profile = response.profile.unwrap_or_default();
        let stats = response.stats;
        Ok(Self {
            display_name: clean_profile_text(profile.display_name, MAX_PROFILE_NAME_BYTES),
            username: clean_profile_text(profile.username, MAX_PROFILE_USERNAME_BYTES),
            picture: clean_profile_picture(profile.profile_picture_url),
            statistics_status: if response
                .metadata
                .stats_error
                .as_deref()
                .is_some_and(|error| !error.trim().is_empty())
            {
                AccountProfileStatisticsStatus::Unavailable
            } else {
                AccountProfileStatisticsStatus::Available
            },
            summary: AccountProfileSummary {
                lifetime_tokens: stats.lifetime_tokens,
                peak_daily_tokens: stats.peak_daily_tokens,
                longest_running_turn_seconds: stats.longest_running_turn_sec,
                current_streak_days: stats.current_streak_days,
                longest_streak_days: stats.longest_streak_days,
            },
            daily_usage: normalize_daily_usage(stats.daily_usage_buckets)?,
            activity_insights: AccountProfileActivityInsights {
                fast_mode_percent: validate_percentage(
                    "fast_mode_usage_percentage",
                    stats.fast_mode_usage_percentage,
                )?,
                most_used_reasoning_effort: stats.most_used_reasoning_effort,
                most_used_reasoning_effort_percent: validate_percentage(
                    "most_used_reasoning_effort_percentage",
                    stats.most_used_reasoning_effort_percentage,
                )?,
                unique_skills_used: stats.unique_skills_used,
                total_skills_used: stats.total_skills_used,
                total_threads: stats.total_threads,
                top_invocations: normalize_invocations(stats.top_invocations)?,
            },
        })
    }
}

fn normalize_daily_usage(
    buckets: Option<Vec<AccountProfileDailyUsageWire>>,
) -> Result<Option<Vec<AccountProfileDailyUsage>>, AuthError> {
    let Some(buckets) = buckets else {
        return Ok(None);
    };
    if buckets.len() > MAX_DAILY_USAGE_BUCKETS {
        return Err(profile_contract_error(format!(
            "daily usage contains {} buckets; maximum is {MAX_DAILY_USAGE_BUCKETS}",
            buckets.len()
        )));
    }
    let mut by_date = BTreeMap::<NaiveDate, u64>::new();
    for bucket in buckets {
        let date = NaiveDate::parse_from_str(&bucket.start_date, "%Y-%m-%d").map_err(|error| {
            profile_contract_error(format!(
                "daily usage date {:?} is invalid: {error}",
                bucket.start_date
            ))
        })?;
        let total = by_date.entry(date).or_default();
        *total = total.checked_add(bucket.tokens).ok_or_else(|| {
            profile_contract_error(format!("daily usage token total overflowed for {date}"))
        })?;
    }
    Ok(Some(
        by_date
            .into_iter()
            .map(|(date, tokens)| AccountProfileDailyUsage { date, tokens })
            .collect(),
    ))
}

fn normalize_invocations(
    invocations: Option<Vec<AccountProfileInvocationWire>>,
) -> Result<Option<Vec<AccountProfileInvocation>>, AuthError> {
    let Some(invocations) = invocations else {
        return Ok(None);
    };
    if invocations.len() > MAX_INVOCATIONS {
        return Err(profile_contract_error(format!(
            "activity insights contain {} invocations; maximum is {MAX_INVOCATIONS}",
            invocations.len()
        )));
    }
    Ok(Some(
        invocations
            .into_iter()
            .filter_map(AccountProfileInvocation::from_wire)
            .collect(),
    ))
}

impl AccountProfileInvocation {
    fn from_wire(wire: AccountProfileInvocationWire) -> Option<Self> {
        let usage_count = wire.usage_count?;
        match wire.kind {
            AccountProfileInvocationKindWire::Plugin => Some(Self::Plugin {
                id: clean_profile_text(wire.plugin_id, MAX_INVOCATION_ID_BYTES),
                name: clean_profile_text(wire.plugin_name, MAX_INVOCATION_NAME_BYTES)?,
                usage_count,
            }),
            AccountProfileInvocationKindWire::Skill => Some(Self::Skill {
                id: clean_profile_text(wire.skill_id, MAX_INVOCATION_ID_BYTES),
                name: clean_profile_text(wire.skill_name, MAX_INVOCATION_NAME_BYTES)?,
                plugin_name: clean_profile_text(wire.plugin_name, MAX_INVOCATION_NAME_BYTES),
                usage_count,
            }),
        }
    }
}

fn validate_percentage(label: &str, value: Option<f64>) -> Result<Option<f64>, AuthError> {
    if value.is_some_and(|percentage| !(0.0..=100.0).contains(&percentage)) {
        return Err(profile_contract_error(format!(
            "{label} must be between 0 and 100"
        )));
    }
    Ok(value)
}

fn profile_contract_error(message: impl Into<String>) -> AuthError {
    AuthError::OAuth(format!(
        "ChatGPT profile response is invalid: {}",
        message.into()
    ))
}

#[cfg(test)]
mod tests {
    use super::{
        AccountProfileActivityInsights, AccountProfileDailyUsageWire, AccountProfileInvocation,
        AccountProfileInvocationKindWire, AccountProfileInvocationWire,
        AccountProfileStatisticsStatus, ChatGptProfileMetadataWire, ChatGptProfileResponse,
        ChatGptProfileStatsWire, ChatGptProfileWire,
    };
    use crate::engine::ReasoningEffort;

    #[test]
    fn normalizes_the_official_profile_contract() {
        let profile = super::AccountProfileResponse::try_from(ChatGptProfileResponse {
            profile: Some(ChatGptProfileWire {
                display_name: Some(" Ada ".into()),
                username: Some(" ada.dev ".into()),
                profile_picture_url: Some("https://images.example.com/ada.png".into()),
            }),
            stats: ChatGptProfileStatsWire {
                lifetime_tokens: Some(9_000_000_000),
                peak_daily_tokens: Some(671_100_000),
                longest_running_turn_sec: Some(28_020),
                current_streak_days: Some(7),
                longest_streak_days: Some(20),
                daily_usage_buckets: Some(vec![
                    AccountProfileDailyUsageWire {
                        start_date: "2026-08-22".into(),
                        tokens: 10,
                    },
                    AccountProfileDailyUsageWire {
                        start_date: "2026-08-22".into(),
                        tokens: 5,
                    },
                ]),
                fast_mode_usage_percentage: Some(2.0),
                most_used_reasoning_effort: Some(ReasoningEffort::Max),
                most_used_reasoning_effort_percentage: Some(76.0),
                unique_skills_used: Some(1),
                total_skills_used: Some(1),
                total_threads: Some(660),
                top_invocations: Some(vec![
                    AccountProfileInvocationWire {
                        kind: AccountProfileInvocationKindWire::Plugin,
                        plugin_id: Some("test-android-apps".into()),
                        plugin_name: Some("@test-android-apps".into()),
                        skill_id: None,
                        skill_name: None,
                        usage_count: Some(1),
                    },
                    AccountProfileInvocationWire {
                        kind: AccountProfileInvocationKindWire::Skill,
                        plugin_id: None,
                        plugin_name: Some("@test-android-apps".into()),
                        skill_id: Some("skill-1".into()),
                        skill_name: Some("@test-android-apps:inspect".into()),
                        usage_count: Some(2),
                    },
                ]),
            },
            metadata: ChatGptProfileMetadataWire::default(),
        })
        .expect("the official profile shape should normalize");

        assert_eq!(profile.display_name.as_deref(), Some("Ada"));
        assert_eq!(profile.username.as_deref(), Some("ada.dev"));
        assert_eq!(
            profile.statistics_status,
            AccountProfileStatisticsStatus::Available
        );
        assert_eq!(
            profile.daily_usage.as_deref().map(|usage| usage[0].tokens),
            Some(15)
        );
        assert!(matches!(
            profile
                .activity_insights
                .top_invocations
                .as_deref()
                .and_then(|items| items.first()),
            Some(AccountProfileInvocation::Plugin {
                name,
                usage_count: 1,
                ..
            }) if name == "@test-android-apps"
        ));
    }

    #[test]
    fn serializes_invocation_fields_in_camel_case() {
        let serialized = serde_json::to_value(AccountProfileActivityInsights {
            top_invocations: Some(vec![
                AccountProfileInvocation::Plugin {
                    id: Some("plugin-1".into()),
                    name: "@plugin".into(),
                    usage_count: 3,
                },
                AccountProfileInvocation::Skill {
                    id: Some("skill-1".into()),
                    name: "@plugin:inspect".into(),
                    plugin_name: Some("@plugin".into()),
                    usage_count: 5,
                },
            ]),
            ..AccountProfileActivityInsights::default()
        })
        .expect("profile activity should serialize");

        assert_eq!(
            serialized["topInvocations"],
            serde_json::json!([
                {
                    "type": "plugin",
                    "id": "plugin-1",
                    "name": "@plugin",
                    "usageCount": 3
                },
                {
                    "type": "skill",
                    "id": "skill-1",
                    "name": "@plugin:inspect",
                    "pluginName": "@plugin",
                    "usageCount": 5
                }
            ])
        );
    }

    #[test]
    fn preserves_identity_when_statistics_are_unavailable() {
        let profile = super::AccountProfileResponse::try_from(ChatGptProfileResponse {
            profile: Some(ChatGptProfileWire {
                display_name: Some("Ada".into()),
                ..ChatGptProfileWire::default()
            }),
            metadata: ChatGptProfileMetadataWire {
                stats_error: Some("statistics backend unavailable".into()),
            },
            ..ChatGptProfileResponse::default()
        })
        .expect("statistics failure should not discard profile identity");

        assert_eq!(profile.display_name.as_deref(), Some("Ada"));
        assert_eq!(
            profile.statistics_status,
            AccountProfileStatisticsStatus::Unavailable
        );
    }

    #[test]
    fn rejects_invalid_dates_and_percentages() {
        for stats in [
            ChatGptProfileStatsWire {
                daily_usage_buckets: Some(vec![AccountProfileDailyUsageWire {
                    start_date: "2026-02-30".into(),
                    tokens: 1,
                }]),
                ..ChatGptProfileStatsWire::default()
            },
            ChatGptProfileStatsWire {
                fast_mode_usage_percentage: Some(100.1),
                ..ChatGptProfileStatsWire::default()
            },
        ] {
            let error = super::AccountProfileResponse::try_from(ChatGptProfileResponse {
                stats,
                ..ChatGptProfileResponse::default()
            })
            .expect_err("invalid statistics should fail visibly");
            assert!(error.to_string().contains("profile response is invalid"));
        }
    }
}
