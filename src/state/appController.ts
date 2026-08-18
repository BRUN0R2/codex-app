import type { Accessor } from "solid-js";

import type {
  AccountRateLimitsResponse,
  AccountReadResponse,
  AppProduct,
  ApprovalDecision,
  Attachment,
  Automation,
  AutomationInput,
  AutomationRun,
  ChatGptMode,
  ChatModelOption,
  CodexModel,
  CodexThread,
  ConfigReadResponse,
  ConfigUpdate,
  ContextUsageItem,
  ConversationMode,
  EngineServerRequest,
  EngineStartResponse,
  ModelReroutedNotification,
  ModelSafetyBufferingUpdatedNotification,
  ModelVerification,
  PlanItem,
  ProjectRecord,
  ReasoningEffort,
  RuntimeDiagnostic,
  RuntimeStatus,
  ThreadSummary,
} from "../contracts/types";
import type { QueuedMessage } from "./messageQueue";
import type { VisibleThreadTurn, VisibleTurnSequence } from "./visibleTurnSequence";

export interface DiagnosticEntry extends RuntimeDiagnostic {
  readonly id: number;
  readonly occurredAt: Date;
}

export interface SendMessageInput {
  readonly text: string;
  readonly attachments: readonly Attachment[];
  readonly model: string | null;
  readonly effort: ReasoningEffort | null;
  readonly serviceTier: string | null;
}

