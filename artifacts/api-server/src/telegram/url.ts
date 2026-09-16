import type { SourceConfig } from "./state";

export function parseTelegramSourceUrl(value: string): SourceConfig | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return undefined;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== "t.me" && hostname !== "telegram.me") return undefined;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (!parts.length || parts[0] === "s") return undefined;

  if (parts[0] === "c" && /^\d+$/.test(parts[1] ?? "")) {
    const internalId = parts[1];
    return {
      chatId: Number(`-100${internalId}`),
      label: `private chat ${internalId}`,
    };
  }

  const username = parts[0];
  if (!/^[A-Za-z0-9_]{5,}$/.test(username) || username === "joinchat") {
    return undefined;
  }
  return { chatId: `@${username}`, label: `@${username}` };
}