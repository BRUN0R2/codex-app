import { describe, expect, it } from "vitest";

import type { Attachment } from "../contracts/types";
import { ComposerDraftStore, composerDraftKey, sameComposerDraft } from "./composerDrafts";

describe("composer drafts", () => {
  it("isolates drafts by thread and restores each one independently", () => {
    const store = new ComposerDraftStore();
    store.write("thread:first", { attachments: [], text: "primeiro" });
    store.write("thread:second", { attachments: [], text: "segundo" });

    expect(store.read("thread:first").text).toBe("primeiro");
    expect(store.read("thread:second").text).toBe("segundo");
    expect(store.read("thread:missing").text).toBe("");
  });

  it("keeps new-thread drafts separate by mode and workspace", () => {
    expect(composerDraftKey(null, "codex", "D:\\one")).not.toBe(
      composerDraftKey(null, "codex", "D:\\two"),
    );
    expect(composerDraftKey(null, "codex", "D:\\one")).not.toBe(
      composerDraftKey(null, "work", "D:\\one"),
    );
    expect(composerDraftKey("thread-1", "codex", "D:\\one")).toBe("thread:thread-1");
  });

  it("compares the submitted draft without relying on array identity", () => {
    const attachment = imageAttachment();
    expect(
      sameComposerDraft(
        { attachments: [attachment], text: "mensagem" },
        { attachments: [{ ...attachment }], text: "mensagem" },
      ),
    ).toBe(true);
    expect(
      sameComposerDraft(
        { attachments: [attachment], text: "mensagem nova" },
        { attachments: [attachment], text: "mensagem" },
      ),
    ).toBe(false);
  });
});

function imageAttachment(): Attachment {
  return {
    id: "image-1",
    kind: "image",
    mediaType: "image/png",
    name: "capture.png",
    path: "D:\\capture.png",
    size: 42,
  };
}
