//! Golden contract fixtures shared with the TypeScript boundary decoders.
//!
//! The committed JSON files under `src/contracts/fixtures/` are produced by these
//! constructors. `cargo test` fails when the Rust contract changes without
//! regenerating them, and the frontend decoder tests fail when the two halves
//! drift apart. Regenerate intentionally with:
//! `cargo test -p codex-desktop-next regenerate_golden_contract_fixtures -- --ignored`.

use std::fs;
use std::path::PathBuf;

use super::contracts::*;

const FIXTURE_DIRECTORY: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/contracts/fixtures");

pub(super) fn render_engine_start() -> String {
    serde_json::to_string_pretty(&engine_start_fixture()).expect("engine start should serialize")
}

pub(super) fn render_notifications() -> String {
    let notifications: Vec<_> = notification_fixtures()
        .into_iter()
        .chain(thread_item_fixtures())
        .collect();
    serde_json::to_string_pretty(&notifications).expect("notifications should serialize")
}

fn engine_start_fixture() -> EngineStartResponse {
    EngineStartResponse {
        engine: EngineDescriptor {
            id: "native-engine",
            name: "Native Engine",
            provider: "ChatGPT Codex",
            auth: "ChatGPT OAuth",
            transport: EngineTransport::HttpsSse,
            storage: EngineStorage::Sqlite,
            capabilities: vec![
                EngineCapability::ChatGptOauth,
                EngineCapability::LocalThreads,
                EngineCapability::ModelStreaming,
                EngineCapability::NativeTools,
                EngineCapability::ExplicitApprovals,
                EngineCapability::ScheduledAutomations,
            ],
        },
        schema_version: super::native::CONTRACT_SCHEMA_VERSION,
        diagnostic_log_path: "C:\\appdata\\logs\\runtime.jsonl".into(),
        config: config_fixture(),
        permission_profiles: vec![
            PermissionProfile::read_only(),
            PermissionProfile::workspace_write(),
            PermissionProfile::full_access(),
        ],
    }
}

fn config_fixture() -> ConfigReadResponse {
    ConfigReadResponse {
        config: AppConfig {
            model: Some("gpt-5.6-codex".into()),
            model_reasoning_effort: Some(ReasoningEffort::Medium),
            service_tier: Some("priority".into()),
            model_context_window_preferences: std::collections::BTreeMap::from([(
                "gpt-5.6-codex".into(),
                ModelContextWindowPreference::Maximum,
            )]),
            permission_profile: PermissionProfile::workspace_write(),
            web_search: WebSearchMode::Live,
            model_verbosity: Some(ModelVerbosity::Medium),
            personality: Personality::Pragmatic,
            developer_instructions: Some("Keep answers bounded.".into()),
            desktop: DesktopPreferences {
                ui_font_size: 15,
                motion: MotionPreference::Full,
                pointer_cursor: true,
                diff_display: DiffDisplay::Unified,
            },
        },
        version: 3,
    }
}

fn thread_summary_fixture() -> ThreadSummary {
    ThreadSummary {
        id: "0192b4f0-0000-7000-8000-000000000001".into(),
        mode: ConversationMode::Work,
        preview: "Fix the failing build".into(),
        name: Some("Build fix".into()),
        cwd: "C:\\workspace\\codex-app".into(),
        project_path: Some("C:\\workspace\\codex-app".into()),
        created_at: 1_755_000_000,
        updated_at: 1_755_000_900,
        recency_at: Some(1_755_000_900),
        status: ThreadStatus::Active {
            active_flags: vec![ThreadActiveFlag::WaitingOnApproval],
        },
    }
}

fn turn_summary_fixture() -> TurnSummary {
    TurnSummary {
        id: "0192b4f0-0000-7000-8000-000000000002".into(),
        status: TurnStatus::Completed,
        created_at: 1_755_000_100,
        updated_at: 1_755_000_800,
    }
}

