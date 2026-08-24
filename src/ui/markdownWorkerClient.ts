import { sanitizeMarkdownHtml } from "./markdownRenderer";
import type { MarkdownWorkerResponse } from "./markdownWorkerProtocol";

const MARKDOWN_WORKER_MINIMUM_CHARACTERS = 32 * 1_024;

interface PendingRender {
  readonly reject: (reason: Error) => void;
  readonly resolve: (html: string) => void;
}

let sharedClient: MarkdownWorkerClient | undefined;

export function shouldRenderMarkdownOffThread(source: string): boolean {
  return source.length >= MARKDOWN_WORKER_MINIMUM_CHARACTERS && typeof Worker !== "undefined";
}

export async function renderMarkdownOffThread(
  source: string,
  signal: AbortSignal,
): Promise<string> {
  const html = await markdownWorkerClient().render(source, signal);
  if (signal.aborted) {
    throw new DOMException("Markdown rendering was superseded.", "AbortError");
  }
  return sanitizeMarkdownHtml(html);
}

class MarkdownWorkerClient {
  readonly #pending = new Map<number, PendingRender>();
  #nextRequestId = 1;
  readonly #worker: Worker;

  constructor() {
    this.#worker = new Worker(new URL("./markdown.worker.ts", import.meta.url), {
      name: "codex-markdown-renderer",
      type: "module",
    });
    this.#worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      try {
        this.#handleMessage(event.data);
      } catch (reason) {
        this.#failAll(
          reason instanceof Error ? reason : new Error("The Markdown worker response is invalid."),
        );
      }
    });
    this.#worker.addEventListener("error", () => {
      this.#failAll(new Error("The Markdown worker stopped unexpectedly."));
    });
    this.#worker.addEventListener("messageerror", () => {
      this.#failAll(new Error("The Markdown worker returned an invalid message."));
    });
  }

  render(source: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted) {
      return Promise.reject(new DOMException("Markdown rendering was superseded.", "AbortError"));
    }
    const id = this.#nextRequestId;
    this.#nextRequestId = id === Number.MAX_SAFE_INTEGER ? 1 : id + 1;
    if (this.#pending.has(id)) {
      return Promise.reject(new Error("The Markdown worker request identifier was reused."));
    }
    return new Promise((resolve, reject) => {
      const abort = () => {
        if (this.#pending.delete(id)) {
          reject(new DOMException("Markdown rendering was superseded.", "AbortError"));
        }
      };
      const pending: PendingRender = {
        reject: (reason) => {
          signal.removeEventListener("abort", abort);
          reject(reason);
        },
        resolve: (html) => {
          signal.removeEventListener("abort", abort);
          resolve(html);
        },
      };
      this.#pending.set(id, pending);
      signal.addEventListener("abort", abort, { once: true });
      try {
        this.#worker.postMessage({ id, source });
      } catch (reason) {
        this.#pending.delete(id);
        pending.reject(
          reason instanceof Error ? reason : new Error("The Markdown worker request failed."),
        );
      }
    });
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
    this.#worker.terminate();
    if (sharedClient === this) {
      sharedClient = undefined;
    }
  }

  #handleMessage(value: unknown): void {
    const response = decodeWorkerResponse(value);
    const pending = this.#pending.get(response.id);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(response.id);
    if (response.ok) {
      pending.resolve(response.html);
    } else {
      pending.reject(new Error(response.error));
    }
  }
}

function markdownWorkerClient(): MarkdownWorkerClient {
  sharedClient ??= new MarkdownWorkerClient();
  return sharedClient;
}

function decodeWorkerResponse(value: unknown): MarkdownWorkerResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The Markdown worker response is not an object.");
  }
  const response = value as Record<string, unknown>;
  const { id, ok } = response;
  if (!Number.isSafeInteger(id) || (ok !== true && ok !== false)) {
    throw new Error("The Markdown worker response has an invalid envelope.");
  }
  if (ok) {
    const { html } = response;
    if (typeof html !== "string") {
      throw new Error("The Markdown worker response has no rendered HTML.");
    }
    return { id: id as number, html, ok };
  }
  const { error } = response;
  if (typeof error !== "string" || error.length === 0) {
    throw new Error("The Markdown worker response has no failure message.");
  }
  return { id: id as number, error, ok };
}
