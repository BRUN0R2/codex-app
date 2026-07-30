import type { Accessor } from "solid-js";

import type { JsonValue } from "../../shared/codex/types";
import type { CodexSession } from "../session/createCodexSession";

export type SettingsPage =
  | "account"
  | "advanced"
  | "appearance"
  | "configuration"
  | "general"
  | "personalization";

export type MergeStrategy = "replace" | "upsert";

export type SaveSetting = (
  keyPath: string,
  value: JsonValue,
  mergeStrategy?: MergeStrategy,
) => Promise<boolean>;

export interface SettingsPageProps {
  refreshConfig: () => Promise<boolean>;
  savingKey: Accessor<string | null>;
  session: CodexSession;
  saveSetting: SaveSetting;
}

export interface SelectOption {
  label: string;
  value: string;
}
