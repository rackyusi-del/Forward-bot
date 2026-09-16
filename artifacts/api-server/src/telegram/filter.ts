import type { ContentType } from "./state";

export function messageContentType(message: any): ContentType | undefined {
  if (message.photo) return "photos";
  if (message.voice) return "voice";
  if (message.video || message.gif || message.videoNote) return "videos";
  if (message.document && !message.audio && !message.sticker) return "files";
  if (!message.media && message.message?.trim()) return "messages";
  if (message.media || message.audio || message.sticker) return "other";
  return undefined;
}

export function matchesContentType(message: any, type: ContentType): boolean {
  return messageContentType(message) === type;
}

export function contentLabel(type: ContentType): string {
  return {
    files: "Files",
    photos: "Photos",
    videos: "Videos",
    voice: "Voice",
    messages: "Messages",
    other: "Other Media",
  }[type];
}

export function itemName(message: any, type: ContentType, messageId: number): string {
  const fileName = message.file?.name;
  if (typeof fileName === "string" && fileName.trim()) return fileName.trim();
  const text = typeof message.message === "string" ? message.message.trim() : "";
  if (text) return text.replace(/\s+/g, " ").slice(0, 70);
  return `${contentLabel(type)} #${messageId}`;
}