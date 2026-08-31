const UTF8_ENCODER = new TextEncoder();
const UTF8_SCRATCH = new Uint8Array(64 * 1_024);

export function utf8ByteLength(value: string): number {
  return measureUtf8Bytes(value, Number.MAX_SAFE_INTEGER);
}

export function exceedsUtf8ByteLength(value: string, maximumBytes: number): boolean {
  if (value.length > maximumBytes) {
    return true;
  }
  return measureUtf8Bytes(value, maximumBytes) > maximumBytes;
}

function measureUtf8Bytes(value: string, stopAfterBytes: number): number {
  let offset = 0;
  let total = 0;
  while (offset < value.length) {
    const source = offset === 0 ? value : value.slice(offset);
    const { read, written } = UTF8_ENCODER.encodeInto(source, UTF8_SCRATCH);
    if (read === 0) {
      throw new Error("The UTF-8 text could not be measured.");
    }
    offset += read;
    total += written;
    if (total > stopAfterBytes) {
      return total;
    }
  }
  return total;
}
