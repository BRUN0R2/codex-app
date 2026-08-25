import type { VisibleThreadItem } from "../contracts/types";
import {
  isCommandTool,
  isExplorationTool,
  isFileReadTool,
  isTerminalReadTool,
  isWebSearchTool,
} from "./activityLabels";
import { fileReadActivityTitle } from "./timelinePresentation";

export { isTerminalReadTool };

export type AgentActivityItem = Extract<
  VisibleThreadItem,
  { readonly type: "commandExecution" | "fileChange" | "toolExecution" }
>;

export type ImageViewItem = Extract<VisibleThreadItem, { readonly type: "toolExecution" }>;

export type AgentActivityKind =
  | "calledTools"
  | "fileChanges"
  | "fileReads"
  | "exploration"
  | "commands"
  | "terminalRead"
  | "webSearch";

export type AgentActivityRenderUnit =
  | {
      readonly kind: "activityGroup";
      readonly key: string;
      readonly items: readonly AgentActivityItem[];
    }
  | {
      readonly kind: "imageView";
      readonly key: string;
      readonly items: readonly ImageViewItem[];
    }
  | {
      readonly kind: "item";
      readonly key: string;
      readonly item: VisibleThreadItem;
    };

export interface AgentActivitySummary {
  readonly kind: AgentActivityKind;
  readonly label: string;
  readonly running: boolean;
}

export interface ActiveAgentActivity {
  readonly kind: AgentActivityKind;
  readonly label: string;
}

export class AgentActivityProjectionStore {
  #units: readonly AgentActivityRenderUnit[] = [];
  #unitsByIdentity = new Map<string, AgentActivityRenderUnit>();

