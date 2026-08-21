import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        dash: {
          bg: "var(--dash-bg)",
          surface: "var(--dash-surface)",
          line: "var(--dash-line)",
          ink: "var(--dash-ink)",
          muted: "var(--dash-muted)",
          accent: "var(--dash-accent)",
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
