export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export interface CommandError {
  code: string;
  message: string;
}

export type RuntimeState = "failed" | "ready" | "starting" | "stopped";

export interface RuntimeStatus {
  state: RuntimeState;
  message: string | null;
}

export type EngineKind = "compatibility" | "native";

export interface EngineDescriptor {
  id: string;
  name: string;
  kind: EngineKind;
  provider: string;
  auth: string;
  capabilities: string[];
  usesCompatibilityBridge: boolean;
}

export interface RuntimeStartResponse {
  engine: EngineDescriptor;
  executable: string | null;
  transport: string;
  initialize: JsonObject;
  compatibility: CompatibilityStatus;
}

export interface CompatibilityStatus {
  available: boolean;
  executable: string | null;
  reason: string | null;
}

export interface RuntimeDiagnostic {
  stream: "stderr" | "stdout";
  message: string;
}

export interface CodexNotification {
  method: string;
  params: JsonValue;
}

export interface CodexServerRequest {
  id: JsonValue;
  method: string;
  params: JsonValue;
}

export interface ChatGptAccount {
  type: "chatgpt";
  email: string | null;
  planType: string | null;
}

export interface ApiKeyAccount {
  type: "apiKey";
}

export interface OtherAccount {
  type: string;
  email?: string | null;
  planType?: string | null;
}

export type CodexAccount = ApiKeyAccount | ChatGptAccount | OtherAccount;

export interface AccountReadResponse {
  account: CodexAccount | null;
  requiresOpenaiAuth: boolean;
  refresh?: AuthRefreshResult;
}

export type AuthRefreshStatus =
  | "failed"
  | "notRequired"
  | "succeeded"
  | "superseded";

export interface AuthRefreshResult {
  status: AuthRefreshStatus;
  error: string | null;
}

export interface LoginChatGptResponse {
  type: "chatgpt";
  loginId: string;
  authUrl: string;
}

export interface CancelLoginRequest {
  loginId: string;
}

export interface CancelLoginResponse {
  status: "canceled" | "notFound";
}

export interface NativeLogoutResponse {
  localCredentialsRemoved: boolean;
  remoteRevocation: "failed" | "notApplicable" | "succeeded";
  remoteRevocationError: string | null;
}

export type ThreadActiveFlag = "waitingOnApproval" | "waitingOnUserInput";

export type ThreadStatus =
  | { type: "active"; activeFlags: ThreadActiveFlag[] }
  | { type: "idle" | "notLoaded" | "systemError" };

export type TurnStatus = "completed" | "failed" | "inProgress" | "interrupted";

export interface ThreadTurn {
  id: string;
  items: JsonValue[];
  status: TurnStatus;
}

export interface CodexThread {
  id: string;
  preview: string;
  name: string | null;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  recencyAt: number | null;
  status: ThreadStatus;
  turns: ThreadTurn[];
}

export interface ThreadStartResponse {
  thread: CodexThread;
}

export interface ThreadListRequest {
  cursor: string | null;
}

