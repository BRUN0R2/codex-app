import type { FileChange } from "./timelineTypes";

export function fileAction(change: FileChange): string {
  switch (change.kind) {
    case "add":
      return "Criado";
    case "delete":
      return "Excluído";
    case "update":
      return "Edição";
  }
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}
