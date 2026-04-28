export interface SoulContext {
  version: number;
  identity: {
    name?: string;
    role?: string;
    responsibility?: string;
  };
  behavior: {
    traits?: string[];
    working_style?: string[];
    communication?: string[];
  };
  boundaries?: string[];
}

export interface ControllerPrompts {
  understand: string;
  direct: string;
  reeval: string;
  systemEvent: string;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isSoulContext(value: unknown): value is SoulContext {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<SoulContext>;
  if (v.version !== 3) return false;
  if (!v.identity || typeof v.identity !== "object") return false;
  if (!v.behavior || typeof v.behavior !== "object") return false;

  const identity = v.identity;
  const behavior = v.behavior;

  return (
    (identity.name === undefined || typeof identity.name === "string") &&
    (identity.role === undefined || typeof identity.role === "string") &&
    (identity.responsibility === undefined || typeof identity.responsibility === "string") &&
    (behavior.traits === undefined || isStringArray(behavior.traits)) &&
    (behavior.working_style === undefined || isStringArray(behavior.working_style)) &&
    (behavior.communication === undefined || isStringArray(behavior.communication)) &&
    (v.boundaries === undefined || isStringArray(v.boundaries))
  );
}

export function emptySoulContext(): SoulContext {
  return {
    version: 3,
    identity: {
      name: "",
      role: "",
      responsibility: "",
    },
    behavior: {
      traits: [],
      working_style: [],
      communication: [],
    },
    boundaries: [],
  };
}
