import { array, ContractError, text } from "./primitives";

const DESKTOP_PATH_MAXIMUM_BYTES = 32 * 1_024;
const DESKTOP_DIALOG_SELECTION_MAXIMUM_ENTRIES = 1_024;

export type DesktopDialogSelection = string | string[] | null;

export function decodeDesktopDialogSelection(value: unknown): DesktopDialogSelection {
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return text(value, "$", DESKTOP_PATH_MAXIMUM_BYTES);
  }
  if (Array.isArray(value)) {
    return [
      ...array(
        value,
        "$",
        (entry, path) => text(entry, path, DESKTOP_PATH_MAXIMUM_BYTES),
        DESKTOP_DIALOG_SELECTION_MAXIMUM_ENTRIES,
      ),
    ];
  }
  throw new ContractError("$", "expected a dialog path, path list, or null");
}

export function decodeDesktopDialogButton(value: unknown): string {
  return text(value, "$", 256);
}

export function decodeDesktopBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new ContractError("$", "expected a boolean");
  }
  return value;
}

export function decodeRuntimeUnit(value: unknown): void {
  if (value !== null) {
    throw new ContractError("$", "expected a null unit response");
  }
}
