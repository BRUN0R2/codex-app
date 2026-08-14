import type { ChatModelOption } from "../contracts/types";
import { PROFILE_STORAGE_KEYS } from "./profileStorage";

const STORAGE_KEY = PROFILE_STORAGE_KEYS.chatIntelligence;
const MAX_STORED_VALUE_CHARACTERS = 1_024;

export interface ChatIntelligenceSelection {
  readonly version: 2;
  readonly optionId: string;
}

export interface ResolvedChatIntelligence {
  readonly option: ChatModelOption | undefined;
}

export function loadChatIntelligenceSelection(): ChatIntelligenceSelection | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) {
    return null;
  }
  if (raw.length > MAX_STORED_VALUE_CHARACTERS) {
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
  try {
    return decodeChatIntelligenceSelection(JSON.parse(raw) as unknown);
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

export function saveChatIntelligenceSelection(selection: ChatIntelligenceSelection): void {
  const validated = decodeChatIntelligenceSelection(selection);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(validated));
}

export function clearChatIntelligenceSelection(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function resolveChatIntelligence(
  options: readonly ChatModelOption[],
  selection: ChatIntelligenceSelection | null,
): ResolvedChatIntelligence {
  const fallback = options.find((option) => option.isDefault) ?? options[0];
  if (selection === null) {
    return { option: fallback };
  }
  return {
    option: options.find((option) => option.id === selection.optionId) ?? fallback,
  };
}

export function selectionFromChatOption(option: ChatModelOption): ChatIntelligenceSelection {
  return {
    version: 2,
    optionId: option.id,
  };
}

export function chatOptionLabel(option: ChatModelOption): string {
  return option.selectedLabel ?? option.title;
}

function decodeChatIntelligenceSelection(value: unknown): ChatIntelligenceSelection {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("A seleção de modelo do Chat não é um objeto.");
  }
  const object = value as {
    readonly optionId?: unknown;
    readonly version?: unknown;
  };
  const keys = Object.keys(object).sort();
  if (keys.join(",") !== "optionId,version") {
    throw new Error("A seleção de modelo do Chat possui campos incompatíveis.");
  }
  if (object.version !== 2) {
    throw new Error("A versão da seleção de modelo do Chat não é suportada.");
  }
  return {
    version: 2,
    optionId: optionId(object.optionId),
  };
}

function optionId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error("A opção de modelo selecionada para o Chat é inválida.");
  }
  return value;
}
