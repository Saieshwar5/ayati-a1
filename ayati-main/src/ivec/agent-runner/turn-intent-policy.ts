const SOCIAL_PREFIX = /^(?:hello|hi|hey|thanks|thank you|good morning|good afternoon|good evening)\b/;
const INFORMATION_PREFIX = /^(?:what|where|why|how|when|which|who|explain|describe|summarize|summary|tell me|compare|define|clarify|list|did|does|do|is|are|was|were)\b/;
const DURABLE_ACTION = /\b(?:build|create|make|write|save|edit|update|change|fix|implement|generate|add|remove|delete|move|rename|apply|run|test|set up|setup)\b/;
const DURABLE_INTENT = /\b(?:i want|we want|i need|we need|let(?:'|’)s|please (?:build|create|make|write|save|edit|update|change|fix|implement|generate|add|remove|delete|move|rename|apply|run|test|set up|setup)|can you (?:build|create|make|write|save|edit|update|change|fix|implement|generate|add|remove|delete|move|rename|apply|run|test|set up|setup))\b/;

/**
 * Conservative gate for omitting workstream-routing controls. False means the
 * normal routing surface remains available; only unmistakable conversation or
 * information requests return true.
 */
export function isClearlyConversationOnlyRequest(message: string): boolean {
  let normalized = message.trim().toLowerCase();
  if (!normalized || DURABLE_INTENT.test(normalized)) {
    return false;
  }
  normalized = normalized
    .replace(/^do not (?:edit|change|modify|create|write|save)\b[,.]?\s*/, "")
    .replace(/^(?:(?:now|briefly|quickly|simply|please)\s+)+/, "")
    .replace(/^(?:can|could|would) you\s+/, "");
  if (INFORMATION_PREFIX.test(normalized)) {
    return true;
  }
  return SOCIAL_PREFIX.test(normalized) && !DURABLE_ACTION.test(normalized);
}
