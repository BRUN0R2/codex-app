import { renderMarkdownSource } from "./markdownParser";
import type { MarkdownWorkerRequest, MarkdownWorkerResponse } from "./markdownWorkerProtocol";

const workerScope = globalThis as unknown as {
  readonly addEventListener: (
    type: "message",
    listener: (event: MessageEvent<MarkdownWorkerRequest>) => void,
  ) => void;
  readonly postMessage: (response: MarkdownWorkerResponse) => void;
};

workerScope.addEventListener("message", (event) => {
  const request = event.data;
  try {
    workerScope.postMessage({
      id: request.id,
      html: renderMarkdownSource(request.source),
      ok: true,
    });
  } catch (reason) {
    workerScope.postMessage({
      id: request.id,
      error: reason instanceof Error ? reason.message : String(reason),
      ok: false,
    });
  }
});
