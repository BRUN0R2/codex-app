import type { VisibleThreadItem } from "../contracts/types";

export type AgentActivityItem = Extract<
  VisibleThreadItem,
  { readonly type: "commandExecution" | "fileChange" | "toolExecution" }
>;

export type AgentActivityKind =
  | "calledTools"
  | "fileChanges"
  | "exploration"
  | "commands"
  | "webSearch";

export type AgentActivityRenderUnit =
  | {
      readonly kind: "activityGroup";
      readonly key: string;
      readonly items: readonly AgentActivityItem[];
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

const EXPLORATION_TOOLS = new Set(["code_search", "list_files", "read_file", "search_text"]);
const COMMAND_TOOLS = new Set(["run_shell", "shell"]);
const WEB_TOOLS = new Set(["web_fetch", "web_search"]);

export function splitAgentActivityUnits(
  items: readonly VisibleThreadItem[],
): readonly AgentActivityRenderUnit[] {
  const units: AgentActivityRenderUnit[] = [];
  let activityItems: AgentActivityItem[] = [];

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

  for (const item of items) {
    if (item.type === "reasoning") {
      continue;
    }
    if (isGroupableActivityItem(item)) {
      activityItems.push(item);
      continue;
    }
    flushActivity();
    units.push({ kind: "item", key: item.id, item });
  }
  flushActivity();
  return units;
}

export function shouldRenderAgentActivityGroup(
  items: readonly AgentActivityItem[],
  isCurrent: boolean,
  expanded = false,
): boolean {
  return (
    expanded ||
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
  let webSearch = 0;
  let calledToolsRunning = false;
  let commandsRunning = false;
  let explorationRunning = false;
  let webSearchRunning = false;
  const changedPaths = new Set<string>();
  let fileChangesRunning = false;

  for (const item of items) {
    if (item.type === "commandExecution") {
      commands += 1;
      commandsRunning ||= item.status === "inProgress";
      continue;
    }
    if (item.type === "fileChange") {
      for (const change of item.changes) {
        changedPaths.add(change.path);
      }
      fileChangesRunning ||= item.status === "inProgress";
      continue;
    }

    const name = item.name.toLowerCase();
    if (WEB_TOOLS.has(name)) {
      webSearch += 1;
      webSearchRunning ||= item.status === "inProgress";
    } else if (EXPLORATION_TOOLS.has(name)) {
      exploration += 1;
      explorationRunning ||= item.status === "inProgress";
    } else if (COMMAND_TOOLS.has(name)) {
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
  if (changedPaths.size > 0) {
    summaries.push({
      kind: "fileChanges",
      label: changedPaths.size === 1 ? "Editou um arquivo" : "Editou arquivos",
      running: fileChangesRunning,
    });
  }
  if (exploration > 0) {
    summaries.push({ kind: "exploration", label: "Leu arquivos", running: explorationRunning });
  }
  if (commands > 0) {
    summaries.push({
      kind: "commands",
      label: commands === 1 ? "Executou um comando" : "Executou comandos",
      running: commandsRunning,
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
    if (WEB_TOOLS.has(name)) {
      return { kind: "webSearch", label: webSearchActivityTitle(item.description, item.status) };
    }
    if (EXPLORATION_TOOLS.has(name)) {
      return { kind: "exploration", label: "Lendo arquivos" };
    }
    if (COMMAND_TOOLS.has(name)) {
      return { kind: "commands", label: "Executando comando" };
    }
    return {
      kind: "calledTools",
      label: item.description.trim() || "Chamando uma ferramenta",
    };
  }
  return null;
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

function isGroupableActivityItem(item: VisibleThreadItem): item is AgentActivityItem {
  if (item.type === "commandExecution" || item.type === "fileChange") {
    return true;
  }
  return item.type === "toolExecution" && !item.name.toLowerCase().includes("image");
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
