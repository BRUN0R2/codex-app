import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import type { Monitor } from "@tauri-apps/api/window";

import { exactRecord, finiteNumber, integer, text } from "../contracts/decode/primitives";

const MIN_PHYSICAL_POSITION = -(2 ** 31);
const MAX_PHYSICAL_POSITION = 2 ** 31 - 1;
const MAX_PHYSICAL_SIZE = 2 ** 32 - 1;
const MAX_MONITOR_NAME_BYTES = 4_096;

export function decodeTauriMonitor(value: unknown): Monitor {
  const monitor = exactRecord(value, "$", ["name", "position", "size", "workArea", "scaleFactor"]);
  const workArea = exactRecord(monitor.workArea, "$.workArea", ["position", "size"]);
  return {
    name: monitor.name === null ? null : text(monitor.name, "$.name", MAX_MONITOR_NAME_BYTES, true),
    position: decodePhysicalPosition(monitor.position, "$.position"),
    size: decodePhysicalSize(monitor.size, "$.size"),
    workArea: {
      position: decodePhysicalPosition(workArea.position, "$.workArea.position"),
      size: decodePhysicalSize(workArea.size, "$.workArea.size"),
    },
    scaleFactor: finiteNumber(
      monitor.scaleFactor,
      "$.scaleFactor",
      Number.MIN_VALUE,
      Number.MAX_VALUE,
    ),
  };
}

function decodePhysicalPosition(value: unknown, path: string): PhysicalPosition {
  const position = exactRecord(value, path, ["x", "y"]);
  return new PhysicalPosition(
    integer(position.x, `${path}.x`, MIN_PHYSICAL_POSITION, MAX_PHYSICAL_POSITION),
    integer(position.y, `${path}.y`, MIN_PHYSICAL_POSITION, MAX_PHYSICAL_POSITION),
  );
}

function decodePhysicalSize(value: unknown, path: string): PhysicalSize {
  const size = exactRecord(value, path, ["width", "height"]);
  return new PhysicalSize(
    integer(size.width, `${path}.width`, 1, MAX_PHYSICAL_SIZE),
    integer(size.height, `${path}.height`, 1, MAX_PHYSICAL_SIZE),
  );
}
