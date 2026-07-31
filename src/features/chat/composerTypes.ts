import type { Attachment } from "../../shared/codex/types";

export interface ComposerDraft {
  id: string;
  text: string;
  attachments: Attachment[];
}
