const SOCIAL_PREFIX = /^(?:hello|hi|hey|thanks|thank you|good morning|good afternoon|good evening)\b/;
const INFORMATION_PREFIX = /^(?:what|where|why|how|when|which|who|explain|describe|summarize|summary|tell me|compare|define|clarify|list|find|search|locate|read|inspect|view|open|show|did|does|do|is|are|was|were)\b/;
const DURABLE_ACTION = /\b(?:build|create|make|write|save|edit|update|change|fix|implement|generate|add|remove|delete|move|rename|apply|run|test|set up|setup)\b/;
const DURABLE_INTENT = /\b(?:i want|we want|i need|we need|let(?:'|’)s|please (?:build|create|make|write|save|edit|update|change|fix|implement|generate|add|remove|delete|move|rename|apply|run|test|set up|setup)|can you (?:build|create|make|write|save|edit|update|change|fix|implement|generate|add|remove|delete|move|rename|apply|run|test|set up|setup))\b/;
const OBSERVATION_ONLY = [
  /\bread[- ]only\b/,
  /\bonly\s+(?:inspect|read|search|find|locate|list|view|show)\b/,
  /\b(?:do not|don't|never)\s+(?:modify|change|edit|write|create|save)(?:\s+(?:anything|files?|the\s+(?:file|directory|workspace)))?\b/,
  /\bwithout\s+(?:modifying|changing|editing|writing|creating|saving)(?:\s+anything)?\b/,
  /\bmake\s+no\s+changes\b/,
  /\bno\s+(?:file|filesystem|workspace)\s+changes\b/,
];

export interface TurnMutationConstraints {
  mutationForbidden: boolean;
  observationalOnly: boolean;
  mutationRequested: boolean;
  observationRequested: boolean;
}

export function deriveTurnMutationConstraints(message: string): TurnMutationConstraints {
  const normalized = message.trim().toLowerCase();
  const observationalOnly = OBSERVATION_ONLY.some((pattern) => pattern.test(normalized));
  const mutationRequested = !observationalOnly
    && (
      DURABLE_INTENT.test(normalized)
      || (!isInformationSeekingRequest(normalized) && hasConcreteMutationRequest(normalized))
    );
  return {
    mutationForbidden: observationalOnly,
    observationalOnly,
    mutationRequested,
    observationRequested: hasConcreteObservationRequest(normalized),
  };
}

export function requiresOperationalMode(message: string): boolean {
  const constraints = deriveTurnMutationConstraints(message);
  return constraints.mutationRequested || constraints.observationRequested;
}

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

function hasConcreteMutationRequest(text: string): boolean {
  if (!DURABLE_ACTION.test(text)) return false;
  return /\b(?:file|files|folder|directory|path|repo|repository|workspace|code|app|application|site|website|page|component|database|table|dataset|document|memory|window|layout|command|script|test|build|server|resource|record|row|column)\b/.test(text)
    || /(?:^|[\s"'`])(?:\.?\.?\/|\/)[^\s"'`]+/.test(text)
    || /\b[\w.-]+\.[a-z0-9]{1,12}\b/.test(text)
    || /https?:\/\//.test(text);
}

function hasConcreteObservationRequest(text: string): boolean {
  const resourceCue = /\b(?:file|files|folder|directory|path|repo|repository|workspace|source|code|config|script|function|method|module|implementation|logic|handler|handling|document|attachment|dataset|database|table|url|website|web page|resource|history|messages?|logs?|window)\b/.test(text);
  const exactTarget = /(?:^|[\s"'`])(?:\.?\.?\/|\/)[^\s"'`]+/.test(text)
    || /\b[\w.-]+\.[a-z0-9]{1,12}\b/.test(text)
    || /https?:\/\//.test(text)
    || /\b(?:RES-[0-9A-F]{24}|W-\d{8}-\d{4})\b/.test(text);
  const operationalVerb = /\b(?:read|inspect|open|view|show|find|locate|search|list|browse|check|query|profile|summari[sz]e|where)\b/.test(text);
  const pronounTarget = /\b(?:it|this|that|them|these|those)\b/.test(text);
  const referencedResource = /\b(?:this|that|the|attached|uploaded|current)\s+(?:file|folder|directory|repo|repository|workspace|source|code|config|document|attachment|dataset|database|table|resource|log)\b/.test(text);
  const inventoryQuestion = /\b(?:what|which)\s+(?:files?|folders?|directories|tables?|attachments?|resources?)\b.*\b(?:in|inside|under|within|from)\b/.test(text);
  const descriptiveReference = /\b(?:describe|explain)\b/.test(text) && referencedResource;
  return (operationalVerb && (resourceCue || exactTarget || pronounTarget))
    || descriptiveReference
    || inventoryQuestion;
}

function isInformationSeekingRequest(text: string): boolean {
  return /^(?:what|why|how|when|which|who|explain|describe|compare|define|clarify)\b/.test(text)
    || /^tell me (?:about|how|why|what|when|which|who)\b/.test(text)
    || /^(?:can|could|would) you (?:explain|describe|show me how|tell me how|teach me)\b/.test(text);
}
