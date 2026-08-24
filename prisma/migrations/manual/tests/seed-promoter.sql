-- ════════════════════════════════════════════════════════════════════
-- Datos que las pruebas de RLS necesitan y el fixture legacy no puede
-- tener: un canal de RRPP con su conversación.
--
-- Va aparte del fixture a propósito. El fixture representa el estado
-- ANTERIOR a la migración, donde un canal de promoter no existía ni podía
-- existir. Estas filas solo son posibles después de 001.
--
-- Se ejecuta con el rol de migraciones, después de 001 y antes de las
-- pruebas de RLS.
-- ════════════════════════════════════════════════════════════════════

BEGIN;

INSERT INTO channels (id, "ownerType", "clubId", "promoterId", type, status,
                      "externalAccountId", "createdAt", "updatedAt")
VALUES ('rp_ch_javi_ig', 'PROMOTER', NULL, 'prom_javi', 'INSTAGRAM', 'CONNECTED',
        'ig_javi_123', now(), now())
ON CONFLICT (id) DO NOTHING;

-- Owner omitido: lo deriva el trigger. Es también una comprobación
-- silenciosa de que la derivación funciona en el camino normal.
INSERT INTO customers (id, "channelId", "externalUserHash", "displayName", locale, "createdAt")
VALUES ('rp_cus_javi', 'rp_ch_javi_ig', 'rp_hash_javi', 'Cliente de Javi', 'es', now())
ON CONFLICT (id) DO NOTHING;

-- contextClubId = club_mon: en esta conversación se habló de MON. Es
-- justo el caso que prueba que el contexto NO concede acceso: MON no puede
-- leerla aunque se le mencione.
INSERT INTO conversations (id, "customerId", "channelId", "channelType",
                           "contextClubId", status, "lastMessageAt", "createdAt", "expiresAt")
VALUES ('rp_cv_javi', 'rp_cus_javi', 'rp_ch_javi_ig', 'INSTAGRAM',
        'club_mon', 'AI_ACTIVE', now(), now(), now() + interval '90 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO messages (id, "conversationId", role, content, "createdAt")
VALUES ('rp_ms_1', 'rp_cv_javi', 'CUSTOMER', 'bro qué tienes el sábado?', now())
ON CONFLICT (id) DO NOTHING;

COMMIT;
