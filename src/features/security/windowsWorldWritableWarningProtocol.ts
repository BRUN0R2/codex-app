import {
  isJsonObject,
  type JsonValue,
  type WindowsWorldWritableWarningNotification,
} from "../../shared/codex/types";

export const WORLD_WRITABLE_WARNING_CONFIG_KEY =
  "notice.hide_world_writable_warning";

const MAX_SAMPLE_PATHS = 3;

export function parseWindowsWorldWritableWarning(
  value: JsonValue | undefined,
): WindowsWorldWritableWarningNotification {
  if (!isJsonObject(value)) {
    throw incompatibleNotification();
  }

  const rawPaths = value.samplePaths;
  const rawExtraCount = value.extraCount;
  const failedScan = value.failedScan;
  if (
    !Array.isArray(rawPaths)
    || !rawPaths.every((path): path is string => typeof path === "string")
    || typeof rawExtraCount !== "number"
    || !Number.isSafeInteger(rawExtraCount)
    || rawExtraCount < 0
    || typeof failedScan !== "boolean"
  ) {
    throw incompatibleNotification();
  }

  const omittedByClient = Math.max(0, rawPaths.length - MAX_SAMPLE_PATHS);
  const extraCount = rawExtraCount + omittedByClient;
  if (!Number.isSafeInteger(extraCount)) {
    throw incompatibleNotification();
  }

  return {
    samplePaths: rawPaths.slice(0, MAX_SAMPLE_PATHS),
    extraCount,
    failedScan,
  };
}

function incompatibleNotification(): Error {
  return new Error(
    "Notificação incompatível do Codex em windows/worldWritableWarning.",
  );
}
