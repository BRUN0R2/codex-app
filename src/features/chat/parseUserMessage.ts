import {
  isJsonObject,
  readString,
  type JsonObject,
  type JsonValue,
} from "../../shared/codex/types";
import {
  createLocalImageAttachment,
  fileName,
} from "./messageAttachments";
import type {
  ImageDetail,
  MessageAttachment,
  MessageEntry,
} from "./timelineTypes";

const FILES_ENVELOPE_HEADER = "# Files mentioned by the user:";
const REQUEST_MARKER = "## My request for Codex:";

export type UserMessageParseResult =
  | { ok: true; entry: MessageEntry }
  | { ok: false; error: string };

export function parseUserMessage(
  id: string,
  item: JsonObject,
): UserMessageParseResult {
  if (!Array.isArray(item.content)) {
    return {
      ok: false,
      error: `A mensagem ${id} não contém a lista de entradas esperada.`,
    };
  }

  const text: string[] = [];
  const attachments: MessageAttachment[] = [];
  for (let index = 0; index < item.content.length; index += 1) {
    const parsed = parseUserInput(id, index, item.content[index]);
    if (!parsed.ok) {
      return parsed;
    }
    if (parsed.text !== null) {
      const visibleText = visibleUserText(parsed.text);
      if (visibleText.length > 0) {
        text.push(visibleText);
      }
    }
    if (parsed.attachment !== null) {
      attachments.push(parsed.attachment);
    }
  }

  return {
    ok: true,
    entry: {
      type: "message",
      id,
      role: "user",
      text: text.join("\n"),
      attachments,
      phase: null,
      status: "complete",
    },
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

type ParsedUserInput =
  | { ok: true; attachment: MessageAttachment | null; text: string | null }
  | { ok: false; error: string };

function parseUserInput(
  messageId: string,
  index: number,
  value: JsonValue | undefined,
): ParsedUserInput {
  if (!isJsonObject(value)) {
    return invalidInput(messageId, index, "não é um objeto");
  }
  const type = readString(value, "type");
  const id = `${messageId}-${index}`;
  switch (type) {
    case "text": {
      const text = readString(value, "text");
      return text === undefined
        ? invalidInput(messageId, index, "não contém texto")
        : { ok: true, attachment: null, text };
    }
    case "image": {
      const url = readString(value, "url");
      const detail = readImageDetail(value.detail);
      return url === undefined || detail === undefined
        ? invalidInput(messageId, index, "contém uma imagem remota inválida")
        : {
            ok: true,
            attachment: {
              kind: "remoteImage",
              id,
              ...remoteMediaSource(url),
              detail,
            },
            text: null,
          };
    }
    case "localImage": {
      const path = readString(value, "path");
      const detail = readImageDetail(value.detail);
      return path === undefined || detail === undefined
        ? invalidInput(messageId, index, "contém uma imagem local inválida")
        : {
            ok: true,
            attachment: createLocalImageAttachment(
              id,
              path,
              fileName(path),
              undefined,
              detail,
            ),
            text: null,
          };
    }
    case "audio": {
      const url = readString(value, "url");
      return url === undefined
        ? invalidInput(messageId, index, "contém um áudio remoto inválido")
        : {
            ok: true,
            attachment: {
              kind: "remoteAudio",
              id,
              ...remoteMediaSource(url),
            },
            text: null,
          };
    }
    case "localAudio": {
      const path = readString(value, "path");
      return path === undefined
        ? invalidInput(messageId, index, "contém um áudio local inválido")
        : {
            ok: true,
            attachment: {
              kind: "localAudio",
              id,
              name: fileName(path),
              path,
            },
            text: null,
          };
    }
    case "mention":
    case "skill": {
      const name = readString(value, "name");
      const path = readString(value, "path");
      return name === undefined || path === undefined
        ? invalidInput(messageId, index, `contém ${type} inválido`)
        : {
            ok: true,
            attachment: { kind: type, id, name, path },
            text: null,
          };
    }
    default:
      return invalidInput(
        messageId,
        index,
        type === undefined
          ? "não contém o discriminador type"
          : `usa o tipo desconhecido ${type}`,
      );
  }
}

function invalidInput(
  messageId: string,
  index: number,
  reason: string,
): ParsedUserInput {
  return {
    ok: false,
    error: `A entrada ${index + 1} da mensagem ${messageId} ${reason}.`,
  };
}

function readImageDetail(value: JsonValue | undefined): ImageDetail | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  return value === "auto" ||
    value === "high" ||
    value === "low" ||
    value === "original"
    ? value
    : undefined;
}

function remoteMediaSource(value: string): {
  source: string;
  embedded: boolean;
} {
  if (value.startsWith("data:")) {
    return { source: "conteúdo incorporado", embedded: true };
  }
  try {
    return {
      source: new URL(value).hostname || "origem não identificada",
      embedded: false,
    };
  } catch {
    return { source: "origem não identificada", embedded: false };
  }
}
