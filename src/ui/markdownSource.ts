const ZERO_WIDTH_SPACE_CODE_POINT = 0x200b;
const RIGHT_TO_LEFT_MARK_CODE_POINT = 0x200f;
const BYTE_ORDER_MARK_CODE_POINT = 0xfeff;

export function normalizeMarkdownSource(source: string): string {
  const firstCodeUnit = source.charCodeAt(0);
  return (firstCodeUnit >= ZERO_WIDTH_SPACE_CODE_POINT &&
    firstCodeUnit <= RIGHT_TO_LEFT_MARK_CODE_POINT) ||
    firstCodeUnit === BYTE_ORDER_MARK_CODE_POINT
    ? source.slice(1)
    : source;
}
