import { isDeepStrictEqual } from "node:util";
import type { LlmProvider } from "../core/contracts/provider.js";
import type { ConversationTurn } from "../memory/types.js";
import type { EvolutionConfidence, ProfileFieldSource } from "./evolution-types.js";
import { devLog, devWarn } from "../shared/index.js";
import { buildWikiExtractionMessages } from "./wiki-evolution-prompt.js";
import { applyWikiSectionUpdates } from "./wiki-format.js";
import type { UserProfileContext } from "./types.js";
import { UserWikiStore } from "./wiki-store.js";
import type { UserWikiDocument, UserWikiSchema, UserWikiSectionUpdate, WikiEvolutionResponse } from "./wiki-types.js";

const MIN_TURNS = 4;

function isFieldSource(value: unknown): value is ProfileFieldSource {
  return value === "explicit" || value === "inferred";
}

function shouldPersist(savePolicy: "auto" | "conservative", source: ProfileFieldSource | undefined, confidence: EvolutionConfidence): boolean {
  if (savePolicy === "auto") {
    if (source === "explicit") {
      return confidence === "medium" || confidence === "high";
    }
    return source === "inferred" && confidence === "high";
  }
  return source === "explicit" && confidence === "high";
}

function validateSectionUpdates(raw: unknown, schema: UserWikiSchema): UserWikiSectionUpdate[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const allowedSections = new Map(schema.sections.map((section) => [section.name.toLowerCase(), section]));
  const updates: UserWikiSectionUpdate[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const value = item as Record<string, unknown>;
    const sectionName = typeof value["section"] === "string" ? value["section"].trim() : "";
    if (sectionName.length === 0) continue;
    const schemaSection = allowedSections.get(sectionName.toLowerCase());
    if (!schemaSection) continue;

    const update: UserWikiSectionUpdate = { section: schemaSection.name };
    if (isFieldSource(value["source"])) {
      update.source = value["source"];
    }

    if (schemaSection.kind === "key_value" && value["set_fields"] && typeof value["set_fields"] === "object") {
      const fields: Record<string, string> = {};
      for (const [fieldKey, fieldValue] of Object.entries(value["set_fields"] as Record<string, unknown>)) {
        if (typeof fieldValue === "string" && fieldValue.trim().length > 0) {
          fields[fieldKey] = fieldValue.trim();
        }
      }
      if (Object.keys(fields).length > 0) {
        update.set_fields = fields;
      }
    }

    if (schemaSection.kind === "bullet_list" && Array.isArray(value["add_items"])) {
      const items = (value["add_items"] as unknown[])
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (items.length > 0) {
        update.add_items = items;
      }
    }

    if (update.set_fields || update.add_items) {
      updates.push(update);
    }
  }

  return updates;
}

function filterSectionUpdates(
  updates: UserWikiSectionUpdate[],
  schema: UserWikiSchema,
  confidence: EvolutionConfidence,
): UserWikiSectionUpdate[] {
  return updates.filter((update) => {
    const schemaSection = schema.sections.find((section) => section.name === update.section);
    if (!schemaSection) return false;
    return shouldPersist(schemaSection.savePolicy, update.source, confidence);
  });
}

export interface WikiEvolverOptions {
  provider: LlmProvider;
  wikiStore: UserWikiStore;
  currentProfile: UserProfileContext;
  onProfileUpdated?: (profile: UserProfileContext) => void;
}

export class WikiEvolver {
  private readonly provider: LlmProvider;
  private readonly wikiStore: UserWikiStore;
  private currentProfile: UserProfileContext;
  private readonly onProfileUpdated?: (profile: UserProfileContext) => void;

  constructor(options: WikiEvolverOptions) {
    this.provider = options.provider;
    this.wikiStore = options.wikiStore;
    this.currentProfile = options.currentProfile;
    this.onProfileUpdated = options.onProfileUpdated;
  }

  async evolveFromSession(turns: ConversationTurn[], handoffSummary?: string | null): Promise<void> {
    try {
      if (turns.length < MIN_TURNS) {
        devLog(`Wiki evolution skipped: only ${turns.length} turns (need ${MIN_TURNS})`);
        return;
      }

      const schema = await this.wikiStore.loadSchema();
      const wiki = await this.wikiStore.loadWiki(this.currentProfile);
      const messages = buildWikiExtractionMessages(turns, wiki, schema, handoffSummary);
      const output = await this.provider.generateTurn({ messages });

      if (output.type !== "assistant" || !output.content) {
        devWarn("Wiki evolution: unexpected LLM output type");
        return;
      }

      const parsed = this.parseResponse(output.content);
      if (!parsed) return;
      if (parsed.confidence === "none" || parsed.confidence === "low") {
        devLog(`Wiki evolution skipped: confidence is "${parsed.confidence}"`);
        return;
      }

      const updates = filterSectionUpdates(validateSectionUpdates(parsed.section_updates, schema), schema, parsed.confidence);
      if (updates.length === 0) {
        devLog("Wiki evolution skipped: no durable wiki updates passed write policy");
        return;
      }

      const nextWiki = applyWikiSectionUpdates(wiki, schema, updates);
      if (isDeepStrictEqual(nextWiki, wiki)) {
        devLog("Wiki evolution skipped: no net change after merge");
        return;
      }

      const profile = await this.wikiStore.saveWikiAndProjectProfile(nextWiki, schema);
      this.currentProfile = profile;
      devLog(`Wiki evolution complete: ${parsed.reasoning}`);
      this.onProfileUpdated?.(profile);
    } catch (err) {
      devWarn("Wiki evolution failed:", err instanceof Error ? err.message : String(err));
    }
  }

  private parseResponse(raw: string): WikiEvolutionResponse | null {
    let cleaned = raw.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    }

    try {
      const parsed = JSON.parse(cleaned) as WikiEvolutionResponse;
      if (!parsed.confidence || !Array.isArray(parsed.section_updates)) {
        devWarn("Wiki evolution: response missing required fields");
        return null;
      }
      return parsed;
    } catch {
      devWarn("Wiki evolution: failed to parse LLM JSON response");
      return null;
    }
  }
}
