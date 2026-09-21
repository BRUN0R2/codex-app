import { formatMessage, type TranslationMessages } from "../i18n/messages";
import { projectName } from "../state/projects";

export type EmptyConversationMode = "chat" | "work" | "codex";

export function emptyConversationTitle(
  mode: EmptyConversationMode,
  workspace: string | null,
  messages: TranslationMessages["timeline"],
): string {
  switch (mode) {
    case "chat":
      return messages.ready;
    case "work":
      return messages.workQuestion;
    case "codex":
      return workspace === null
        ? messages.todayQuestion
        : formatMessage(messages.projectQuestion, { project: projectName(workspace) });
  }
}
