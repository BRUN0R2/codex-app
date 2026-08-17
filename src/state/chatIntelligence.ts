import type { ChatModelOption } from "../contracts/types";
import { PROFILE_STORAGE_KEYS } from "./profileStorage";

const STORAGE_KEY = PROFILE_STORAGE_KEYS.chatIntelligence;
const MAX_STORED_VALUE_CHARACTERS = 1_024;
const MAX_MODEL_OPTION_ID_CHARACTERS = 256;

export interface ChatIntelligenceSelection {
  readonly version: 2;
  readonly optionId: string;
}

export interface ResolvedChatIntelligence {
  readonly option: ChatModelOption | undefined;
  readonly source: "catalogDefault" | "catalogUnavailable" | "explicit" | "selectionUnavailable";
}

export function loadChatIntelligenceSelection(): ChatIntelligenceSelection | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) {
    return null;
  }
  if (raw.length > MAX_STORED_VALUE_CHARACTERS) {
    throw new Error("A seleção de modelo do Chat excede o limite permitido.");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (reason) {
    throw new Error(`A seleção de modelo do Chat contém JSON inválido: ${describe(reason)}`);
  }
  return decodeChatIntelligenceSelection(value);
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
  const catalogDefault = options.find((option) => option.isDefault) ?? options[0];
  if (options.length === 0) {
    return { option: undefined, source: "catalogUnavailable" };
  }
  if (selection === null) {
    return { option: catalogDefault, source: "catalogDefault" };
  }
  const selected = options.find((option) => option.id === selection.optionId);
  return selected === undefined
    ? { option: catalogDefault, source: "selectionUnavailable" }
    : { option: selected, source: "explicit" };
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
    value.length > MAX_MODEL_OPTION_ID_CHARACTERS ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error("A opção de modelo selecionada para o Chat é inválida.");
  }
  return value;
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : "erro desconhecido";
}