export interface AppController {
  readonly account: Accessor<AccountReadResponse | undefined>;
  readonly activeTurnId: Accessor<string | null>;
  readonly activePlan: Accessor<PlanItem | null>;
  readonly approvals: Accessor<readonly EngineServerRequest[]>;
  readonly archivedThreads: Accessor<readonly ThreadSummary[]>;
  readonly archivedThreadsLoaded: Accessor<boolean>;
  readonly archivedThreadsLoading: Accessor<boolean>;
  readonly archivedThreadsNextCursor: Accessor<string | null>;
  readonly automations: Accessor<readonly Automation[]>;
  readonly automationRuns: Accessor<readonly AutomationRun[]>;
  readonly automationsLoading: Accessor<boolean>;
  readonly busy: Accessor<boolean>;
  readonly config: Accessor<ConfigReadResponse | null>;
  readonly contextUsage: Accessor<ContextUsageItem | null>;
  readonly currentThread: Accessor<CodexThread | null>;
  readonly hasOlderHistory: Accessor<boolean>;
  readonly historyLoading: Accessor<boolean>;
  readonly currentThreadTitle: Accessor<string>;
  readonly product: Accessor<AppProduct>;
  readonly chatGptMode: Accessor<ChatGptMode>;
  readonly chatModels: Accessor<readonly ChatModelOption[]>;
  readonly conversationMode: Accessor<ConversationMode>;
  readonly diagnostics: Accessor<readonly DiagnosticEntry[]>;
  readonly engine: Accessor<EngineStartResponse | null>;
  readonly error: Accessor<string | null>;
  readonly lastTurnFailure: Accessor<string | null>;
  readonly loginPending: Accessor<boolean>;
  readonly models: Accessor<readonly CodexModel[]>;
  readonly modelReroute: Accessor<ModelReroutedNotification["params"] | null>;
  readonly modelVerifications: Accessor<readonly ModelVerification[]>;
  readonly pendingOperations: Accessor<number>;
  readonly pinnedProjectPaths: Accessor<readonly string[]>;
  readonly pinnedThreadIds: Accessor<readonly string[]>;
  readonly persistedTurns: Accessor<readonly VisibleThreadTurn[]>;
  readonly projectSectionExpanded: Accessor<boolean>;
  readonly projects: Accessor<readonly ProjectRecord[]>;
  readonly queuedMessages: Accessor<readonly QueuedMessage[]>;
  readonly rateLimits: Accessor<AccountRateLimitsResponse | null>;
  readonly rateLimitsError: Accessor<string | null>;
  readonly rateLimitsLoading: Accessor<boolean>;
  readonly runtimeStatus: Accessor<RuntimeStatus>;
  readonly signedIn: Accessor<boolean>;
  readonly safetyBuffering: Accessor<ModelSafetyBufferingUpdatedNotification["params"] | null>;
  readonly threads: Accessor<readonly ThreadSummary[]>;
  readonly threadsNextCursor: Accessor<string | null>;
  readonly turnBusy: Accessor<boolean>;
  readonly turns: Accessor<VisibleTurnSequence>;
  readonly unreadAutomationRuns: Accessor<readonly AutomationRun[]>;
  readonly workspace: Accessor<string | null>;
  readonly archiveThread: (threadId: string) => Promise<boolean>;
  readonly cancelLogin: () => Promise<void>;
  readonly chooseWorkspace: () => Promise<string | null>;
  readonly clearError: () => void;
  readonly compactThread: (threadId: string) => Promise<boolean>;
  readonly createAutomation: (input: AutomationInput) => Promise<boolean>;
  readonly deleteAutomation: (automationId: string) => Promise<boolean>;
  readonly deleteThread: (threadId: string) => Promise<boolean>;
  readonly deleteQueuedMessage: (messageId: string) => boolean;
  readonly ensureModelsForMode: (mode: ConversationMode) => Promise<boolean>;
  readonly enqueueMessage: (input: SendMessageInput) => boolean;
  readonly forkThread: (threadId: string) => Promise<boolean>;
  readonly inspectFiles: (paths: readonly string[]) => Promise<readonly Attachment[]>;
  readonly interrupt: () => Promise<boolean>;
  readonly projectExpanded: (path: string) => boolean;
  readonly projectThreadListExpanded: (path: string) => boolean;
  readonly isThreadActive: (threadId: string) => boolean;
  readonly loadMoreThreads: () => Promise<boolean>;
  readonly loadMoreArchivedThreads: () => Promise<boolean>;
  readonly loadOlderHistory: () => Promise<boolean>;
  readonly login: () => Promise<boolean>;
  readonly logout: () => Promise<boolean>;
  readonly markAutomationRunReviewed: (runId: string) => Promise<boolean>;
  readonly newThread: (workspace?: string) => boolean;
  readonly openThread: (threadId: string) => Promise<boolean>;
  readonly refreshAutomations: () => Promise<boolean>;
  readonly refreshAccountProfile: () => Promise<boolean>;
  readonly refreshRateLimits: () => Promise<boolean>;
  readonly refreshRateLimitsIfStale: () => Promise<boolean>;
  readonly reportError: (reason: unknown) => void;
  readonly removeProject: (path: string) => void;
  readonly renameThread: (threadId: string, name: string) => Promise<boolean>;
  readonly retryInitialization: () => void;
  readonly respondToApproval: (requestId: string, decision: ApprovalDecision) => Promise<boolean>;
  readonly runAutomationNow: (automationId: string) => Promise<boolean>;
  readonly saveClipboardImage: (dataBase64: string) => Promise<Attachment | null>;
  readonly selectProject: (path: string) => boolean;
  readonly selectProduct: (product: AppProduct) => Promise<boolean>;
  readonly selectChatGptMode: (mode: ChatGptMode) => Promise<boolean>;
  readonly sendMessage: (input: SendMessageInput) => Promise<boolean>;
  readonly sendQueuedMessageNow: (messageId?: string) => Promise<boolean>;
  readonly takeQueuedMessage: (messageId: string) => QueuedMessage | null;
  readonly togglePinnedThread: (threadId: string) => void;
  readonly togglePinnedProject: (path: string) => void;
  readonly toggleProjectExpanded: (path: string) => void;
  readonly toggleProjectSection: () => void;
  readonly toggleProjectThreadListExpanded: (path: string) => void;
  readonly updateProject: (
    path: string,
    updates: Partial<Pick<ProjectRecord, "color" | "icon" | "name">>,
  ) => void;
  readonly updateAutomation: (
    automationId: string,
    expectedVersion: number,
    input: AutomationInput,
  ) => Promise<boolean>;
  readonly updateSetting: (update: ConfigUpdate) => Promise<boolean>;
  readonly unarchiveThread: (threadId: string) => Promise<boolean>;
}
