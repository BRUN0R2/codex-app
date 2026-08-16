import { describe, expect, it } from "vitest";

import type { CodexThread, ThreadSummary } from "../contracts/types";
import { cachedThreadMatchesSummary, ThreadPageCache } from "./threadPageCache";

describe("cache de páginas de conversa", () => {
  it("reutiliza a página mais recente e expulsa a menos usada", () => {
    const cache = new ThreadPageCache(2);
    cache.write(page("a", 1));
    cache.write(page("b", 2));

    expect(cache.read("a")?.thread.id).toBe("a");
    expect(cache.write(page("c", 3))).toBe("b");
    expect(cache.read("b")).toBeNull();
    expect(cache.read("a")?.thread.id).toBe("a");
    expect(cache.read("c")?.thread.id).toBe("c");
  });

  it("atualiza uma página sem trocar sua identidade", () => {
    const cache = new ThreadPageCache(1);
    cache.write(page("a", 1));

    cache.update("a", (current) => ({
      ...current,
      thread: { ...current.thread, updatedAt: 4 },
    }));

    expect(cache.read("a")?.thread.updatedAt).toBe(4);
    expect(() =>
      cache.update("a", (current) => ({
        ...current,
        thread: { ...current.thread, id: "b" },
      })),
    ).toThrow("trocar o identificador");
  });

  it("só considera atual uma página da mesma conversa e revisão", () => {
    const cached = page("a", 5);
    expect(cachedThreadMatchesSummary(cached, summary("a", 5))).toBe(true);
    expect(cachedThreadMatchesSummary(cached, summary("a", 6))).toBe(false);
    expect(
      cachedThreadMatchesSummary(cached, {
        ...summary("a", 5),
        projectPath: "D:\\outro",
      }),
    ).toBe(false);
  });
});

function page(id: string, updatedAt: number) {
  return {
    nextCursor: `${id}-cursor`,
    thread: {
      ...summary(id, updatedAt),
      turns: [],
    },
  } as const satisfies { readonly nextCursor: string; readonly thread: CodexThread };
}

function summary(id: string, updatedAt: number): ThreadSummary {
  return {
    id,
    mode: "codex",
    preview: id,
    name: null,
    cwd: "D:\\workspace",
    projectPath: "D:\\workspace",
    createdAt: 1,
    updatedAt,
    recencyAt: updatedAt,
    status: { type: "idle" },
  };
}
