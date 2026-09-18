import type { EngineNotification, EngineServerRequest } from "../types";
import { decodeRateLimitUpdate } from "./account";
import { decodeAutomationAt, decodeAutomationRunAt } from "./automation";
import { MODEL_REROUTE_REASONS, MODEL_VERIFICATIONS } from "./constants";
import {
  decodeCompletedTurn,
  decodeThreadItem,
  decodeThreadSummary,
  decodeTurnSummary,
} from "./conversation";
import {
  array,
  booleanValue,
  browserOrigin,
  ContractError,
  decodeOperationFailure,
  decodeStreamDeltaPayload,
  exactKeys,
  exactRecord,
  identifier,
  literal,
  nullableText,
  text,
} from "./primitives";

const MAX_LOGIN_ERROR_BYTES = 4 * 1_024;

export function decodeEngineNotification(value: unknown): EngineNotification {
  const root = exactRecord(value, "$", ["method", "params"]);
  const method = text(root.method, "$.method", 128);
  switch (method) {
    case "auth.loginCompleted": {
      exactKeys(root, "$", ["method", "params"]);
      const params = exactRecord(root.params, "$.params", ["error", "loginId", "success"]);
      return {
        method,
        params: {
          loginId: identifier(params.loginId, "$.params.loginId"),
          success: booleanValue(params.success, "$.params.success"),
          error: nullableText(params.error, "$.params.error", MAX_LOGIN_ERROR_BYTES),
        },
      };
    }
    case "auth.sessionChanged": {
      exactKeys(root, "$", ["method", "params"]);
      const params = exactRecord(root.params, "$.params", ["signedIn"]);
      return {
        method,
        params: { signedIn: booleanValue(params.signedIn, "$.params.signedIn") },
      };
    }
    case "account.rateLimitsUpdated": {
      exactKeys(root, "$", ["method", "params"]);
      const params = exactRecord(root.params, "$.params", ["rateLimits"]);
      return {
        method,
        params: {
          rateLimits: decodeRateLimitUpdate(params.rateLimits, "$.params.rateLimits"),
        },
      };
    }
    case "automation.changed": {
      const params = exactRecord(root.params, "$.params", ["automation"]);
      return {
        method,
        params: { automation: decodeAutomationAt(params.automation, "$.params.automation") },
      };
    }
    case "automation.deleted": {
      const params = exactRecord(root.params, "$.params", ["automationId"]);
      return {
        method,
        params: { automationId: identifier(params.automationId, "$.params.automationId") },
      };
    }
    case "automation.runUpdated": {
      const params = exactRecord(root.params, "$.params", ["run"]);
      return {
        method,
        params: { run: decodeAutomationRunAt(params.run, "$.params.run") },
      };
    }
    case "thread.created":
    case "thread.updated": {
      exactKeys(root, "$", ["method", "params"]);
      const params = exactRecord(root.params, "$.params", ["thread"]);
      return {
        method,
        params: { thread: decodeThreadSummary(params.thread, "$.params.thread") },
      };
    }
    case "thread.archived":
    case "thread.deleted":
    case "thread.unarchived": {
      exactKeys(root, "$", ["method", "params"]);
      const params = exactRecord(root.params, "$.params", ["threadId"]);
      return { method, params: { threadId: identifier(params.threadId, "$.params.threadId") } };
    }
    case "turn.started": {
      exactKeys(root, "$", ["method", "params"]);
      const params = exactRecord(root.params, "$.params", ["threadId", "turn"]);
      return {
        method,
        params: {
          threadId: identifier(params.threadId, "$.params.threadId"),
          turn: decodeTurnSummary(params.turn, "$.params.turn"),
        },
      };
    }
    case "turn.completed": {
      exactKeys(root, "$", ["method", "params"]);
      const params = exactRecord(root.params, "$.params", ["error", "threadId", "turn"]);
      return {
        method,
        params: {
          threadId: identifier(params.threadId, "$.params.threadId"),
          turn: decodeCompletedTurn(params.turn, "$.params.turn"),
          error:
            params.error === null ? null : decodeOperationFailure(params.error, "$.params.error"),
        },
      };
    }
    case "model.rerouted": {
      const params = exactRecord(root.params, "$.params", [
        "fromModel",
        "reason",
        "threadId",
        "toModel",
        "turnId",
      ]);
      return {
        method,
        params: {
          threadId: identifier(params.threadId, "$.params.threadId"),
          turnId: identifier(params.turnId, "$.params.turnId"),
          fromModel: identifier(params.fromModel, "$.params.fromModel"),
          toModel: identifier(params.toModel, "$.params.toModel"),
          reason: literal(params.reason, "$.params.reason", MODEL_REROUTE_REASONS),
        },
      };
    }
    case "model.verification": {
      const params = exactRecord(root.params, "$.params", ["threadId", "turnId", "verifications"]);
      return {
        method,
        params: {
          threadId: identifier(params.threadId, "$.params.threadId"),
          turnId: identifier(params.turnId, "$.params.turnId"),
          verifications: array(
            params.verifications,
            "$.params.verifications",
            (value, path) => literal(value, path, MODEL_VERIFICATIONS),
            64,
          ),
        },
      };
    }
    case "model.safetyBufferingUpdated": {
      const params = exactRecord(root.params, "$.params", [
        "fasterModel",
        "model",
        "reasons",
        "showBufferingUi",
        "threadId",
        "turnId",
        "useCases",
      ]);
      return {
        method,
        params: {
          threadId: identifier(params.threadId, "$.params.threadId"),
          turnId: identifier(params.turnId, "$.params.turnId"),
          model: identifier(params.model, "$.params.model"),
          useCases: array(
            params.useCases,
            "$.params.useCases",
            (value, path) => text(value, path, 1_024),
            64,
          ),
          reasons: array(
            params.reasons,
            "$.params.reasons",
            (value, path) => text(value, path, 1_024),
            64,
          ),
          showBufferingUi: booleanValue(params.showBufferingUi, "$.params.showBufferingUi"),
          fasterModel:
            params.fasterModel === null
              ? null
              : identifier(params.fasterModel, "$.params.fasterModel"),
        },
      };
    }
    case "item.completed":
    case "item.started": {
      exactKeys(root, "$", ["method", "params"]);
      const params = exactRecord(root.params, "$.params", ["item", "threadId", "turnId"]);
      return {
        method,
        params: {
          threadId: identifier(params.threadId, "$.params.threadId"),
          turnId: identifier(params.turnId, "$.params.turnId"),
          item: decodeThreadItem(params.item, "$.params.item"),
        },
      };
    }
    case "item.streamDeltas": {
      exactKeys(root, "$", ["method", "params"]);
      const params = exactRecord(root.params, "$.params", ["deltas", "threadId", "turnId"]);
      return {
        method,
        params: {
          threadId: identifier(params.threadId, "$.params.threadId"),
          turnId: identifier(params.turnId, "$.params.turnId"),
          deltas: array(params.deltas, "$.params.deltas", decodeStreamDeltaPayload, 128),
        },
      };
    }
    default:
      throw new ContractError("$.method", `unsupported notification ${JSON.stringify(method)}`);
  }
}

