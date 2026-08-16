import { presentAssistantText } from "./contentReferenceMarkers";

export interface CommentaryPresentation {
  readonly multiline: boolean;
  readonly text: string;
  readonly visible: boolean;
}

export function createCommentaryPresentation(source: string): CommentaryPresentation {
  const text = presentAssistantText(source).trim();
  return {
    multiline: text.includes("\n"),
    text,
    visible: text.length > 0,
  };
}
