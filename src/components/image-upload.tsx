"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Icon } from "@/components/ui";
import { useToast } from "@/components/toast";
import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  uploadProblemMessage,
  validateUpload,
} from "@nightlife/core/media";

/**
 * Subir avatar o portada (§8, §9).
 *
 * El navegador nunca ve la clave de Supabase. Pide permiso a nuestro backend,
 * recibe una URL firmada para **una** ruta concreta, sube el archivo directo a
 * Storage y luego nos dice que ya está. Si el navegador se cierra a mitad, no
 * pasa nada: nadie ha tocado la base de datos todavía y la foto anterior sigue
 * en su sitio.
 *
 * Orden que no se puede invertir: subir → confirmar → borrar la vieja. Borrar
 * primero deja a alguien sin foto si la subida falla.
 *
 * Si el despliegue no tiene Storage configurado, no se enseña un botón que no
 * funciona: se enseña un campo para pegar una URL. Honesto y utilizable.
 */

type Variant = "avatar" | "cover";

export function ImageUpload({
  variant,
  slot,
  endpoint,
  current,
  label,
  name,
  configured,
}: {
  variant: Variant;
  /** «avatar» | «cover» | «logo». Lo interpreta el endpoint. */
  slot: string;
  /** /api/v1/promoters/me/media o /api/v1/clubs/{id}/media */
  endpoint: string;
  current: string | null;
  label: string;
  /** Para las iniciales cuando no hay imagen. */
  name: string;
  configured: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  const shown = preview ?? current;

  const initials = name
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase();

  async function pick(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    // Comprobación en el navegador: instantánea y sin gastar una petición.
    // La de verdad la repite el servidor antes de firmar nada.
    const problem = validateUpload({ contentType: file.type, bytes: file.size });
    if (problem) {
      toast.error(uploadProblemMessage(problem));
      return;
    }

    setBusy(true);
    const localPreview = URL.createObjectURL(file);
    setPreview(localPreview);

    try {
      // 1. permiso
      const authorize = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slot, contentType: file.type, size: file.size }),
      });
      const auth = await authorize.json().catch(() => null);
      if (!authorize.ok || !auth?.uploadUrl) {
        toast.error(auth?.error?.message ?? "No se ha podido subir la imagen.");
        setPreview(null);
        return;
      }

      // 2. subida directa a Storage con la URL firmada
      const put = await fetch(auth.uploadUrl, {
        method: "PUT",
        headers: { "content-type": file.type, "x-upsert": "true" },
        body: file,
      });
      if (!put.ok) {
        toast.error("No se ha podido subir la imagen.");
        setPreview(null);
        return;
      }

      // 3. confirmación: aquí es cuando cambia el perfil
      const confirm = await fetch(endpoint, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slot, path: auth.path }),
      });
      const done = await confirm.json().catch(() => null);
      if (!confirm.ok || !done?.ok) {
        toast.error(done?.error?.message ?? "No se ha podido guardar la imagen.");
        setPreview(null);
        return;
      }

      toast.ok(variant === "avatar" ? "Imagen actualizada" : "Portada actualizada");
      router.refresh();
    } catch {
      toast.error("No se ha podido subir la imagen.");
      setPreview(null);
    } finally {
      setBusy(false);
      URL.revokeObjectURL(localPreview);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      const response = await fetch(endpoint, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slot }),
      });
      if (!response.ok) {
        toast.error("No se ha podido eliminar la imagen.");
        return;
      }
      setPreview(null);
      toast.ok(variant === "avatar" ? "Imagen eliminada" : "Portada eliminada");
      router.refresh();
    } catch {
      toast.error("No se ha podido eliminar la imagen.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="nl-field">
      <span className="nl-label">{label}</span>

      <div className={variant === "avatar" ? "flex items-center gap-4" : "grid gap-3"}>
        <div className={variant === "avatar" ? "nl-upload-avatar" : "nl-upload-cover"}>
          {shown ? (
            <Image
              src={shown}
              alt=""
              fill
              sizes={variant === "avatar" ? "88px" : "(min-width: 640px) 40rem, 100vw"}
              className="object-cover"
              unoptimized={shown.startsWith("blob:")}
            />
          ) : variant === "avatar" ? (
            <span className="nl-upload-avatar__initials">{initials}</span>
          ) : (
            <span className="nl-upload-cover__empty">
              <Icon name="camera" size={22} />
              Añadir portada
            </span>
          )}
          {busy ? (
            <span className="nl-upload__veil">
              <span className="nl-spinner" />
              Subiendo…
            </span>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          {configured ? (
            <>
              <button
                type="button"
                onClick={() => input.current?.click()}
                disabled={busy}
                className="nl-btn nl-btn--quiet"
              >
                <Icon name="camera" size={17} />
                {shown ? (variant === "avatar" ? "Cambiar imagen" : "Cambiar portada") : "Subir"}
              </button>
              {shown ? (
                <button
                  type="button"
                  onClick={remove}
                  disabled={busy}
                  className="nl-btn nl-btn--ghost"
                >
                  Eliminar
                </button>
              ) : null}
            </>
          ) : (
            <p className="nl-hint">
              La subida de imágenes todavía no está configurada en este entorno. Puedes pegar una URL de imagen debajo.
            </p>
          )}
        </div>
      </div>

      <input
        ref={input}
        type="file"
        accept={ALLOWED_IMAGE_TYPES.join(",")}
        onChange={pick}
        className="nl-sr"
        tabIndex={-1}
        aria-hidden="true"
      />

      {configured ? (
        <p className="nl-hint">
          JPG, PNG o WebP, hasta {Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB.
        </p>
      ) : null}
    </div>
  );
}
