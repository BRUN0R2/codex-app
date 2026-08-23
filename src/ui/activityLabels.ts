import type { IconName } from "./Icon";

export function toolIconName(name: string): IconName {
  switch (name) {
    case "read_file":
      return "file";
    case "list_files":
      return "folder";
    case "search_text":
    case "code_search":
      return "search";
    case "web_search":
    case "web_fetch":
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
