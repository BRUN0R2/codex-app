import { presentAssistantText } from "./contentReferenceMarkers";

export interface CommentaryPresentation {
  readonly text: string;
  readonly visible: boolean;
}

export function createCommentaryPresentation(source: string): CommentaryPresentation {
  const text = presentAssistantText(source).trim();
  return {
    text,
    visible: text.length > 0,
  };
}
