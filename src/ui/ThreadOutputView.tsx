import { createEffect, createMemo, createSignal, Show } from "solid-js";

import type { ThreadOutput, ToolOutputPresentation } from "../contracts/types";
import { readOutput } from "../infrastructure/codexClient";
import { utf8ByteLength } from "../utf8";
import { frontendFailureMessage, useFrontendFailureReporter } from "./frontendFailure";
import { ToolOutputContent } from "./ToolOutputContent";

const PLAIN_TEXT_PRESENTATION: ToolOutputPresentation = { type: "plainText" };

export function ThreadOutputView(props: {
  readonly format: (text: string) => string | null;
  readonly output: ThreadOutput;
  readonly presentation?: ToolOutputPresentation | undefined;
}) {
  const reportFailure = useFrontendFailureReporter();
  const [chunks, setChunks] = createSignal<readonly string[]>([props.output.preview]);
  const [loadedBytes, setLoadedBytes] = createSignal(utf8ByteLength(props.output.preview));
  const [nextCursor, setNextCursor] = createSignal<string | null>(props.output.nextCursor);
  const [loading, setLoading] = createSignal(false);
  const [failure, setFailure] = createSignal<string | null>(null);
  let activeOutputId = props.output.id;

  createEffect(() => {
    const output = props.output;
    if (output.id === activeOutputId) {
      return;
    }
    activeOutputId = output.id;
    if (output.nextCursor === null) {
      setFailure(null);
      setLoading(false);
      return;
    }
    setChunks([output.preview]);
    setLoadedBytes(utf8ByteLength(output.preview));
    setNextCursor(output.nextCursor);
    setFailure(null);
    setLoading(false);
  });

  const text = createMemo(() =>
    props.format(
      props.output.nextCursor === null
        ? props.output.preview
        : (props.output.id === activeOutputId ? chunks() : [props.output.preview]).join(""),
    ),
  );
  async function loadNext(): Promise<void> {
    const cursor = nextCursor();
    if (cursor === null || loading()) {
      return;
    }
    const outputId = props.output.id;
    setLoading(true);
    setFailure(null);
    try {
      const response = await readOutput(outputId, cursor);
      if (props.output.id !== outputId) {
        return;
      }
      if (response.outputId !== outputId || response.byteLength !== props.output.byteLength) {
        throw new Error("O recurso de saída mudou durante a leitura.");
      }
      setChunks((current) => [...current, response.chunk]);
      setLoadedBytes((current) => current + utf8ByteLength(response.chunk));
      setNextCursor(response.nextCursor);
    } catch (reason) {
      const message = frontendFailureMessage("Falha ao carregar a saída completa", reason);
      setFailure(message);
      reportFailure(message);
    } finally {
      if (props.output.id === outputId) {
        setLoading(false);
      }
    }
  }

  return (
    <div class="thread-output-view">
      <Show when={text()}>
        {(visible) => (
          <ToolOutputContent
            output={props.output}
            presentation={props.presentation ?? PLAIN_TEXT_PRESENTATION}
            text={visible()}
          />
        )}
      </Show>
      <Show when={props.output.nextCursor !== null}>
        <div class="thread-output-pagination">
          <span>
            {formatByteCount(Math.min(loadedBytes(), props.output.byteLength))} de{" "}
            {formatByteCount(props.output.byteLength)}
          </span>
          <Show when={nextCursor() !== null} fallback={<span>Saída completa carregada</span>}>
            <button
              class="thread-output-load-button"
              disabled={loading()}
              onClick={() => void loadNext()}
              type="button"
            >
              {loading() ? "Carregando…" : "Carregar mais"}
            </button>
          </Show>
        </div>
      </Show>
      <Show when={failure()}>{(message) => <p class="thread-output-error">{message()}</p>}</Show>
    </div>
  );
}

function formatByteCount(bytes: number): string {
  if (bytes < 1_024) {
    return `${bytes} B`;
  }
  if (bytes < 1_048_576) {
    return `${(bytes / 1_024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} KiB`;
  }
  return `${(bytes / 1_048_576).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MiB`;
}
