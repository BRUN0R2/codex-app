import { PROFILE_STORAGE_KEYS } from "./profileStorage";

const STORAGE_KEY = PROFILE_STORAGE_KEYS.pinnedThreads;
const MAX_PINNED_THREADS = 128;
const MAX_ID_CHARACTERS = 256;

interface StoredPins {
  readonly version: 1;
  readonly threadIds: readonly string[];
}

export function loadPinnedThreadIds(): readonly string[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) {
    return [];
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (reason) {
    throw new Error(`The pinned-task list contains invalid JSON: ${describe(reason)}`);
  }
  return decodePins(value).threadIds;
}

export function savePinnedThreadIds(threadIds: readonly string[]): void {
  const validated = decodePins({ version: 1, threadIds });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(validated));
}

export function togglePinnedThreadId(
  threadIds: readonly string[],
  threadId: string,
): readonly string[] {
  const id = validateId(threadId);
  if (threadIds.includes(id)) {
    return threadIds.filter((entry) => entry !== id);
  }
  if (threadIds.length >= MAX_PINNED_THREADS) {
    throw new Error(`The application accepts at most ${MAX_PINNED_THREADS} pinned tasks.`);
  }
  return [id, ...threadIds];
}

export function removePinnedThreadId(
  threadIds: readonly string[],
  threadId: string,
): readonly string[] {
  return threadIds.filter((entry) => entry !== threadId);
}

function decodePins(value: unknown): StoredPins {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The pinned-task list is not an object.");
  }
  const object = value as Record<"threadIds" | "version", unknown>;
  const keys = Object.keys(object).sort();
  if (keys.length !== 2 || keys[0] !== "threadIds" || keys[1] !== "version") {
    throw new Error("The pinned-task list has incompatible fields.");
  }
  if (object.version !== 1 || !Array.isArray(object.threadIds)) {
    throw new Error("The pinned-task list version is unsupported.");
  }
  if (object.threadIds.length > MAX_PINNED_THREADS) {
    throw new Error(`A lista excede ${MAX_PINNED_THREADS} tarefas fixadas.`);
  }
  const seen = new Set<string>();
  const threadIds = object.threadIds.map((entry, index) => {
    const id = validateId(entry);
    if (seen.has(id)) {
      throw new Error(`Pinned task ${index + 1} is duplicated.`);
    }
    seen.add(id);
    return id;
  });
  return { version: 1, threadIds };
}

function validateId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ID_CHARACTERS ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error("The pinned-task identifier is invalid.");
  }
  return value;
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : "unknown error";
}
