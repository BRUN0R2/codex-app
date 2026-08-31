import { beforeEach, describe, expect, it } from "vitest";

import {
  appendQueuedMessage,
  clearPersistedMessageQueues,
  deleteMessageQueue,
  loadMessageQueues,
  loadQueueingEnabled,
  type MessageQueueMap,
  type QueuedMessage,
  readQueuedMessages,
  saveMessageQueue,
  saveQueueingEnabled,
  takeQueuedMessage,
} from "./messageQueue";
import { PROFILE_STORAGE_KEYS } from "./profileStorage";

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

  it("does not impose an artificial message-count limit", () => {
    let queues: MessageQueueMap = new Map();
    for (let index = 0; index < 256; index += 1) {
      queues = appendQueuedMessage(queues, "thread-a", message(`message-${index}`));
    }

    expect(readQueuedMessages(queues, "thread-a")).toHaveLength(256);
  });

  it("persists queues independently and removes empty queues", () => {
    saveMessageQueue("thread-a", [message("a-1"), message("a-2")]);
    saveMessageQueue("thread-b", [message("b-1")]);

    let loaded = loadMessageQueues();
    expect(loaded.warnings).toEqual([]);
    expect(readQueuedMessages(loaded.queues, "thread-a").map((entry) => entry.id)).toEqual([
      "a-1",
      "a-2",
    ]);
    expect(readQueuedMessages(loaded.queues, "thread-b").map((entry) => entry.id)).toEqual(["b-1"]);

    saveMessageQueue("thread-a", []);
    loaded = loadMessageQueues();
    expect(loaded.queues.has("thread-a")).toBe(false);
    expect(loaded.queues.has("thread-b")).toBe(true);

    clearPersistedMessageQueues();
    expect(loadMessageQueues().queues.size).toBe(0);
  });

  it("keeps valid queues when another persisted queue is corrupt", () => {
    saveMessageQueue("thread-a", [message("a-1")]);
    localStorage.setItem(`${PROFILE_STORAGE_KEYS.messageQueuePrefix}broken`, "{");

    const loaded = loadMessageQueues();

    expect(readQueuedMessages(loaded.queues, "thread-a")).toHaveLength(1);
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]).toContain("was ignored");
  });

  it("persists whether follow-ups should queue or steer", () => {
    expect(loadQueueingEnabled()).toBe(true);
    saveQueueingEnabled(false);
    expect(loadQueueingEnabled()).toBe(false);
    saveQueueingEnabled(true);
    expect(loadQueueingEnabled()).toBe(true);
  });

  it("rejects an unknown persisted follow-up behavior", () => {
    localStorage.setItem(PROFILE_STORAGE_KEYS.followUpBehavior, "future");

    expect(() => loadQueueingEnabled()).toThrow("The saved follow-up message behavior is invalid.");
  });
});
