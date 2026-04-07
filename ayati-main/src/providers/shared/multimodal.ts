import { readFile } from "node:fs/promises";
import type {
  LlmImageContentPart,
  LlmMessage,
  LlmUserContent,
  LlmUserContentPart,
} from "../../core/contracts/llm-protocol.js";

export function hasImageInput(messages: LlmMessage[]): boolean {
  return messages.some((message) =>
    message.role === "user"
    && Array.isArray(message.content)
    && message.content.some((part) => part.type === "image")
  );
}

export function flattenUserTextContent(content: LlmUserContent): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .filter((part): part is Extract<LlmUserContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export async function toOpenAiCompatibleContent(
  content: LlmUserContent,
): Promise<string | Array<Record<string, unknown>>> {
  if (typeof content === "string") {
    return content;
  }

  const parts: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (part.type === "text") {
      parts.push({
        type: "text",
        text: part.text,
      });
      continue;
    }

    parts.push({
      type: "image_url",
      image_url: {
        url: await readImageAsDataUrl(part),
      },
    });
  }

  return parts;
}

export async function toAnthropicContent(
  content: LlmUserContent,
): Promise<string | Array<Record<string, unknown>>> {
  if (typeof content === "string") {
    return content;
  }

  const parts: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (part.type === "text") {
      parts.push({
        type: "text",
        text: part.text,
      });
      continue;
    }

    parts.push({
      type: "image",
      source: {
        type: "base64",
        media_type: part.mimeType,
        data: await readImageAsBase64(part),
      },
    });
  }

  return parts;
}

async function readImageAsBase64(part: LlmImageContentPart): Promise<string> {
  const bytes = await readFile(part.imagePath);
  return bytes.toString("base64");
}

async function readImageAsDataUrl(part: LlmImageContentPart): Promise<string> {
  const base64 = await readImageAsBase64(part);
  return `data:${part.mimeType};base64,${base64}`;
}