fn notification_fixtures() -> Vec<EngineNotification> {
    vec![
        EngineNotification::AuthLoginCompleted(AuthLoginCompleted {
            login_id: "login-1".into(),
            success: true,
            error: None,
        }),
        EngineNotification::AuthSessionChanged(AuthSessionChanged { signed_in: true }),
        EngineNotification::AccountRateLimitsUpdated(AccountRateLimitsUpdatedNotification {
            rate_limits: RateLimitSnapshot {
                limit_id: Some("codex".into()),
                limit_name: None,
                primary: Some(RateLimitWindow {
                    used_percent: 25.5,
                    window_duration_mins: Some(300),
                    resets_at: Some(1_755_000_000_000),
                }),
                secondary: None,
                credits: Some(CreditsSnapshot {
                    has_credits: true,
                    unlimited: false,
                    balance: Some("12.50".into()),
                }),
                individual_limit: None,
                spend_control_reached: None,
                plan_type: Some(AccountPlanType::Pro),
                rate_limit_reached_type: None,
            },
        }),
        EngineNotification::ThreadCreated(ThreadNotification {
            thread: thread_summary_fixture(),
        }),
        EngineNotification::ThreadUpdated(ThreadNotification {
            thread: ThreadSummary {
                status: ThreadStatus::Idle,
                ..thread_summary_fixture()
            },
        }),
        EngineNotification::ThreadArchived(ThreadArchivedNotification {
            thread_id: "thread-1".into(),
        }),
        EngineNotification::ThreadUnarchived(ThreadUnarchivedNotification {
            thread_id: "thread-1".into(),
        }),
        EngineNotification::ThreadDeleted(ThreadDeletedNotification {
            thread_id: "thread-1".into(),
        }),
        EngineNotification::TurnStarted(TurnNotification {
            thread_id: "thread-1".into(),
            turn: TurnSummary {
                status: TurnStatus::InProgress,
                ..turn_summary_fixture()
            },
        }),
        EngineNotification::TurnCompleted(TurnCompletedNotification {
            thread_id: "thread-1".into(),
            turn: CompletedTurn {
                id: "turn-1".into(),
                status: TurnStatus::Failed,
                error: Some("provider rejected the request".into()),
                updated_at: 1_755_000_800,
            },
            error: Some(OperationFailure {
                code: "PROVIDER",
                message: "provider rejected the request".into(),
            }),
        }),
        EngineNotification::StreamDeltas(StreamDeltasNotification {
            thread_id: "thread-1".into(),
            turn_id: "turn-1".into(),
            deltas: vec![
                StreamDelta::AgentText {
                    item_id: "item-1".into(),
                    delta: "Olá".into(),
                },
                StreamDelta::ReasoningSummary {
                    item_id: "item-2".into(),
                    index: 0,
                    delta: "planejando".into(),
                },
                StreamDelta::ReasoningText {
                    item_id: "item-2".into(),
                    index: 1,
                    delta: "detalhe".into(),
                },
                StreamDelta::CommandOutput {
                    item_id: "item-command".into(),
                    stream: CommandOutputStream::Stdout,
                    operation: CommandOutputOperation::Append {
                        delta: "transforming...\n".into(),
                    },
                },
                StreamDelta::CommandOutput {
                    item_id: "item-command".into(),
                    stream: CommandOutputStream::Stderr,
                    operation: CommandOutputOperation::ClearCurrentLine,
                },
            ],
        }),
        EngineNotification::ModelRerouted(ModelReroutedNotification {
            thread_id: "thread-1".into(),
            turn_id: "turn-1".into(),
            from_model: "gpt-5.6-codex".into(),
            to_model: "gpt-5.6".into(),
            reason: ModelRerouteReason::HighRiskCyberActivity,
        }),
        EngineNotification::ModelVerification(ModelVerificationNotification {
            thread_id: "thread-1".into(),
            turn_id: "turn-1".into(),
            verifications: vec![ModelVerification::TrustedAccessForCyber],
        }),
        EngineNotification::ModelSafetyBufferingUpdated(ModelSafetyBufferingUpdatedNotification {
            thread_id: "thread-1".into(),
            turn_id: "turn-1".into(),
            model: "gpt-5.6".into(),
            use_cases: vec!["cyber".into()],
            reasons: vec!["untrusted_access".into()],
            show_buffering_ui: true,
            faster_model: Some("gpt-5.6-mini".into()),
        }),
        EngineNotification::AutomationChanged(AutomationNotification {
            automation: Automation {
                id: "automation-1".into(),
                name: "Revisar regressões".into(),
                prompt: "Revise regressões recentes e proponha correções.".into(),
                project_path: Some("C:\\workspace\\codex-app".into()),
                enabled: true,
                interval_minutes: 60,
                timezone: "America/Sao_Paulo".into(),
                timezone_offset_min: 180,
                next_run_at: Some(1_755_004_500),
                last_run_at: Some(1_755_000_900),
                version: 2,
                created_at: 1_754_900_000,
                updated_at: 1_755_000_900,
            },
        }),
        EngineNotification::AutomationDeleted(AutomationDeletedNotification {
            automation_id: "automation-2".into(),
        }),
        EngineNotification::AutomationRunUpdated(AutomationRunNotification {
            run: AutomationRun {
                id: "automation-run-1".into(),
                automation_id: "automation-1".into(),
                trigger: AutomationRunTrigger::Scheduled,
                status: AutomationRunStatus::Completed,
                thread_id: Some("thread-1".into()),
                turn_id: Some("turn-1".into()),
                error: None,
                reviewed: false,
                created_at: 1_755_000_100,
                started_at: Some(1_755_000_120),
                completed_at: Some(1_755_000_800),
            },
        }),
    ]
}

