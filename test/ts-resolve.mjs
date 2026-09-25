// Lets plain `node` run the app's TypeScript sources directly. Node 22+ strips
// types on its own, but it will not resolve the extensionless imports or the
// `@/` alias that the bundler handles at build time — this hook does both, so
// the tests need no build step and no test-runner dependency.
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = pathToFileURL(join(here, "..", "src") + "/").href;

register(
  "data:text/javascript," +
    encodeURIComponent(`
      const SRC = ${JSON.stringify(SRC)};
      export async function resolve(specifier, context, next) {
        if (specifier.startsWith("@/")) specifier = SRC + specifier.slice(2);
        try {
          return await next(specifier, context);
        } catch (error) {
          // A bare directory ("@/lib/rules") reports its own code, not NOT_FOUND.
          const retryable = ["ERR_MODULE_NOT_FOUND", "ERR_UNSUPPORTED_DIR_IMPORT"];
          if (!retryable.includes(error.code)) throw error;
          for (const suffix of [".ts", ".tsx", "/index.ts"]) {
            try {
              return await next(specifier + suffix, context);
            } catch {}
          }
          throw error;
        }
      }
    `),
  import.meta.url,
);
