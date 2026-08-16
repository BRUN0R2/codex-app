import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^\.{1,2}\//u.test(specifier) && !/\.[^/]+$/u.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        // Fall through so Node can report the canonical resolution error.
      }
    }
    return nextResolve(specifier, context);
  },
});