  project(items: readonly VisibleThreadItem[]): readonly AgentActivityRenderUnit[] {
    const projected = splitAgentActivityUnits(items);
    const nextByIdentity = new Map<string, AgentActivityRenderUnit>();
    const units = projected.map((unit) => {
      const identity = agentActivityRenderUnitIdentity(unit);
      if (nextByIdentity.has(identity)) {
        throw new Error(
          `A projeção de atividade produziu a chave duplicada ${JSON.stringify(identity)}.`,
        );
      }
      const previous = this.#unitsByIdentity.get(identity);
      const stable =
        previous !== undefined && sameAgentActivityRenderUnit(previous, unit) ? previous : unit;
      nextByIdentity.set(identity, stable);
      return stable;
    });
    if (sameReferences(this.#units, units)) {
      return this.#units;
    }
    this.#units = units;
    this.#unitsByIdentity = nextByIdentity;
    return units;
  }
}

export function agentActivityRenderUnitIdentity(unit: AgentActivityRenderUnit): string {
  return `${unit.kind}:${unit.key}`;
}

export function splitAgentActivityUnits(
  items: readonly VisibleThreadItem[],
): readonly AgentActivityRenderUnit[] {
  const units: AgentActivityRenderUnit[] = [];
  let activityItems: AgentActivityItem[] = [];
  let imageItems: ImageViewItem[] = [];

  const flushActivity = () => {
    if (activityItems.length === 0) {
      return;
    }
    units.push({
      kind: "activityGroup",
      // A cauda cresce durante o streaming; o primeiro item é a identidade estável do grupo.
      key: `activity:${activityItems[0]?.id ?? "start"}`,
      items: activityItems,
    });
    activityItems = [];
  };

  const flushImages = () => {
    if (imageItems.length === 0) {
      return;
    }
    units.push({
      kind: "imageView",
      key: `image-view:${imageItems[0]?.id ?? "start"}`,
      items: imageItems,
    });
    imageItems = [];
  };

  for (const item of items) {
    if (item.type === "reasoning") {
      continue;
    }
    if (isImageViewItem(item)) {
      flushActivity();
      imageItems.push(item);
      continue;
    }
    if (isGroupableActivityItem(item)) {
      flushImages();
      activityItems.push(item);
      continue;
    }
    flushActivity();
    flushImages();
    units.push({ kind: "item", key: item.id, item });
  }
  flushActivity();
  flushImages();
  return units;
}

export function shouldRenderAgentActivityGroup(
  items: readonly AgentActivityItem[],
  isCurrent: boolean,
): boolean {
  return (
    isCurrent ||
    items.length > 1 ||
    items.some((item) => item.type === "fileChange" && item.changes.length > 1)
  );
}

export function summarizeAgentActivity(
  items: readonly AgentActivityItem[],
): readonly AgentActivitySummary[] {
  let calledTools = 0;
  let commands = 0;
  let exploration = 0;
  let fileReads = 0;
  let terminalReads = 0;
  let webSearch = 0;
  let calledToolsRunning = false;
  let commandsRunning = false;
  let explorationRunning = false;
  let fileReadsRunning = false;
  let terminalReadsRunning = false;
  let webSearchRunning = false;
  let changedPathCardinality: 0 | 1 | 2 = 0;
  let firstChangedPath: string | null = null;
  let fileChangesRunning = false;

  for (const item of items) {
    if (item.type === "commandExecution") {
      commands += 1;
      commandsRunning ||= item.status === "inProgress";
      continue;
    }
    if (item.type === "fileChange") {
      for (const change of item.changes) {
        if (changedPathCardinality === 0) {
          changedPathCardinality = 1;
          firstChangedPath = change.path;
        } else if (changedPathCardinality === 1 && change.path !== firstChangedPath) {
          changedPathCardinality = 2;
        }
      }
      fileChangesRunning ||= item.status === "inProgress";
      continue;
    }

    const name = item.name.toLowerCase();
    if (isWebSearchTool(name)) {
      webSearch += 1;
      webSearchRunning ||= item.status === "inProgress";
    } else if (isTerminalReadTool(name)) {
      terminalReads += 1;
      terminalReadsRunning ||= item.status === "inProgress";
    } else if (isFileReadTool(name)) {
      fileReads += 1;
      fileReadsRunning ||= item.status === "inProgress";
    } else if (isExplorationTool(name)) {
      exploration += 1;
      explorationRunning ||= item.status === "inProgress";
    } else if (isCommandTool(name)) {
      commands += 1;
      commandsRunning ||= item.status === "inProgress";
    } else {
      calledTools += 1;
      calledToolsRunning ||= item.status === "inProgress";
    }
  }

  const summaries: AgentActivitySummary[] = [];
  if (calledTools > 0) {
    summaries.push({
      kind: "calledTools",
      label: calledTools === 1 ? "Chamou uma ferramenta" : "Chamou ferramentas",
      running: calledToolsRunning,
    });
  }
  if (changedPathCardinality > 0) {
    summaries.push({
      kind: "fileChanges",
      label: changedPathCardinality === 1 ? "Editou um arquivo" : "Editou arquivos",
      running: fileChangesRunning,
    });
  }
  if (fileReads > 0) {
    summaries.push({
      kind: "fileReads",
      label: fileReadActivityTitle("completed", fileReads),
      running: fileReadsRunning,
    });
  }
  if (exploration > 0) {
    summaries.push({
      kind: "exploration",
      label: "Explorou arquivos",
      running: explorationRunning,
    });
  }
  if (commands > 0) {
    summaries.push({
      kind: "commands",
      label: commands === 1 ? "Executou um comando" : "Executou comandos",
      running: commandsRunning,
    });
  }
  if (terminalReads > 0) {
    summaries.push({
      kind: "terminalRead",
      label: "Leu o terminal do chat",
      running: terminalReadsRunning,
    });
  }
  if (webSearch > 0) {
    summaries.push({ kind: "webSearch", label: "Pesquisou na web", running: webSearchRunning });
  }
  return summaries;
}

export function agentActivitySummaryLabel(items: readonly AgentActivityItem[]): string {
  const labels = summarizeAgentActivity(items).map(({ label }, index) =>
    index === 0 ? label : lowerInitial(label),
  );
  return formatConjunction(labels);
}

export function activeAgentActivity(
  items: readonly AgentActivityItem[],
): ActiveAgentActivity | null {
  const runningFileReads = countRunningFileReads(items);
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item === undefined || item.status !== "inProgress") {
      continue;
    }
    if (item.type === "commandExecution") {
      return { kind: "commands", label: "Executando comando" };
    }
    if (item.type === "fileChange") {
      return { kind: "fileChanges", label: activeFileChangeLabel(item.changes) };
    }

