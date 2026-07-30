import type { Attachment } from "../../shared/codex/types";
import type {
  ImageDetail,
  MessageAttachment,
} from "./timelineTypes";

export function toMessageAttachments(
  attachments: Attachment[],
): MessageAttachment[] {
  return attachments.map((attachment) =>
    attachment.kind === "image"
      ? createLocalImageAttachment(
          attachment.id,
          attachment.path,
          attachment.name,
          attachment.mediaType,
          null,
        )
      : {
          kind: "mention",
          id: attachment.id,
          name: attachment.name,
          path: attachment.path,
        },
  );
}

export function createLocalImageAttachment(
  id: string,
  path: string,
  name: string = fileName(path),
  mediaType: string | null = imageMediaType(path),
  detail: ImageDetail = null,
): Extract<MessageAttachment, { kind: "localImage" }> {
  return {
    kind: "localImage",
    id,
    name,
    path,
    mediaType,
    detail,
  };
}

export function imageMediaType(path: string): string | null {
  const extension = path.split(".").at(-1)?.toLocaleLowerCase("en-US");
  switch (extension) {
    case "gif":
      return "image/gif";
    case "jpeg":
    case "jpg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    default:
      return null;
  }
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}
