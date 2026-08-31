import { PROFILE_STORAGE_KEYS } from "./profileStorage";

const STORAGE_KEY = PROFILE_STORAGE_KEYS.browserTabs;
const LEGACY_STORAGE_KEY = "codex-browser-tabs-v1";
const STORAGE_VERSION = 1;
const MAX_PERSISTED_BROWSER_TABS_PER_CONVERSATION = 16;
const MAX_PERSISTED_CONVERSATIONS = 256;
export const MAX_BROWSER_URL_BYTES = 16_384;

export interface PersistedBrowserTab {
  readonly browserTabId: string;
  readonly url: string;
}

export interface PersistedBrowserConversation {
  readonly activeBrowserTabId: string;
  readonly conversationId: string;
  readonly tabs: readonly PersistedBrowserTab[];
}

interface PersistedBrowserState {
  readonly conversations: readonly PersistedBrowserConversation[];
  readonly version: typeof STORAGE_VERSION;
}

export interface LoadedPersistedBrowserConversations {
  readonly conversations: readonly PersistedBrowserConversation[];
  readonly error: Error | null;
}

export function loadPersistedBrowserConversations(): LoadedPersistedBrowserConversations {
  const migration = migrateLegacyBrowserState();
  if (migration !== null) {
    return migration;
  }
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) {
    return { conversations: [], error: null };
  }
  try {
    return {
      conversations: decodePersistedBrowserState(JSON.parse(raw)).conversations,
      error: null,
    };
  } catch (reason) {
    localStorage.removeItem(STORAGE_KEY);
    return {
      conversations: [],
      error: reason instanceof Error ? reason : new Error("Invalid persisted browser state."),
    };
  }
}

function migrateLegacyBrowserState(): LoadedPersistedBrowserConversations | null {
  const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (raw === null) {
    return null;
  }
  let state: PersistedBrowserState;
  try {
    state = decodePersistedBrowserState(JSON.parse(raw));
  } catch (reason) {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    return {
      conversations: [],
      error: reason instanceof Error ? reason : new Error("Invalid persisted browser state."),
    };
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    return null;
  } catch (reason) {
    return {
      conversations: [],
      error: reason instanceof Error ? reason : new Error("Invalid persisted browser state."),
    };
  }
}

export function savePersistedBrowserConversations(
  conversations: readonly PersistedBrowserConversation[],
): void {
  const state = decodePersistedBrowserState({ version: STORAGE_VERSION, conversations });
  if (state.conversations.length === 0) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function decodePersistedBrowserState(value: unknown): PersistedBrowserState {
  const state = exactObject(value, ["conversations", "version"]);
  if (state.version !== STORAGE_VERSION) {
    throw new Error("Persisted browser state uses an unsupported version.");
  }
  if (
    !Array.isArray(state.conversations) ||
    state.conversations.length > MAX_PERSISTED_CONVERSATIONS
  ) {
    throw new Error("Persisted browser conversations exceed the supported limit.");
  }
  const conversationIds = new Set<string>();
  const tabIds = new Set<string>();
  const conversations = state.conversations.map((entry) => {
    const conversation = exactObject(entry, ["activeBrowserTabId", "conversationId", "tabs"]);
    const conversationId = identifier(conversation.conversationId, "browser conversation id");
    const activeBrowserTabId = identifier(conversation.activeBrowserTabId, "active browser tab id");
    if (conversationIds.has(conversationId)) {
      throw new Error("Persisted browser conversations must be unique.");
    }
    conversationIds.add(conversationId);
    if (!Array.isArray(conversation.tabs) || conversation.tabs.length === 0) {
      throw new Error("Persisted browser conversations require at least one tab.");
    }
    if (conversation.tabs.length > MAX_PERSISTED_BROWSER_TABS_PER_CONVERSATION) {
      throw new Error("Persisted browser tabs exceed the per-conversation limit.");
    }
    const tabs = conversation.tabs.map((entry) => {
      const tab = exactObject(entry, ["browserTabId", "url"]);
      const browserTabId = identifier(tab.browserTabId, "browser tab id");
      if (tabIds.has(browserTabId)) {
        throw new Error("Persisted browser tab ids must be globally unique.");
      }
      tabIds.add(browserTabId);
      return {
        browserTabId,
        url: browserUrl(tab.url),
      };
    });
    if (!tabs.some((tab) => tab.browserTabId === activeBrowserTabId)) {
      throw new Error("Persisted active browser tab must belong to its conversation.");
    }
    return { activeBrowserTabId, conversationId, tabs };
  });
  return { version: STORAGE_VERSION, conversations };
}

function exactObject<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): Record<Keys[number], unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Persisted browser state must contain plain objects.");
  }
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("Persisted browser state contains unexpected fields.");
  }
  return object as Record<Keys[number], unknown>;
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 256 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error(`Persisted ${label} is invalid.`);
  }
  return value;
}

function browserUrl(value: unknown): string {
  if (typeof value !== "string" || new TextEncoder().encode(value).length > MAX_BROWSER_URL_BYTES) {
    throw new Error("Persisted browser URL is invalid.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Persisted browser URL must be absolute.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:" && value !== "about:blank") ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error("Persisted browser URL is not allowed.");
  }
  return value;
}
