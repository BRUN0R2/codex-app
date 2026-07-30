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

export interface ThreadSummary {
  id: string;
  preview?: string;
  name?: string | null;
  createdAt?: number;
  updatedAt?: number;
}

export interface ThreadStartResponse {
  thread: ThreadSummary;
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
  layers?: JsonValue[];
  origins?: JsonObject;
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

export interface ConfigWriteRequest {
  keyPath: string;
  value: JsonValue;
  mergeStrategy: "replace" | "upsert";
}

export type ConfigEditRequest = ConfigWriteRequest;

export interface ConfigBatchWriteRequest {
  edits: ConfigEditRequest[];
}

export interface ServerResponseRequest {
  id: JsonValue;
  response: JsonValue;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readString(
  object: JsonObject | undefined,
  key: string,
): string | undefined {
  const value = object?.[key];
  return typeof value === "string" ? value : undefined;
}
