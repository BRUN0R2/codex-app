import type { Attachment } from "../contracts/types";

export const COMPOSER_ATTACHMENT_MAXIMUM_COUNT = 12;

export type ComposerAttachmentMergeResult =
  | { readonly ok: true; readonly attachments: readonly Attachment[] }
  | { readonly ok: false; readonly reason: "limitExceeded" };

export function mergeComposerAttachments(
  current: readonly Attachment[],
  incoming: readonly Attachment[],
): ComposerAttachmentMergeResult {
  const paths = new Set(current.map((attachment) => attachment.path.toLocaleLowerCase("en-US")));
  const result = [...current];
  for (const attachment of incoming) {
    const key = attachment.path.toLocaleLowerCase("en-US");
    if (!paths.has(key)) {
      result.push(attachment);
      paths.add(key);
    }
  }
  if (result.length > COMPOSER_ATTACHMENT_MAXIMUM_COUNT) {
    return { ok: false, reason: "limitExceeded" };
  }
  return { attachments: result, ok: true };
}
