import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const p = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export default defineConfig({
  test: { environment: "node", include: ["tests/**/*.test.ts"] },
  resolve: {
    alias: {
      "@nightlife/core": p("./src/packages/core"),
      "@nightlife/ticketing": p("./src/packages/ticketing"),
      "@nightlife/ai": p("./src/packages/ai"),
      "@nightlife/db": p("./src/packages/db"),
      "@nightlife/auth": p("./src/packages/auth"),
      "@nightlife/config": p("./src/packages/config"),
      "@": p("./src"),
    },
  },
});
