import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  images: {
    // Dos orígenes distintos y por razones distintas:
    //
    //  · Supabase Storage — nuestro bucket de perfiles. Se declara explícito
    //    para que quede claro de dónde salen los avatares y las portadas.
    //  · cualquier host https — los flyers de los eventos los aloja la
    //    ticketera o el CDN que use cada club, y no hay forma de saber cuál
    //    de antemano. La alternativa sería apagar la optimización, que es
    //    peor: la portada de un perfil sin optimizar son 3 MB en el móvil de
    //    alguien con mala cobertura.
    remotePatterns: [
      ...(process.env.SUPABASE_URL
        ? [
            {
              protocol: "https" as const,
              hostname: new URL(process.env.SUPABASE_URL).hostname,
              pathname: "/storage/v1/object/public/**",
            },
          ]
        : []),
      { protocol: "https" as const, hostname: "**" },
    ],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
    ];
  },
};

export default config;