    const name = item.name.toLowerCase();
    if (isWebSearchTool(name)) {
      return { kind: "webSearch", label: webSearchActivityTitle(item.description, item.status) };
    }
    if (isTerminalReadTool(name)) {
      return { kind: "terminalRead", label: "Lendo terminal do chat" };
    }
    if (isFileReadTool(name)) {
      return {
        kind: "fileReads",
        label: fileReadActivityTitle("inProgress", runningFileReads),
      };
    }
    if (isExplorationTool(name)) {
      return { kind: "exploration", label: "Explorando arquivos" };
    }
    if (isCommandTool(name)) {
      return { kind: "commands", label: "Executando comando" };
    }
    return {
      kind: "calledTools",
      label: item.description.trim() || "Chamando uma ferramenta",
    };
  }
  return null;
}

function countRunningFileReads(items: readonly AgentActivityItem[]): number {
  let count = 0;
  for (const item of items) {
    if (
      item.type === "toolExecution" &&
      item.status === "inProgress" &&
      isFileReadTool(item.name)
    ) {
      count += 1;
    }
  }
  return count;
}

export function webSearchActivityTitle(
  description: string,
  status: AgentActivityItem["status"],
): string {
  const detail = description.trim();
  const base = status === "inProgress" ? "Pesquisando na web" : "Pesquisou na web";
  if (isGenericWebSearchDescription(detail)) {
    return base;
  }
  if (/^pesquis(?:ando|ou) na web(?:\s+por\b)?/iu.test(detail)) {
    return detail;
  }
  return `${base} por ${detail}`;
}

function sameAgentActivityRenderUnit(
  left: AgentActivityRenderUnit,
  right: AgentActivityRenderUnit,
): boolean {
  if (left.kind !== right.kind || left.key !== right.key) {
    return false;
  }
  if (left.kind === "item" && right.kind === "item") {
    return left.item === right.item;
  }
  if (left.kind === "imageView" && right.kind === "imageView") {
    return sameReferences(left.items, right.items);
  }
  return (
    left.kind === "activityGroup" &&
    right.kind === "activityGroup" &&
    sameReferences(left.items, right.items)
  );
}

function sameReferences<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isGroupableActivityItem(item: VisibleThreadItem): item is AgentActivityItem {
  return (
    item.type === "commandExecution" || item.type === "fileChange" || item.type === "toolExecution"
  );
}

function isImageViewItem(item: VisibleThreadItem): item is ImageViewItem {
  return item.type === "toolExecution" && item.name.toLowerCase() === "view_image";
}

function activeFileChangeLabel(
  changes: Extract<AgentActivityItem, { type: "fileChange" }>["changes"],
): string {
  const plural = changes.length !== 1;
  if (changes.every(({ kind }) => kind.type === "add")) {
    return plural ? "Criando arquivos" : "Criando um arquivo";
  }
  if (changes.every(({ kind }) => kind.type === "delete")) {
    return plural ? "Excluindo arquivos" : "Excluindo um arquivo";
  }
  return plural ? "Editando arquivos" : "Editando um arquivo";
}

function isGenericWebSearchDescription(value: string): boolean {
  return (
    value.length === 0 ||
    /^(?:web search|pesquisa(?:r)? na web|pesquis(?:ando|ou) na web)$/iu.test(value)
  );
}

function lowerInitial(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toLocaleLowerCase("pt-BR")}${value.slice(1)}`;
}

function formatConjunction(values: readonly string[]): string {
  if (values.length < 2) {
    return values[0] ?? "Atividade do agente";
  }
  if (values.length === 2) {
    return `${values[0]} e ${values[1]}`;
  }
  return `${values.slice(0, -1).join(", ")} e ${values.at(-1)}`;
}