fn thread_item_fixtures() -> Vec<EngineNotification> {
    let items = vec![
        ThreadItem::ContextUsage {
            id: "item-usage".into(),
            model: "gpt-5.6-codex".into(),
            usage: TokenUsage {
                input_tokens: 164_000,
                cached_input_tokens: 120_000,
                output_tokens: 10_000,
                reasoning_output_tokens: 8_000,
                total_tokens: 174_000,
            },
            context_window: Some(ModelContextWindow {
                tokens: 400_000,
                usable_tokens: 396_000,
                usable_percent: 99,
                maximum_tokens: None,
            }),
        },
        ThreadItem::ContextCompaction {
            id: "item-compaction".into(),
        },
        ThreadItem::UserMessage {
            id: "item-user".into(),
            content: vec![
                UserContent::Text {
                    text: "Explique o diff".into(),
                },
                UserContent::Mention {
                    name: "notes.md".into(),
                    path: "C:\\workspace\\codex-app\\notes.md".into(),
                },
            ],
        },
        ThreadItem::AgentMessage {
            id: "item-agent".into(),
            text: "O diff troca o parser.".into(),
            phase: Some(MessagePhase::FinalAnswer),
        },
        ThreadItem::Reasoning {
            id: "item-reasoning".into(),
            summary: vec!["Resumo".into()],
            content: vec!["Conteúdo".into()],
        },
        ThreadItem::Plan {
            id: "item-plan".into(),
            explanation: Some("Plano do turno".into()),
            steps: vec![PlanStep {
                step: "Corrigir o parser".into(),
                status: PlanStepStatus::Completed,
            }],
        },
        ThreadItem::CommandExecution {
            id: "item-command".into(),
            command: "cargo test".into(),
            cwd: "C:\\workspace\\codex-app".into(),
            process_id: Some("4242".into()),
            started_at: Some(1_755_000_115_200),
            source: CommandSource::Agent,
            status: ActivityStatus::Completed,
            aggregated_output: Some(ThreadOutput {
                id: "output-1".into(),
                preview: "172 passed; 0 failed".into(),
                byte_length: 20,
                next_cursor: None,
            }),
            live_output: None,
            exit_code: Some(0),
            duration_ms: Some(4_800),
        },
        ThreadItem::FileChange {
            id: "item-file-change".into(),
            changes: vec![FileChange {
                path: "src/parser.rs".into(),
                kind: FileChangeKind::Update { move_path: None },
                diff: "--- before\n+++ after".into(),
                line_stats: Some(FileChangeLineStats {
                    additions: 1,
                    deletions: 1,
                }),
            }],
            status: ActivityStatus::Completed,
        },
        ThreadItem::ToolExecution {
            id: "item-tool".into(),
            name: "read_file".into(),
            description: "Read src/parser.rs".into(),
            status: ActivityStatus::Completed,
            output_presentation: ToolOutputPresentation::SourceFile {
                path: "src/parser.rs".into(),
            },
            output: Some(ThreadOutput {
                id: "output-2".into(),
                preview: "1: fn main()".into(),
                byte_length: 12,
                next_cursor: None,
            }),
        },
    ];
    items
        .into_iter()
        .map(|item| {
            EngineNotification::ItemCompleted(ItemNotification {
                thread_id: "thread-1".into(),
                turn_id: "turn-1".into(),
                item,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn golden_contract_fixtures_are_current() {
        let engine_start_path = fixture_path("engine-start.json");
        let notifications_path = fixture_path("notifications.json");
        let committed_start = fs::read_to_string(&engine_start_path)
            .unwrap_or_else(|error| panic!("missing fixture {engine_start_path:?}: {error}"));
        let committed_notifications = fs::read_to_string(&notifications_path)
            .unwrap_or_else(|error| panic!("missing fixture {notifications_path:?}: {error}"));
        assert_eq!(
            committed_start,
            format!("{}\n", render_engine_start()),
            "engine start contract changed; regenerate fixtures with the ignored test"
        );
        assert_eq!(
            committed_notifications,
            format!("{}\n", render_notifications()),
            "notification contract changed; regenerate fixtures with the ignored test"
        );
    }

    #[test]
    #[ignore = "run explicitly to regenerate the golden contract fixtures"]
    fn regenerate_golden_contract_fixtures() {
        fs::create_dir_all(FIXTURE_DIRECTORY).expect("fixture directory should exist");
        fs::write(
            fixture_path("engine-start.json"),
            format!("{}\n", render_engine_start()),
        )
        .expect("engine start fixture should write");
        fs::write(
            fixture_path("notifications.json"),
            format!("{}\n", render_notifications()),
        )
        .expect("notifications fixture should write");
    }

    fn fixture_path(name: &str) -> PathBuf {
        PathBuf::from(FIXTURE_DIRECTORY).join(name)
    }
}
