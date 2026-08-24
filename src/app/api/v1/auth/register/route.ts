import { z } from "zod";
import { hashPassword } from "@nightlife/auth";
import { AppError } from "@nightlife/core/errors";
import { unsafePrismaForMigrationsOnly as prisma } from "@nightlife/db";
import { apiError, clientIp, parseBody, rateLimit } from "@/lib/api";
import { createSession } from "@/lib/session";
import { NextResponse } from "next/server";

const schema = z.object({
  name: z.string().min(2).max(80),
  email: z.string().email().max(160),
  password: z.string().min(8).max(200),
});

export async function POST(request: Request) {
  try {
    rateLimit(`register:${clientIp(request)}`, 5, 600);
    const body = await parseBody(request, schema);
    const email = body.email.toLowerCase().trim();

    const existing = await prisma.user.findUnique({ where: { email } });
    // Mismo mensaje que cualquier otro fallo de validación: no confirmamos
    // qué correos están registrados.
    if (existing) throw new AppError("CONFLICT", "No se ha podido crear la cuenta con esos datos");

    const user = await prisma.user.create({
      data: {
        email,
        name: body.name.trim(),
        // La contraseña vive aquí y solo aquí. `UserIdentity` guarda las
        // identidades externas (Google, Apple); meter también la contraseña
        // obligaría a un backfill de todas las cuentas que ya existen y dejaría
        // dos sitios donde mirar para saber lo mismo.
        passwordHash: await hashPassword(body.password),
      },
    });

    await createSession({ id: user.id, email: user.email });
    return NextResponse.json({ id: user.id, email: user.email, name: user.name });
  } catch (error) {
    return apiError(error);
  }
}
