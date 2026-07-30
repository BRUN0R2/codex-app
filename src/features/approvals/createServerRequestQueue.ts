import { createSignal, type Accessor } from "solid-js";

import type { CodexServerRequest } from "../../shared/codex/types";
import { parseServerRequest } from "./parseServerRequest";
import { decodeRequestId } from "./requestParsing";
import type {
  PendingServerRequest,
} from "./serverRequestTypes";

export interface ServerRequestQueue {
  clear: () => void;
  enqueue: (request: CodexServerRequest) => string | null;
  pending: Accessor<PendingServerRequest[]>;
  remove: (id: unknown) => void;
}

export function createServerRequestQueue(): ServerRequestQueue {
  const [pending, setPending] = createSignal<PendingServerRequest[]>([]);

  function enqueue(raw: CodexServerRequest): string | null {
    const result = parseServerRequest(raw);
    const request = result.request;
    if (request !== null) {
      setPending((current) => upsert(current, request));
    }
    return result.ok ? null : result.error;
  }

  function remove(rawId: unknown) {
    const id = decodeRequestId(rawId);
    if (id === null) {
      return;
    }
    setPending((current) => current.filter((request) => request.id !== id));
  }

  return {
    pending,
    enqueue,
    remove,
    clear: () => setPending([]),
  };
}

function upsert(
  current: PendingServerRequest[],
  request: PendingServerRequest,
): PendingServerRequest[] {
  const index = current.findIndex((candidate) => candidate.id === request.id);
  if (index < 0) {
    return [...current, request];
  }
  return current.map((candidate, candidateIndex) =>
    candidateIndex === index ? request : candidate,
  );
}
