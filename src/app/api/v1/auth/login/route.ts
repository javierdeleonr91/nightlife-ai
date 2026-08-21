import { z } from "zod";
import { NextResponse } from "next/server";
import { verifyPassword } from "@nightlife/auth";
import { AppError } from "@nightlife/core/errors";
import { unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { apiError, clientIp, parseBody, rateLimit } from "@/lib/api";
import { createSession } from "@/lib/session";

const schema = z.object({ email: z.string().email(), password: z.string().min(1) });

export async function POST(request: Request) {
  try {
    rateLimit(`login:${clientIp(request)}`, 10, 300);
    const body = await parseBody(request, schema);
    const user = await prisma.user.findUnique({ where: { email: body.email.toLowerCase().trim() } });

    // Se verifica siempre, exista o no el usuario: si no, el tiempo de
    // respuesta delata qué correos están dados de alta.
    const stored = user?.passwordHash ?? "pbkdf2$210000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const valid = await verifyPassword(body.password, stored);

    if (!user || !valid) throw new AppError("UNAUTHENTICATED", "Email o contraseña incorrectos");

    await createSession({ id: user.id, email: user.email });
    return NextResponse.json({ id: user.id, email: user.email, name: user.name });
  } catch (error) {
    return apiError(error);
  }
}
