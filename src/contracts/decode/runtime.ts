import type { EngineStartResponse, OperationAck, RuntimeDiagnostic, RuntimeStatus } from "../types";
import { decodeConfigReadResponse, decodePermissionProfile } from "./config";
import {
  ENGINE_CAPABILITIES,
  ENGINE_STORAGES,
  ENGINE_TRANSPORTS,
  RUNTIME_STATES,
} from "./constants";
import { array, exactRecord, literal, nullableText, text } from "./primitives";

export function decodeEngineStartResponse(value: unknown): EngineStartResponse {
  const object = exactRecord(value, "$", [
    "config",
    "diagnosticLogPath",
    "engine",
    "permissionProfiles",
    "schemaVersion",
  ]);
  const engine = exactRecord(object.engine, "$.engine", [
    "auth",
    "capabilities",
    "id",
    "name",
    "provider",
    "storage",
    "transport",
  ]);
  const schemaVersion = literal(object.schemaVersion, "$.schemaVersion", [23] as const);
  return {
    config: decodeConfigReadResponse(object.config),
    diagnosticLogPath: text(object.diagnosticLogPath, "$.diagnosticLogPath"),
    engine: {
      id: text(engine.id, "$.engine.id"),
      name: text(engine.name, "$.engine.name"),
      provider: text(engine.provider, "$.engine.provider"),
      auth: text(engine.auth, "$.engine.auth"),
      transport: literal(engine.transport, "$.engine.transport", ENGINE_TRANSPORTS),
      storage: literal(engine.storage, "$.engine.storage", ENGINE_STORAGES),
      capabilities: array(engine.capabilities, "$.engine.capabilities", (entry, path) =>
        literal(entry, path, ENGINE_CAPABILITIES),
      ),
    },
    schemaVersion,
    permissionProfiles: array(
      object.permissionProfiles,
      "$.permissionProfiles",
      decodePermissionProfile,
    ),
  };
}

export function decodeRuntimeStatus(value: unknown): RuntimeStatus {
  const object = exactRecord(value, "$", ["message", "state"]);
  return {
    state: literal(object.state, "$.state", RUNTIME_STATES),
    message: nullableText(object.message, "$.message"),
  };
}

export function decodeRuntimeDiagnostic(value: unknown): RuntimeDiagnostic {
  const object = exactRecord(value, "$", ["message", "stream"]);
  return {
    stream: literal(object.stream, "$.stream", ["runtime"] as const),
    message: text(object.message, "$.message"),
  };
}

export function decodeOperationAck(value: unknown): OperationAck {
  const object = exactRecord(value, "$", ["applied"]);
  return { applied: literal(object.applied, "$.applied", [true] as const) };
}
