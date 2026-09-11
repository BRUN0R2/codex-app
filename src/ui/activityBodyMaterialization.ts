import { type Accessor, createMemo } from "solid-js";

/** A slot keeps its last materialized body until another item needs that body. */
export function createActivityBodyMaterialization(
  itemKey: Accessor<string>,
  shouldMaterialize: Accessor<boolean>,
): Accessor<boolean> {
  let materializedKey: string | null = null;
  return createMemo(() => {
    const key = itemKey();
    if (materializedKey === key) {
      return true;
    }
    if (!shouldMaterialize()) {
      return false;
    }
    materializedKey = key;
    return true;
  });
}
