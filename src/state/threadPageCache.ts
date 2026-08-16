import type { CodexThread, ThreadSummary } from "../contracts/types";

export interface CachedThreadPage {
  readonly nextCursor: string | null;
  readonly thread: CodexThread;
}

export class ThreadPageCache {
  readonly #capacity: number;
  readonly #pages = new Map<string, CachedThreadPage>();

  public constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error("A cache de conversas exige uma capacidade inteira positiva.");
    }
    this.#capacity = capacity;
  }

  public read(threadId: string): CachedThreadPage | null {
    const page = this.#pages.get(threadId);
    if (page === undefined) {
      return null;
    }
    this.#touch(threadId, page);
    return page;
  }

  public write(page: CachedThreadPage): string | null {
    const threadId = page.thread.id;
    if (threadId.length === 0) {
      throw new Error("A cache de conversas não aceita um identificador vazio.");
    }
    this.#touch(threadId, page);
    if (this.#pages.size <= this.#capacity) {
      return null;
    }
    const oldestThreadId = this.#pages.keys().next().value;
    if (oldestThreadId === undefined) {
      throw new Error("A cache de conversas perdeu o candidato à expulsão.");
    }
    this.#pages.delete(oldestThreadId);
    return oldestThreadId;
  }

  public update(
    threadId: string,
    update: (page: CachedThreadPage) => CachedThreadPage,
  ): string | null {
    const current = this.#pages.get(threadId);
    if (current === undefined) {
      return null;
    }
    const next = update(current);
    if (next.thread.id !== threadId) {
      throw new Error("Uma atualização da cache tentou trocar o identificador da conversa.");
    }
    return this.write(next);
  }

  public delete(threadId: string): boolean {
    return this.#pages.delete(threadId);
  }

  public clear(): void {
    this.#pages.clear();
  }

  public size(): number {
    return this.#pages.size;
  }

  #touch(threadId: string, page: CachedThreadPage): void {
    this.#pages.delete(threadId);
    this.#pages.set(threadId, page);
  }
}

export function cachedThreadMatchesSummary(
  page: CachedThreadPage,
  summary: ThreadSummary,
): boolean {
  return (
    page.thread.id === summary.id &&
    page.thread.mode === summary.mode &&
    page.thread.cwd === summary.cwd &&
    page.thread.projectPath === summary.projectPath &&
    page.thread.updatedAt >= summary.updatedAt
  );
}
