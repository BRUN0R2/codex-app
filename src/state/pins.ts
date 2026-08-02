const STORAGE_KEY = "codex-desktop.pinned-threads.v1";
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
    throw new Error(`A lista de tarefas fixadas contém JSON inválido: ${describe(reason)}`);
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
    throw new Error(`O aplicativo aceita no máximo ${MAX_PINNED_THREADS} tarefas fixadas.`);
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
    throw new Error("A lista de tarefas fixadas não é um objeto.");
  }
  const object = value as Record<"threadIds" | "version", unknown>;
  const keys = Object.keys(object).sort();
  if (keys.length !== 2 || keys[0] !== "threadIds" || keys[1] !== "version") {
    throw new Error("A lista de tarefas fixadas possui campos incompatíveis.");
  }
  if (object.version !== 1 || !Array.isArray(object.threadIds)) {
    throw new Error("A versão da lista de tarefas fixadas não é suportada.");
  }
  if (object.threadIds.length > MAX_PINNED_THREADS) {
    throw new Error(`A lista excede ${MAX_PINNED_THREADS} tarefas fixadas.`);
  }
  const seen = new Set<string>();
  const threadIds = object.threadIds.map((entry, index) => {
    const id = validateId(entry);
    if (seen.has(id)) {
      throw new Error(`A tarefa fixada ${index + 1} está duplicada.`);
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
    throw new Error("O identificador da tarefa fixada é inválido.");
  }
  return value;
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : "erro desconhecido";
}
