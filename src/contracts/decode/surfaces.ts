import { utf8ByteLength } from "../../utf8";
import type { Attachment, AttachmentImageResponse, OutputReadResponse } from "../types";
import {
  array,
  ContractError,
  exactRecord,
  identifier,
  integer,
  literal,
  MAX_OUTPUT_CHUNK_BYTES,
  nullableDecimalCursor,
  nullableText,
  text,
} from "./primitives";

export function decodeOutputReadResponse(value: unknown): OutputReadResponse {
  const object = exactRecord(value, "$", ["byteLength", "chunk", "nextCursor", "outputId"]);
  const byteLength = integer(object.byteLength, "$.byteLength", 0, Number.MAX_SAFE_INTEGER);
  const chunk = text(object.chunk, "$.chunk", MAX_OUTPUT_CHUNK_BYTES, true);
  const chunkBytes = utf8ByteLength(chunk);
  if (chunkBytes > byteLength) {
    throw new ContractError("$.chunk", "chunk cannot be larger than its output resource");
  }
  if (byteLength === 0 && chunk.length > 0) {
    throw new ContractError("$.chunk", "an empty output resource cannot contain text");
  }
  const nextCursor = nullableDecimalCursor(object.nextCursor, "$.nextCursor", "output");
  return {
    outputId: identifier(object.outputId, "$.outputId"),
    chunk,
    byteLength,
    nextCursor,
  };
}

export function decodeAttachments(value: unknown): readonly Attachment[] {
  return array(value, "$", decodeAttachment, 12);
}

export function decodeAttachment(value: unknown): Attachment {
  return decodeAttachmentAt(value, "$");
}

export function decodeAttachmentImageResponse(value: unknown): AttachmentImageResponse {
  const object = exactRecord(value, "$", ["dataUrl"]);
  return {
    dataUrl: text(object.dataUrl, "$.dataUrl", 36 * 1_048_576),
  };
}

export function decodeAttachmentAt(value: unknown, path: string): Attachment {
  const object = exactRecord(value, path, ["id", "kind", "mediaType", "name", "path", "size"]);
  return {
    id: identifier(object.id, `${path}.id`),
    name: text(object.name, `${path}.name`, 1_024),
    path: text(object.path, `${path}.path`, 4_096),
    kind: literal(object.kind, `${path}.kind`, ["file", "image"] as const),
    size: integer(object.size, `${path}.size`, 0, 25 * 1_048_576),
    mediaType: nullableText(object.mediaType, `${path}.mediaType`),
  };
}
