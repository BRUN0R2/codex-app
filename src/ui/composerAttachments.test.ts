import { describe, expect, it } from "vitest";

import type { Attachment } from "../contracts/types";
import { COMPOSER_ATTACHMENT_MAXIMUM_COUNT, mergeComposerAttachments } from "./composerAttachments";

function attachment(path: string): Attachment {
  return {
    id: path,
    kind: "file",
    mediaType: null,
    name: path,
    path,
    size: 1,
  };
}

describe("composer attachment merging", () => {
  it("deduplicates paths without mutating the current collection", () => {
    const current = [attachment("C:/Work/README.md")];

    const result = mergeComposerAttachments(current, [
      attachment("c:/work/readme.md"),
      attachment("C:/Work/src/main.ts"),
    ]);

    expect(result).toEqual({
      attachments: [current[0], attachment("C:/Work/src/main.ts")],
      ok: true,
    });
    expect(current).toHaveLength(1);
  });

  it("reports the explicit limit instead of throwing from the input handler", () => {
    const current = Array.from({ length: COMPOSER_ATTACHMENT_MAXIMUM_COUNT }, (_, index) =>
      attachment(`C:/Work/file-${index}.txt`),
    );

    expect(mergeComposerAttachments(current, [attachment("C:/Work/extra.txt")])).toEqual({
      ok: false,
      reason: "limitExceeded",
    });
    expect(current).toHaveLength(COMPOSER_ATTACHMENT_MAXIMUM_COUNT);
  });
});