export interface ThreadListResponse {
  data: CodexThread[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}

export interface ThreadResumeRequest {
  threadId: string;
}

export interface ThreadResumeResponse {
  thread: CodexThread;
  cwd: string;
}

export interface ThreadSetNameRequest {
  threadId: string;
  name: string;
}

export interface ThreadArchiveRequest {
  threadId: string;
}

export interface TurnSummary {
  id: string;
  status: string;
  items?: JsonValue[];
  error?: JsonValue;
}

export interface TurnStartResponse {
  turn: TurnSummary;
}

export interface ConfigReadResponse {
  config: JsonObject;
  layers: ConfigLayer[] | null;
  origins: Record<string, ConfigLayerMetadata>;
}

export type ConfigLayerSource =
  | { type: "enterpriseManaged"; id: string; name: string }
  | { type: "legacyManagedConfigTomlFromFile"; file: string }
  | { type: "legacyManagedConfigTomlFromMdm" }
  | { type: "mdm"; domain: string; key: string }
  | { type: "project"; dotCodexFolder: string }
  | { type: "sessionFlags" }
  | { type: "system"; file: string }
  | { type: "user"; file: string; profile: string | null };

export interface ConfigLayerMetadata {
  name: ConfigLayerSource;
  version: string;
}

export interface ConfigLayer extends ConfigLayerMetadata {
  config: JsonValue;
  disabledReason: string | null;
}

export type ApprovalPolicy = "never" | "on-request" | "untrusted";
export interface GranularApprovalPolicy {
  granular: {
    mcp_elicitations: boolean;
    request_permissions: boolean;
    rules: boolean;
    sandbox_approval: boolean;
    skill_approval: boolean;
  };
}
export type AskForApproval = ApprovalPolicy | GranularApprovalPolicy;
export type SandboxMode = "danger-full-access" | "read-only" | "workspace-write";
export type WebSearchMode = "cached" | "disabled" | "indexed" | "live";

export interface NewThreadModelDefaults {
  model: string | null;
  modelReasoningEffort: string | null;
  serviceTier: string | null;
}

export interface ConfigRequirements {
  allowedApprovalPolicies: AskForApproval[] | null;
  allowedSandboxModes: SandboxMode[] | null;
  allowedWebSearchModes: WebSearchMode[] | null;
  models: { newThread: NewThreadModelDefaults | null } | null;
}

export interface ConfigRequirementsReadResponse {
  requirements: ConfigRequirements | null;
}

export type WindowsSandboxReadiness =
  | "notConfigured"
  | "ready"
  | "updateRequired";

export interface WindowsSandboxReadinessResponse {
  status: WindowsSandboxReadiness;
}

export interface ReasoningEffortOption {
  reasoningEffort: string;
  description: string;
}

export interface ModelServiceTier {
  id: string;
  name: string;
  description: string;
}

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: ReasoningEffortOption[];
  defaultReasoningEffort: string;
  serviceTiers: ModelServiceTier[];
  defaultServiceTier: string | null;
  isDefault: boolean;
}

export interface ModelListResponse {
  data?: CodexModel[];
  models?: CodexModel[];
  nextCursor?: string | null;
}

export type AttachmentKind = "file" | "image";

export interface Attachment {
  id: string;
  name: string;
  path: string;
  kind: AttachmentKind;
  size: number;
  mediaType: string | null;
}

export interface ThreadStartRequest {
  cwd: string;
}

export interface TurnStartRequest {
  threadId: string;
  clientUserMessageId: string;
  text: string;
  attachments: Array<{ path: string }>;
}

export interface TurnInterruptRequest {
  threadId: string;
  turnId: string;
}

export interface ConfigReadRequest {
  includeLayers: boolean;
  cwd: string | null;
}

export interface ConfigEditRequest {
  keyPath: string;
  value: JsonValue;
  mergeStrategy: "replace" | "upsert";
}

export interface ConfigWriteRequest extends ConfigEditRequest {
  expectedVersion?: string | null;
}

export interface ConfigBatchWriteRequest {
  edits: ConfigEditRequest[];
  expectedVersion?: string | null;
}

export interface ServerResponseRequest {
  id: JsonValue;
  response: JsonValue;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isJsonValue(value: unknown): value is JsonValue {
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();

  while (pending.length > 0) {
    const current = pending.pop();
    if (
      current === null
      || typeof current === "boolean"
      || typeof current === "string"
    ) {
      continue;
    }
    if (typeof current === "number") {
      if (Number.isFinite(current)) {
        continue;
      }
      return false;
    }
    if (typeof current !== "object" || seen.has(current)) {
      return false;
    }
    seen.add(current);
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }
    pending.push(...Object.values(current));
  }

  return true;
}

export function readString(
  object: JsonObject | undefined,
  key: string,
): string | undefined {
  const value = object?.[key];
  return typeof value === "string" ? value : undefined;
}
