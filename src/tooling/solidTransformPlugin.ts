import { type Plugin, withFilter } from "vite";
import solid, { type Options as SolidPluginOptions } from "vite-plugin-solid";

const SOLID_REFRESH_RUNTIME_ID = /^\/@solid-refresh$/u;
export const SOLID_TRANSFORM_ID = /^[^?]*\.[mc]?[jt]sx(?:\?.*)?$/iu;

export function createSolidTransformPlugin(options: Partial<SolidPluginOptions> = {}): Plugin {
  return withFilter(solid(options), {
    load: { id: SOLID_REFRESH_RUNTIME_ID },
    resolveId: { id: SOLID_REFRESH_RUNTIME_ID },
    transform: { id: SOLID_TRANSFORM_ID },
  });
}
