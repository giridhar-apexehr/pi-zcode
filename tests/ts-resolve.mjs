// Resolver shim for `npm test`.
//
// This extension is written in TypeScript but uses `.js` specifiers (the standard for
// TS ESM). Node's type stripping loads .ts files but does not rewrite `.js` to `.ts`
// when resolving, so map a failed `.js` resolve onto the sibling `.ts`.
//
// Needed only for tests; pi loads extensions through its own TS pipeline.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.endsWith(".js")) {
        const asTs = new URL(specifier, context.parentURL).href.replace(/\.js$/, ".ts");
        if (existsSync(new URL(asTs))) {
          return { url: asTs, shortCircuit: true };
        }
      }
      throw error;
    }
  },
});
