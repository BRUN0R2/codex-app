import type { JsonObject, JsonValue } from "../../shared/codex/types";
import type {
  GrantedPermissionProfile,
  PermissionGrantScope,
  PermissionProfile,
} from "./permissionTypes";

export type ServerRequestId = number | string;

export interface CommandAction {
  command: string;
  type: "listFiles" | "read" | "search" | "unknown";
  name: string | null;
  path: string | null;
  query: string | null;
}

export type CommandApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "cancel"
  | "decline"
  | {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: string[];
      };
    }
  | {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: {
          action: "allow" | "deny";
          host: string;
        };
      };
    };

interface ItemRequestBase {
  id: ServerRequestId;
  itemId: string;
  startedAtMs: number;
  threadId: string;
  turnId: string;
}

export interface CommandApprovalRequest extends ItemRequestBase {
  kind: "commandApproval";
  method: "item/commandExecution/requestApproval";
  additionalPermissions: PermissionProfile | null;
  approvalId: string | null;
  availableDecisions: CommandApprovalDecision[] | null;
  command: string | null;
  commandActions: CommandAction[];
  cwd: string | null;
  environmentId: string | null;
  networkApprovalContext: {
    host: string;
    protocol: "http" | "https" | "socks5Tcp" | "socks5Udp";
  } | null;
  proposedExecpolicyAmendment: string[] | null;
  proposedNetworkPolicyAmendments: Array<{
    action: "allow" | "deny";
    host: string;
  }>;
  reason: string | null;
}

export interface FileChangeApprovalRequest extends ItemRequestBase {
  kind: "fileChangeApproval";
  method: "item/fileChange/requestApproval";
  grantRoot: string | null;
  reason: string | null;
}

interface ToolRequestBase {
  id: ServerRequestId;
  itemId: string;
  threadId: string;
  turnId: string;
}

export interface UserInputOption {
  description: string;
  label: string;
}

export interface UserInputQuestion {
  header: string;
  id: string;
  isOther: boolean;
  isSecret: boolean;
  options: UserInputOption[] | null;
  question: string;
}

export interface UserInputRequest extends ToolRequestBase {
  kind: "userInput";
  method: "item/tool/requestUserInput";
  autoResolutionMs: number | null;
  questions: UserInputQuestion[];
}

export interface PermissionsApprovalRequest extends ItemRequestBase {
  kind: "permissionsApproval";
  method: "item/permissions/requestApproval";
  cwd: string;
  environmentId: string | null;
  permissions: PermissionProfile;
  reason: string | null;
}

export type McpFormStringFormat = "date" | "date-time" | "email" | "uri";

interface McpFormFieldBase {
  description: string | null;
  label: string;
  name: string;
  required: boolean;
}

export type McpFormField =
  | (McpFormFieldBase & {
      defaultValue: boolean | null;
      type: "boolean";
    })
  | (McpFormFieldBase & {
      defaultValue: number | null;
      integer: boolean;
      maximum: number | null;
      minimum: number | null;
      type: "number";
    })
  | (McpFormFieldBase & {
      defaultValue: string | null;
      format: McpFormStringFormat | null;
      maximumLength: number | null;
      minimumLength: number | null;
      type: "text";
    })
  | (McpFormFieldBase & {
      defaultValue: string[];
      maximumSelections: number | null;
      minimumSelections: number | null;
      multiple: true;
      options: Array<{ label: string; value: string }>;
      type: "select";
    })
  | (McpFormFieldBase & {
      defaultValue: string | null;
      multiple: false;
      options: Array<{ label: string; value: string }>;
      type: "select";
    });

interface McpRequestBase {
  id: ServerRequestId;
  method: "mcpServer/elicitation/request";
  message: string;
  serverName: string;
  threadId: string;
  turnId: string | null;
}

export interface McpFormRequest extends McpRequestBase {
  kind: "mcpForm";
  fields: McpFormField[];
  isToolApproval: boolean;
  persistModes: Array<"always" | "session">;
}

export interface McpUrlRequest extends McpRequestBase {
  kind: "mcpUrl";
  elicitationId: string;
  url: string;
}

export interface McpUnsupportedFormRequest extends McpRequestBase {
  kind: "mcpUnsupportedForm";
  explanation: string;
}

export interface UnsupportedServerRequest {
  error: string;
  id: ServerRequestId;
  kind: "unsupported";
  method: string;
  threadId: string | null;
  turnId: string | null;
}

export type InteractiveServerRequest =
  | CommandApprovalRequest
  | FileChangeApprovalRequest
  | McpFormRequest
  | McpUnsupportedFormRequest
  | McpUrlRequest
  | PermissionsApprovalRequest
  | UserInputRequest;

export type PendingServerRequest =
  | InteractiveServerRequest
  | UnsupportedServerRequest;

export type ServerResponseFor<T extends InteractiveServerRequest> =
  T extends CommandApprovalRequest
    ? JsonObject & { decision: CommandApprovalDecision }
    : T extends FileChangeApprovalRequest
      ? JsonObject & {
          decision: "accept" | "acceptForSession" | "cancel" | "decline";
        }
      : T extends UserInputRequest
        ? JsonObject & { answers: Record<string, { answers: string[] }> }
        : T extends PermissionsApprovalRequest
          ? JsonObject & {
              permissions: GrantedPermissionProfile;
              scope: PermissionGrantScope;
              strictAutoReview?: boolean;
            }
          : T extends McpFormRequest | McpUnsupportedFormRequest | McpUrlRequest
            ? JsonObject & {
                _meta: JsonValue;
                action: "accept" | "cancel" | "decline";
                content: JsonObject | null;
              }
            : never;
