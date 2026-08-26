import type { IconName } from "./Icon";

export type ToolCategory =
  | "browser"
  | "command"
  | "exploration"
  | "fileRead"
  | "terminalRead"
  | "web";

const TOOL_CATEGORY_NAMES: Readonly<Record<ToolCategory, readonly string[]>> = {
  browser: [
    "browser_key",
    "browser_manage",
    "browser_metrics",
    "browser_pointer",
    "browser_screenshot",
    "browser_snapshot",
    "browser_type",
    "browser_viewport",
    "browser_wait",
  ],
  command: ["poll_command", "run_shell", "shell"],
  exploration: ["code_search", "list_files", "search_text"],
  fileRead: ["read_file"],
  terminalRead: ["read_output", "read_thread_terminal"],
  web: ["web_fetch", "web_search"],
};

export function isBrowserTool(name: string): boolean {
  return TOOL_CATEGORY_NAMES.browser.includes(name.toLowerCase());
}

export function isCommandTool(name: string): boolean {
  return TOOL_CATEGORY_NAMES.command.includes(name.toLowerCase());
}

export function isExplorationTool(name: string): boolean {
  return TOOL_CATEGORY_NAMES.exploration.includes(name.toLowerCase());
}

export function isFileReadTool(name: string): boolean {
  return TOOL_CATEGORY_NAMES.fileRead.includes(name.toLowerCase());
}

export function isTerminalReadTool(name: string): boolean {
  return TOOL_CATEGORY_NAMES.terminalRead.includes(name.toLowerCase());
}

export function isWebSearchTool(name: string): boolean {
  return TOOL_CATEGORY_NAMES.web.includes(name.toLowerCase());
}

export function toolIconName(name: string): IconName {
  switch (name) {
    case "read_file":
      return "read";
    case "list_files":
      return "folder";
    case "search_text":
    case "code_search":
      return "search";
    case "web_search":
    case "web_fetch":
    case "browser_key":
    case "browser_manage":
    case "browser_metrics":
    case "browser_pointer":
    case "browser_screenshot":
    case "browser_snapshot":
    case "browser_type":
    case "browser_viewport":
    case "browser_wait":
      return "globe";
    case "shell":
    case "run_shell":
    case "poll_command":
    case "read_output":
    case "read_thread_terminal":
      return "terminal";
    case "apply_patch":
    case "edit_file":
      return "edit";
    case "view_image":
      return "image";
    default:
      return "sparkles";
  }
}

export function toolLabel(name: string): string {
  switch (name) {
    case "read_file":
      return "Leitura de arquivo";
    case "list_files":
      return "Listagem de arquivos";
    case "search_text":
      return "Busca no projeto";
    case "web_search":
      return "Pesquisa na web";
    case "browser_manage":
      return "Controle do navegador";
    case "browser_snapshot":
      return "Inspeção do navegador";
    case "browser_screenshot":
      return "Captura visual do navegador";
    case "browser_pointer":
      return "Mouse do navegador";
    case "browser_type":
      return "Digitação no navegador";
    case "browser_viewport":
      return "Viewport do navegador";
    case "browser_key":
      return "Teclado do navegador";
    case "browser_wait":
      return "Espera no navegador";
    case "browser_metrics":
      return "Métricas do navegador";
    case "view_image":
      return "Visualização de imagem";
    case "poll_command":
      return "Monitoramento de comando";
    case "read_output":
    case "read_thread_terminal":
      return "Terminal do chat";
    default:
      return name;
  }
}

export function fileName(path: string): string {
  return path.split(/[\\/]/u).at(-1) ?? path;
}
