import type { Config } from "tailwindcss";

/**
 * Tailwind solo hace layout: grid, flex, gap, espaciado y responsive.
 *
 * El color, la tipografía, la forma y el movimiento viven en el design system
 * (src/design/*.css) como custom properties. Mezclar los dos sistemas de color
 * acaba en clases que se pisan y en dos fuentes de verdad; separarlos por
 * responsabilidad mantiene una sola.
 *
 * Por eso aquí no hay paleta: si necesitas un color, es un token.
 */
export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    // Sin `extend`: se sustituye la paleta entera para que un `bg-slate-800`
    // despistado no compile. La única forma de dar color es el token.
    colors: {
      transparent: "transparent",
      current: "currentColor",
      white: "#fff",
      black: "#000",
    },
    extend: {
      borderRadius: {
        sm: "var(--nl-r-sm)",
        md: "var(--nl-r-md)",
        lg: "var(--nl-r-lg)",
        xl: "var(--nl-r-xl)",
      },
    },
  },
  plugins: [],
} satisfies Config;
