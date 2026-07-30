import type { ConfigLayerMetadata, ConfigReadResponse } from "../../shared/codex/types";

export function isAdministrativelyManaged(
  snapshot: ConfigReadResponse | null,
  keyPath: string,
): boolean {
  const origin = snapshot?.origins?.[keyPath];
  return origin !== undefined && isAdministrativeOrigin(origin);
}

function isAdministrativeOrigin(origin: ConfigLayerMetadata): boolean {
  switch (origin.name.type) {
    case "enterpriseManaged":
    case "legacyManagedConfigTomlFromFile":
    case "legacyManagedConfigTomlFromMdm":
    case "mdm":
    case "system":
      return true;
    case "project":
    case "sessionFlags":
    case "user":
      return false;
  }
}