export function decodeEngineServerRequest(value: unknown): EngineServerRequest {
  const root = exactRecord(value, "$", ["id", "method", "params"]);
  const id = identifier(root.id, "$.id");
  const method = literal(root.method, "$.method", [
    "approval.browserOrigin",
    "approval.command",
  ] as const);
  switch (method) {
    case "approval.command": {
      const params = exactRecord(root.params, "$.params", [
        "command",
        "cwd",
        "itemId",
        "reason",
        "threadId",
        "turnId",
      ]);
      return {
        id,
        method,
        params: {
          threadId: identifier(params.threadId, "$.params.threadId"),
          turnId: identifier(params.turnId, "$.params.turnId"),
          itemId: identifier(params.itemId, "$.params.itemId"),
          command: text(params.command, "$.params.command", 16_384),
          cwd: text(params.cwd, "$.params.cwd", 4_096),
          reason: text(params.reason, "$.params.reason", 1_024),
        },
      };
    }
    case "approval.browserOrigin": {
      const params = exactRecord(root.params, "$.params", [
        "itemId",
        "origin",
        "reason",
        "threadId",
        "turnId",
      ]);
      return {
        id,
        method,
        params: {
          threadId: identifier(params.threadId, "$.params.threadId"),
          turnId: identifier(params.turnId, "$.params.turnId"),
          itemId: identifier(params.itemId, "$.params.itemId"),
          origin: browserOrigin(params.origin, "$.params.origin"),
          reason: text(params.reason, "$.params.reason", 1_024),
        },
      };
    }
  }
}
