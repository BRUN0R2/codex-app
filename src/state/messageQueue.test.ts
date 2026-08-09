import { beforeEach, describe, expect, it } from "vitest";

import {
  appendQueuedMessage,
  deleteMessageQueue,
  loadQueueingEnabled,
  type MessageQueueMap,
  type QueuedMessage,
  readQueuedMessages,
  saveQueueingEnabled,
  takeQueuedMessage,
} from "./messageQueue";

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length(): number {
    return this.#values.size;
  }

  clear(): void {
    this.#values.clear();
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
}

function message(id: string): QueuedMessage {
  return {
    id,
    text: `Mensagem ${id}`,
    attachments: [],
    model: null,
    effort: null,
    serviceTier: null,
  };
}

describe("message queue", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: new MemoryStorage(),
    });
  });

  it("keeps FIFO order isolated by task", () => {
    let queues: MessageQueueMap = new Map();
    queues = appendQueuedMessage(queues, "thread-a", message("a-1"));
    queues = appendQueuedMessage(queues, "thread-b", message("b-1"));
    queues = appendQueuedMessage(queues, "thread-a", message("a-2"));

    expect(readQueuedMessages(queues, "thread-a").map((entry) => entry.id)).toEqual(["a-1", "a-2"]);
    expect(readQueuedMessages(queues, "thread-b").map((entry) => entry.id)).toEqual(["b-1"]);
  });

  it("takes exactly the selected message without disturbing the remaining order", () => {
    let queues: MessageQueueMap = new Map();
    queues = appendQueuedMessage(queues, "thread-a", message("first"));
    queues = appendQueuedMessage(queues, "thread-a", message("second"));
    queues = appendQueuedMessage(queues, "thread-a", message("third"));

    const taken = takeQueuedMessage(queues, "thread-a", "second");

    expect(taken.message?.id).toBe("second");
    expect(readQueuedMessages(taken.queues, "thread-a").map((entry) => entry.id)).toEqual([
      "first",
      "third",
    ]);
    expect(deleteMessageQueue(taken.queues, "thread-a").has("thread-a")).toBe(false);
  });

  it("persists whether follow-ups should queue or steer", () => {
    expect(loadQueueingEnabled()).toBe(true);
    saveQueueingEnabled(false);
    expect(loadQueueingEnabled()).toBe(false);
    saveQueueingEnabled(true);
    expect(loadQueueingEnabled()).toBe(true);
  });
});
