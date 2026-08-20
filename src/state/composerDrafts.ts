import type { Attachment, ConversationMode } from "../contracts/types";

export interface ComposerDraftState {
  readonly attachments: readonly Attachment[];
  readonly text: string;
}

const EMPTY_DRAFT: ComposerDraftState = {
  attachments: [],
  text: "",
};

export class ComposerDraftStore {
  readonly #drafts = new Map<string, ComposerDraftState>();

  read(key: string): ComposerDraftState {
    return this.#drafts.get(key) ?? EMPTY_DRAFT;
  }

  write(key: string, draft: ComposerDraftState): void {
    if (composerDraftIsEmpty(draft)) {
      this.#drafts.delete(key);
      return;
    }
    this.#drafts.set(key, {
      attachments: [...draft.attachments],
      text: draft.text,
    });
  }

  clear(key: string): void {
    this.#drafts.delete(key);
  }
}

export function composerDraftKey(
  threadId: string | null,
  mode: ConversationMode,
  workspace: string | null,
): string {
  return threadId === null ? `new:${mode}:${workspace ?? ""}` : `thread:${threadId}`;
}

export function sameComposerDraft(left: ComposerDraftState, right: ComposerDraftState): boolean {
  return (
    left.text === right.text &&
    left.attachments.length === right.attachments.length &&
    left.attachments.every((attachment, index) => {
      const candidate = right.attachments[index];
      return (
        candidate !== undefined &&
        attachment.id === candidate.id &&
        attachment.path === candidate.path
      );
    })
  );
}

function composerDraftIsEmpty(draft: ComposerDraftState): boolean {
  return draft.text.length === 0 && draft.attachments.length === 0;
}
