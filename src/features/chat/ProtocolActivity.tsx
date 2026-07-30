import { For, Show } from "solid-js";

import {
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  GlobeIcon,
  ImageIcon,
  SparkIcon,
} from "../../shared/components/Icons";
import { ImagePreview } from "./ImagePreview";
import { fileName } from "./timelinePresentation";
import type {
  HookPromptEntry,
  ImageGenerationEntry,
  SleepEntry,
  WebSearchEntry,
} from "./timelineTypes";

interface ExpandableActivityProps<T> {
  entry: T;
  expanded: boolean;
  onToggle: () => void;
}

export function WebSearchActivity(
  props: ExpandableActivityProps<WebSearchEntry>,
) {
  const hasDetail = () =>
    props.entry.action !== null || props.entry.resultCount !== null;
  return (
    <div class="activity-detail-row">
      <button
        aria-expanded={hasDetail() ? props.expanded : undefined}
        class="activity-item-button"
        disabled={!hasDetail()}
        onClick={props.onToggle}
        type="button"
      >
        <GlobeIcon size={13} />
        <span class="activity-item-label">{webSearchLabel(props.entry)}</span>
        <Show when={hasDetail()}>
          <span class="activity-row-chevron">
            {props.expanded ? (
              <ChevronDownIcon size={12} />
            ) : (
              <ChevronRightIcon size={12} />
            )}
          </span>
        </Show>
      </button>
      <Show when={props.expanded && hasDetail()}>
        <div class="command-card protocol-card">
          <div class="detail-card-title">Pesquisa na web</div>
          <dl class="activity-facts">
            <div>
              <dt>Consulta</dt>
              <dd>{props.entry.query}</dd>
            </div>
            <Show when={props.entry.action !== null}>
              <div>
                <dt>Ação</dt>
                <dd>{webSearchActionLabel(props.entry)}</dd>
              </div>
            </Show>
            <Show when={props.entry.resultCount !== null}>
              <div>
                <dt>Resultados</dt>
                <dd>{props.entry.resultCount}</dd>
              </div>
            </Show>
          </dl>
        </div>
      </Show>
    </div>
  );
}

export function SleepActivity(props: { entry: SleepEntry }) {
  return (
    <div class="activity-item-static">
      <ClockIcon size={13} />
      <span class="activity-item-label">
        {props.entry.status === "inProgress" ? "Aguardando" : "Aguardou"}{" "}
        {formatDuration(props.entry.durationMs)}
      </span>
    </div>
  );
}

export function HookPromptActivity(
  props: ExpandableActivityProps<HookPromptEntry>,
) {
  return (
    <div class="activity-detail-row">
      <button
        aria-expanded={props.expanded}
        class="activity-item-button"
        disabled={props.entry.fragments.length === 0}
        onClick={props.onToggle}
        type="button"
      >
        <SparkIcon size={13} />
        <span class="activity-item-label">
          {props.entry.status === "inProgress"
            ? "Executando hook"
            : "Hook executado"}
        </span>
        <Show when={props.entry.fragments.length > 0}>
          <span class="activity-row-chevron">
            {props.expanded ? (
              <ChevronDownIcon size={12} />
            ) : (
              <ChevronRightIcon size={12} />
            )}
          </span>
        </Show>
      </button>
      <Show when={props.expanded && props.entry.fragments.length > 0}>
        <div class="command-card protocol-card">
          <div class="detail-card-title">Prompt do hook</div>
          <div class="hook-fragments">
            <For each={props.entry.fragments}>
              {(fragment) => <p>{fragment.text}</p>}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}

export function ImageGenerationActivity(
  props: ExpandableActivityProps<ImageGenerationEntry>,
) {
  const hasDetail = () =>
    props.entry.savedPath !== null ||
    props.entry.revisedPrompt !== null ||
    props.entry.resultAvailable;
  return (
    <div class="activity-detail-row">
      <button
        aria-expanded={hasDetail() ? props.expanded : undefined}
        class="activity-item-button"
        disabled={!hasDetail()}
        onClick={props.onToggle}
        type="button"
      >
        <ImageIcon size={13} />
        <span class="activity-item-label">
          {imageGenerationLabel(props.entry)}
        </span>
        <Show when={hasDetail()}>
          <span class="activity-row-chevron">
            {props.expanded ? (
              <ChevronDownIcon size={12} />
            ) : (
              <ChevronRightIcon size={12} />
            )}
          </span>
        </Show>
      </button>
      <Show when={props.expanded && hasDetail()}>
        <div class="command-card generated-image-card">
          <div class="detail-card-title">Imagem gerada</div>
          <div class="generated-image-content">
            <Show when={props.entry.savedPath}>
              {(path) => (
                <ImagePreview
                  name={fileName(path()) || "Imagem gerada"}
                  path={path()}
                />
              )}
            </Show>
            <div class="generated-image-copy">
              <Show when={props.entry.revisedPrompt !== null}>
                <p>{props.entry.revisedPrompt}</p>
              </Show>
              <Show
                when={
                  props.entry.resultAvailable && props.entry.savedPath === null
                }
              >
                <small>
                  O resultado binário existe, mas o app-server não forneceu um
                  arquivo local seguro para a prévia.
                </small>
              </Show>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}

function webSearchLabel(entry: WebSearchEntry): string {
  switch (entry.action?.type) {
    case "openPage":
      return `Abriu ${pageLabel(entry.action.source)}`;
    case "findInPage":
      return entry.action.pattern === null
        ? "Procurou na página"
        : `Procurou “${entry.action.pattern}” na página`;
    case "search":
    case "other":
    case undefined:
      return entry.status === "inProgress"
        ? `Pesquisando ${entry.query}`
        : `Pesquisou ${entry.query}`;
  }
}

function webSearchActionLabel(entry: WebSearchEntry): string {
  switch (entry.action?.type) {
    case "openPage":
      return `Abriu ${pageLabel(entry.action.source)}`;
    case "findInPage":
      return entry.action.pattern === null
        ? "Procurou na página"
        : `Procurou ${entry.action.pattern}`;
    case "search":
      return "Pesquisa";
    case "other":
      return "Outra ação";
    case undefined:
      return "Não informada";
  }
}

function imageGenerationLabel(entry: ImageGenerationEntry): string {
  if (entry.status === "failed") {
    return "Falhou ao gerar imagem";
  }
  return entry.status === "inProgress" ? "Gerando imagem" : "Imagem gerada";
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${durationMs} ms`;
  }
  const seconds = durationMs / 1_000;
  return seconds < 60
    ? `${seconds.toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s`
    : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

function pageLabel(value: string | null): string {
  return value === null ? "uma página" : value;
}
