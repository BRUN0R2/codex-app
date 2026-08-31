import type { IconName } from "./Icon";
import type { TimelineMessages } from "./timelinePresentation";

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

export function toolLabel(name: string, messages: TimelineMessages): string {
  switch (name) {
    case "read_file":
      return messages.toolReadFile;
    case "list_files":
      return messages.toolListFiles;
    case "search_text":
      return messages.toolProjectSearch;
    case "web_search":
      return messages.toolWebSearch;
    case "browser_manage":
      return messages.toolBrowserControl;
    case "browser_snapshot":
      return messages.toolBrowserInspection;
    case "browser_screenshot":
      return messages.toolBrowserCapture;
    case "browser_pointer":
      return messages.toolBrowserPointer;
    case "browser_type":
      return messages.toolBrowserTyping;
    case "browser_viewport":
      return messages.toolBrowserViewport;
    case "browser_key":
      return messages.toolBrowserKeyboard;
    case "browser_wait":
      return messages.toolBrowserWait;
    case "browser_metrics":
      return messages.toolBrowserMetrics;
    case "view_image":
      return messages.toolImageView;
    case "poll_command":
      return messages.toolCommandMonitoring;
    case "read_output":
    case "read_thread_terminal":
      return messages.toolChatTerminal;
    default:
      return name;
  }
}

export function fileName(path: string): string {
  return path.split(/[\\/]/u).at(-1) ?? path;
}
