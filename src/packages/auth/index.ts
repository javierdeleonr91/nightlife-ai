export * from "./crypto";

export const SESSION_COOKIE = "nl_session";
export const CHAT_COOKIE_PREFIX = "nl_chat_";

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  secure: true,
  maxAge: 60 * 60 * 24 * 7,
};
