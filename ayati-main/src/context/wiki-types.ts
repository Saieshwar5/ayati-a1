import type { EvolutionConfidence, ProfileFieldSource } from "./evolution-types.js";

export type WikiSectionKind = "key_value" | "bullet_list";
export type WikiSectionSavePolicy = "auto" | "conservative";

export interface WikiSchemaSection {
  name: string;
  kind: WikiSectionKind;
  savePolicy: WikiSectionSavePolicy;
  description: string;
  projectToProfile?: string[];
}

export interface UserWikiSchema {
  title: string;
  sections: WikiSchemaSection[];
}

export interface UserWikiSection {
  name: string;
  kind: WikiSectionKind;
  fields: Record<string, string>;
  items: string[];
}

export interface UserWikiDocument {
  title: string;
  lastUpdated: string;
  sections: Record<string, UserWikiSection>;
}

export interface UserWikiSectionUpdate {
  section: string;
  source?: ProfileFieldSource;
  set_fields?: Record<string, string>;
  add_items?: string[];
}

export interface WikiEvolutionResponse {
  section_updates: UserWikiSectionUpdate[];
  confidence: EvolutionConfidence;
  reasoning: string;
}
