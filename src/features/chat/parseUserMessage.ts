import {
  isJsonObject,
  readString,
  type Attachment,
  type JsonObject,
} from "../../shared/codex/types";
import type { MessageEntry } from "./timelineTypes";

const FILES_ENVELOPE_HEADER = "# Files mentioned by the user:";
const REQUEST_MARKER = "## My request for Codex:";

export function parseUserMessage(id: string, item: JsonObject): MessageEntry {
  const text: string[] = [];
  const attachments: Attachment[] = [];
  if (Array.isArray(item.content)) {
    item.content.forEach((value, index) => {
      if (!isJsonObject(value)) {
        return;
      }
      const inputType = readString(value, "type");
      if (inputType === "text") {
        const visibleText = visibleUserText(readString(value, "text") ?? "");
        if (visibleText.length > 0) {
          text.push(visibleText);
        }
        return;
      }
      const path = readString(value, "path");
      if (path === undefined) {
        return;
      }
      if (inputType === "localImage") {
        attachments.push({
          id: `${id}-${index}`,
          name: fileName(path),
          path,
          kind: "image",
          size: 0,
          mediaType: imageMediaType(path),
        });
      } else if (inputType === "mention") {
        attachments.push({
          id: `${id}-${index}`,
          name: readString(value, "name") ?? fileName(path),
          path,
          kind: "file",
          size: 0,
          mediaType: null,
        });
      }
    });
  }
  return {
    type: "message",
    id,
    role: "user",
    text: text.join("\n"),
    attachments,
    phase: null,
    status: "complete",
  };
}

export function visibleUserText(value: string): string {
  const text = value.trim();
  if (text === "</image>" || (text.startsWith("<image ") && text.endsWith(">"))) {
    return "";
  }
  if (!text.startsWith(FILES_ENVELOPE_HEADER)) {
    return text;
  }
  const requestIndex = text.indexOf(REQUEST_MARKER);
  return requestIndex < 0
    ? ""
    : text.slice(requestIndex + REQUEST_MARKER.length).trim();
}

function imageMediaType(path: string): string | null {
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

function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}
