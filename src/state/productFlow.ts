import type { AppProduct, ChatGptMode, ConversationMode } from "../contracts/types";
import { PROFILE_STORAGE_KEYS } from "./profileStorage";

const STORAGE_KEY = PROFILE_STORAGE_KEYS.productFlow;
const MAX_STORED_VALUE_CHARACTERS = 4_096;

export interface ConversationDestination {
  readonly threadId: string | null;
  readonly workspace: string | null;
}

export interface ProductFlowState {
  readonly version: 1;
  readonly product: AppProduct;
  readonly chatGptMode: ChatGptMode;
  readonly destinations: Readonly<Record<ConversationMode, ConversationDestination>>;
}

export function defaultProductFlowState(): ProductFlowState {
  return {
    version: 1,
    product: "codex",
    chatGptMode: "chat",
    destinations: {
      chat: { threadId: null, workspace: null },
      work: { threadId: null, workspace: null },
      codex: { threadId: null, workspace: null },
    },
  };
}

export function activeConversationMode(state: ProductFlowState): ConversationMode {
  return state.product === "codex" ? "codex" : state.chatGptMode;
}

export function loadProductFlowState(): ProductFlowState {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) {
    return defaultProductFlowState();
  }
  if (raw.length > MAX_STORED_VALUE_CHARACTERS) {
    throw new Error("The ChatGPT and Codex navigation state exceeds the allowed limit.");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (reason) {
    throw new Error(
      `The ChatGPT and Codex navigation state contains invalid JSON: ${describe(reason)}`,
    );
  }
  return decodeProductFlowState(value);
}

export function saveProductFlowState(state: ProductFlowState): void {
  const validated = decodeProductFlowState(state);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(validated));
}

export function selectProduct(state: ProductFlowState, product: AppProduct): ProductFlowState {
  return state.product === product ? state : { ...state, product };
}

export function selectChatGptMode(
  state: ProductFlowState,
  chatGptMode: ChatGptMode,
): ProductFlowState {
  if (state.product === "chatgpt" && state.chatGptMode === chatGptMode) {
    return state;
  }
  return { ...state, product: "chatgpt", chatGptMode };
}

export function rememberConversationDestination(
  state: ProductFlowState,
  mode: ConversationMode,
  destination: ConversationDestination,
): ProductFlowState {
  const validated = decodeDestination(destination, `destinations.${mode}`);
  const current = state.destinations[mode];
  if (current.threadId === validated.threadId && current.workspace === validated.workspace) {
    return state;
  }
  return {
    ...state,
    destinations: {
      ...state.destinations,
      [mode]: validated,
    },
  };
}

function decodeProductFlowState(value: unknown): ProductFlowState {
  const object = exactObject(value, "navigation state", [
    "chatGptMode",
    "destinations",
    "product",
    "version",
  ]);
  if (object.version !== 1) {
    throw new Error("The navigation state version is not supported.");
  }
  const product = literal(object.product, "product", ["chatgpt", "codex"] as const);
  const chatGptMode = literal(object.chatGptMode, "ChatGPT mode", ["chat", "work"] as const);
  const destinations = exactObject(object.destinations, "destinations", ["chat", "codex", "work"]);
  return {
    version: 1,
    product,
    chatGptMode,
    destinations: {
      chat: decodeDestination(destinations.chat, "destinations.chat"),
      work: decodeDestination(destinations.work, "destinations.work"),
      codex: decodeDestination(destinations.codex, "destinations.codex"),
    },
  };
}

function decodeDestination(value: unknown, label: string): ConversationDestination {
  const object = exactObject(value, label, ["threadId", "workspace"]);
  return {
    threadId: nullableBoundedText(object.threadId, `${label}.threadId`, 256),
    workspace: nullableBoundedText(object.workspace, `${label}.workspace`, 4_096),
  };
}

function exactObject<const Key extends string>(
  value: unknown,
  label: string,
  expectedKeys: readonly Key[],
): Record<Key, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object.`);
  }
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has incompatible fields.`);
  }
  return object as Record<Key, unknown>;
}

function literal<const T extends readonly string[]>(
  value: unknown,
  label: string,
  allowed: T,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as T[number];
}

function nullableBoundedText(value: unknown, label: string, maximum: number): string | null {
  if (value === null) {
    return null;
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : "unknown error";
}
