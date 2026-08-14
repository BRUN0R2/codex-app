const CONTENT_REFERENCE_START = "\uE200";
const CONTENT_REFERENCE_END = "\uE201";
const COMPLETE_CONTENT_REFERENCE = /\uE200[^\uE201]*\uE201/gu;
const STREAMING_CONTENT_REFERENCE_TAIL = /\uE200[^\uE201]*$/u;

/**
 * Removes provider-only content-reference envelopes before assistant text reaches the UI.
 *
 * The second replacement also hides an envelope that is split across streaming deltas. The raw
 * text remains in the conversation state, so the closing delimiter can still complete it later.
 */
export function presentAssistantText(source: string): string {
  if (!source.includes(CONTENT_REFERENCE_START)) {
    return source;
  }
  return source
    .replaceAll(COMPLETE_CONTENT_REFERENCE, "")
    .replace(STREAMING_CONTENT_REFERENCE_TAIL, "");
}

export function containsContentReferenceMarker(source: string): boolean {
  return source.includes(CONTENT_REFERENCE_START) || source.includes(CONTENT_REFERENCE_END);
}
