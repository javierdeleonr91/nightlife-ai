import type { Metadata, Viewport } from "next";
import { Archivo, Instrument_Sans, Martian_Mono } from "next/font/google";
import { THEME_BACKGROUND } from "@/design/theme";
import "./globals.css";

/**
 * Las tres voces tipográficas del producto.
 *
 * Archivo variable en ancho expandido es la que hace que un titular parezca
 * cartel de fiesta y no etiqueta de formulario. Instrument Sans lleva la
 * interfaz sin llamar la atención. Martian Mono solo aparece en cifras, que
 * es donde un ancho fijo se nota para bien.
 *
 * `next/font` las autoaloja: cero peticiones a Google en tiempo de ejecución
 * y cero salto de layout, que en la página pública de un club vale más que
 * cualquier otra optimización.
 */

// OJO: `axes` solo es válido si la fuente se carga como variable. Poner
// `axes` y `weight: ["600","700","800"]` a la vez hace que next/font falle el
// build con «Invalid axes... expected variable font». Ya ha pasado varias
// veces: si añades pesos fijos aquí, quita `axes`, y si quieres `wdth`, no
// pongas pesos. Sin `weight`, Archivo se carga variable y el CSS elige el
// peso con font-weight normalmente.
const display = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-display",
  display: "swap",
});

const ui = Instrument_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-ui",
  display: "swap",
});

const mono = Martian_Mono({
  subsets: ["latin"],
  weight: ["400", "600"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Nightlife Automatico", template: "%s" },
  description: "Responde y vende por ti. El checkout sigue siendo el de tu ticketera.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: THEME_BACKGROUND,
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={`${display.variable} ${ui.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
