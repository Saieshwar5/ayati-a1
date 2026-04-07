import type { UserProfileContext } from "./types.js";
import type {
  UserWikiDocument,
  UserWikiSchema,
  UserWikiSection,
  UserWikiSectionUpdate,
  WikiSchemaSection,
  WikiSectionKind,
} from "./wiki-types.js";

const DEFAULT_WIKI_TITLE = "User Wiki";
const DEFAULT_SCHEMA_TITLE = "User Wiki Schema";

function normalizeLine(value: string): string {
  return value.replace(/\r/g, "").trim();
}

function sectionNameKey(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeFieldName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function appendUniqueItems(existing: string[], additions: string[]): string[] {
  const seen = new Set(existing.map((item) => item.trim().toLowerCase()));
  const result = [...existing];
  for (const addition of additions) {
    const trimmed = addition.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function createSection(section: WikiSchemaSection): UserWikiSection {
  return {
    name: section.name,
    kind: section.kind,
    fields: {},
    items: [],
  };
}

function getSection(doc: UserWikiDocument, sectionName: string): UserWikiSection {
  const section = doc.sections[sectionName];
  if (!section) {
    throw new Error(`Wiki section missing from document: ${sectionName}`);
  }
  return section;
}

export function defaultUserWikiSchema(): UserWikiSchema {
  return {
    title: DEFAULT_SCHEMA_TITLE,
    sections: [
      {
        name: "Identity",
        kind: "key_value",
        savePolicy: "auto",
        projectToProfile: ["name", "nickname", "occupation", "location", "active_hours"],
        description: "Durable identity details such as name, nickname, role, location, and active hours.",
      },
      {
        name: "Communication Preferences",
        kind: "key_value",
        savePolicy: "auto",
        projectToProfile: ["formality", "verbosity", "humor_receptiveness", "emoji_usage"],
        description: "How the user prefers the agent to communicate.",
      },
      {
        name: "Emotional Patterns",
        kind: "key_value",
        savePolicy: "conservative",
        projectToProfile: ["mood_baseline"],
        description: "Only durable, explicitly stated emotional baselines.",
      },
      {
        name: "Stress Triggers",
        kind: "bullet_list",
        savePolicy: "conservative",
        projectToProfile: ["stress_triggers"],
        description: "Topics or situations the user explicitly says are stressful.",
      },
      {
        name: "Joy Triggers",
        kind: "bullet_list",
        savePolicy: "conservative",
        projectToProfile: ["joy_triggers"],
        description: "Topics or situations the user explicitly says are joyful or motivating.",
      },
      {
        name: "Languages",
        kind: "bullet_list",
        savePolicy: "auto",
        projectToProfile: ["languages"],
        description: "Programming or spoken languages the user works with or uses.",
      },
      {
        name: "Skills",
        kind: "bullet_list",
        savePolicy: "auto",
        description: "Important durable skills the user has or is developing.",
      },
      {
        name: "Education",
        kind: "bullet_list",
        savePolicy: "auto",
        description: "Education history and notable study details.",
      },
      {
        name: "Work And Organizations",
        kind: "bullet_list",
        savePolicy: "auto",
        description: "Work history, teams, and organizations the user belongs to.",
      },
      {
        name: "Projects",
        kind: "bullet_list",
        savePolicy: "auto",
        projectToProfile: ["projects"],
        description: "Current or durable projects the user cares about.",
      },
      {
        name: "Interests And Hobbies",
        kind: "bullet_list",
        savePolicy: "auto",
        projectToProfile: ["interests"],
        description: "Durable interests, hobbies, and topics the user enjoys.",
      },
      {
        name: "People",
        kind: "bullet_list",
        savePolicy: "conservative",
        projectToProfile: ["people"],
        description: "Important people explicitly mentioned by the user.",
      },
      {
        name: "Contacts",
        kind: "bullet_list",
        savePolicy: "conservative",
        description: "Explicit contact information only when clearly useful later.",
      },
      {
        name: "Places And Addresses",
        kind: "bullet_list",
        savePolicy: "conservative",
        description: "Important locations or addresses when explicitly stated.",
      },
      {
        name: "Achievements",
        kind: "bullet_list",
        savePolicy: "auto",
        description: "Awards, milestones, and accomplishments.",
      },
      {
        name: "Durable Facts",
        kind: "bullet_list",
        savePolicy: "conservative",
        projectToProfile: ["facts"],
        description: "Other durable facts worth remembering later.",
      },
      {
        name: "Personal Preferences",
        kind: "bullet_list",
        savePolicy: "auto",
        description: "Preferences that do not fit the communication section.",
      },
      {
        name: "Constraints And Dislikes",
        kind: "bullet_list",
        savePolicy: "auto",
        description: "Constraints, dislikes, and things to avoid.",
      },
      {
        name: "Important Dates",
        kind: "bullet_list",
        savePolicy: "conservative",
        description: "Birthdays, anniversaries, and other explicitly useful dates.",
      },
      {
        name: "Unverified Or Needs Confirmation",
        kind: "bullet_list",
        savePolicy: "conservative",
        description: "Potential facts that should not be trusted until the user confirms them.",
      },
    ],
  };
}

function normalizeSchemaSection(section: WikiSchemaSection): WikiSchemaSection {
  return {
    ...section,
    name: normalizeFieldName(section.name),
    description: section.description.trim(),
    projectToProfile: section.projectToProfile?.map((item) => item.trim()).filter(Boolean),
  };
}

export function renderUserWikiSchema(schema: UserWikiSchema): string {
  const lines: string[] = [`# ${schema.title}`];
  for (const rawSection of schema.sections) {
    const section = normalizeSchemaSection(rawSection);
    lines.push("", `## ${section.name}`);
    lines.push(`- kind: ${section.kind}`);
    lines.push(`- save_policy: ${section.savePolicy}`);
    lines.push(`- description: ${section.description}`);
    if (section.projectToProfile && section.projectToProfile.length > 0) {
      lines.push(`- project_to_profile: ${section.projectToProfile.join(", ")}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function parseUserWikiSchema(raw: string): UserWikiSchema | null {
  const lines = raw.replace(/\r/g, "").split("\n");
  const sections: WikiSchemaSection[] = [];
  let title = DEFAULT_SCHEMA_TITLE;
  let current: Partial<WikiSchemaSection> | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("# ")) {
      title = trimmed.slice(2).trim() || DEFAULT_SCHEMA_TITLE;
      continue;
    }
    if (trimmed.startsWith("## ")) {
      if (current?.name && current.kind && current.savePolicy && typeof current.description === "string") {
        sections.push(normalizeSchemaSection(current as WikiSchemaSection));
      }
      current = {
        name: trimmed.slice(3).trim(),
        kind: "bullet_list",
        savePolicy: "auto",
        description: "",
      };
      continue;
    }
    if (!current || !trimmed.startsWith("- ")) continue;
    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex === -1) continue;
    const key = trimmed.slice(2, separatorIndex).trim().toLowerCase();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (key === "kind" && (value === "key_value" || value === "bullet_list")) {
      current.kind = value;
    } else if (key === "save_policy" && (value === "auto" || value === "conservative")) {
      current.savePolicy = value;
    } else if (key === "description") {
      current.description = value;
    } else if (key === "project_to_profile") {
      current.projectToProfile = value.split(",").map((item) => item.trim()).filter(Boolean);
    }
  }

  if (current?.name && current.kind && current.savePolicy && typeof current.description === "string") {
    sections.push(normalizeSchemaSection(current as WikiSchemaSection));
  }

  if (sections.length === 0) {
    return null;
  }

  return { title, sections };
}

export function createEmptyUserWiki(schema: UserWikiSchema): UserWikiDocument {
  const sections: Record<string, UserWikiSection> = {};
  for (const section of schema.sections) {
    sections[section.name] = createSection(section);
  }
  return {
    title: DEFAULT_WIKI_TITLE,
    lastUpdated: new Date(0).toISOString(),
    sections,
  };
}

function parseKeyValueLine(line: string): { key: string; value: string } | null {
  const trimmed = normalizeLine(line).replace(/^-\s*/, "");
  const separatorIndex = trimmed.indexOf(":");
  if (separatorIndex === -1) return null;
  const key = normalizeFieldName(trimmed.slice(0, separatorIndex));
  const value = trimmed.slice(separatorIndex + 1).trim();
  if (key.length === 0 || value.length === 0) return null;
  return { key, value };
}

function parseBulletLines(lines: string[]): string[] {
  const items: string[] = [];
  for (const line of lines) {
    const trimmed = normalizeLine(line);
    if (trimmed.length === 0) continue;
    const item = trimmed.startsWith("- ") ? trimmed.slice(2).trim() : trimmed;
    if (item.length === 0) continue;
    items.push(item);
  }
  return appendUniqueItems([], items);
}

function parseSectionBody(lines: string[], kind: WikiSectionKind): { fields: Record<string, string>; items: string[] } {
  if (kind === "key_value") {
    const fields: Record<string, string> = {};
    for (const line of lines) {
      const parsed = parseKeyValueLine(line);
      if (!parsed) continue;
      fields[parsed.key] = parsed.value;
    }
    return { fields, items: [] };
  }

  return { fields: {}, items: parseBulletLines(lines) };
}

export function parseUserWiki(raw: string, schema: UserWikiSchema): UserWikiDocument | null {
  const doc = createEmptyUserWiki(schema);
  const lines = raw.replace(/\r/g, "").split("\n");
  const sectionMap = new Map(schema.sections.map((section) => [sectionNameKey(section.name), section]));
  let currentSection: WikiSchemaSection | null = null;
  let currentBody: string[] = [];

  const flushSection = (): void => {
    if (!currentSection) return;
    const parsed = parseSectionBody(currentBody, currentSection.kind);
    doc.sections[currentSection.name] = {
      name: currentSection.name,
      kind: currentSection.kind,
      fields: parsed.fields,
      items: parsed.items,
    };
    currentBody = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("# ")) {
      doc.title = trimmed.slice(2).trim() || DEFAULT_WIKI_TITLE;
      continue;
    }
    if (/^Last Updated:/i.test(trimmed)) {
      const value = trimmed.slice(trimmed.indexOf(":") + 1).trim();
      if (value.length > 0) {
        doc.lastUpdated = value;
      }
      continue;
    }
    if (trimmed.startsWith("## ")) {
      flushSection();
      currentSection = sectionMap.get(sectionNameKey(trimmed.slice(3))) ?? null;
      currentBody = [];
      continue;
    }
    if (currentSection) {
      currentBody.push(line);
    }
  }
  flushSection();
  return doc;
}

export function renderUserWiki(doc: UserWikiDocument, schema: UserWikiSchema): string {
  const lines: string[] = [`# ${doc.title || DEFAULT_WIKI_TITLE}`, `Last Updated: ${doc.lastUpdated}`];

  for (const schemaSection of schema.sections) {
    const section = doc.sections[schemaSection.name] ?? createSection(schemaSection);
    lines.push("", `## ${schemaSection.name}`);
    if (schemaSection.kind === "key_value") {
      const fieldEntries = Object.entries(section.fields);
      for (const [key, value] of fieldEntries) {
        lines.push(`- ${key}: ${value}`);
      }
      continue;
    }
    for (const item of section.items) {
      lines.push(`- ${item}`);
    }
  }

  return lines.join("\n").trimEnd() + "\n";
}

export function buildWikiFromProfile(profile: UserProfileContext, schema: UserWikiSchema): UserWikiDocument {
  const doc = createEmptyUserWiki(schema);
  const identity = getSection(doc, "Identity");
  const communication = getSection(doc, "Communication Preferences");
  const emotional = getSection(doc, "Emotional Patterns");
  const stressTriggers = getSection(doc, "Stress Triggers");
  const joyTriggers = getSection(doc, "Joy Triggers");
  const languages = getSection(doc, "Languages");
  const interests = getSection(doc, "Interests And Hobbies");
  const facts = getSection(doc, "Durable Facts");
  const people = getSection(doc, "People");
  const projects = getSection(doc, "Projects");

  if (profile.name) identity.fields["Name"] = profile.name;
  if (profile.nickname) identity.fields["Nickname"] = profile.nickname;
  if (profile.occupation) identity.fields["Occupation"] = profile.occupation;
  if (profile.location) identity.fields["Location"] = profile.location;
  if (profile.active_hours) identity.fields["Active Hours"] = profile.active_hours;

  communication.fields["Formality"] = profile.communication.formality;
  communication.fields["Verbosity"] = profile.communication.verbosity;
  communication.fields["Humor Receptiveness"] = profile.communication.humor_receptiveness;
  communication.fields["Emoji Usage"] = profile.communication.emoji_usage;

  if (profile.emotional_patterns.mood_baseline !== "unknown") {
    emotional.fields["Mood Baseline"] = profile.emotional_patterns.mood_baseline;
  }

  stressTriggers.items = appendUniqueItems([], profile.emotional_patterns.stress_triggers);
  joyTriggers.items = appendUniqueItems([], profile.emotional_patterns.joy_triggers);
  languages.items = appendUniqueItems([], profile.languages);
  interests.items = appendUniqueItems([], profile.interests);
  facts.items = appendUniqueItems([], profile.facts);
  people.items = appendUniqueItems([], profile.people);
  projects.items = appendUniqueItems([], profile.projects);
  doc.lastUpdated = profile.last_updated;
  return doc;
}

function readField(section: UserWikiSection | undefined, key: string): string | null {
  if (!section) return null;
  const value = section.fields[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function projectUserProfileFromWiki(doc: UserWikiDocument): UserProfileContext {
  const profile: UserProfileContext = {
    name: readField(doc.sections["Identity"], "Name"),
    nickname: readField(doc.sections["Identity"], "Nickname"),
    occupation: readField(doc.sections["Identity"], "Occupation"),
    location: readField(doc.sections["Identity"], "Location"),
    languages: [...(doc.sections["Languages"]?.items ?? [])],
    interests: [...(doc.sections["Interests And Hobbies"]?.items ?? [])],
    facts: [...(doc.sections["Durable Facts"]?.items ?? [])],
    people: [...(doc.sections["People"]?.items ?? [])],
    projects: [...(doc.sections["Projects"]?.items ?? [])],
    communication: {
      formality: readField(doc.sections["Communication Preferences"], "Formality") ?? "balanced",
      verbosity: readField(doc.sections["Communication Preferences"], "Verbosity") ?? "balanced",
      humor_receptiveness: readField(doc.sections["Communication Preferences"], "Humor Receptiveness") ?? "medium",
      emoji_usage: readField(doc.sections["Communication Preferences"], "Emoji Usage") ?? "rare",
    },
    emotional_patterns: {
      mood_baseline: readField(doc.sections["Emotional Patterns"], "Mood Baseline") ?? "unknown",
      stress_triggers: [...(doc.sections["Stress Triggers"]?.items ?? [])],
      joy_triggers: [...(doc.sections["Joy Triggers"]?.items ?? [])],
    },
    active_hours: readField(doc.sections["Identity"], "Active Hours"),
    last_updated: doc.lastUpdated,
  };

  return profile;
}

export function matchWikiSectionName(sectionName: string, schema: UserWikiSchema): WikiSchemaSection | null {
  const key = sectionNameKey(sectionName);
  return schema.sections.find((section) => sectionNameKey(section.name) === key) ?? null;
}

export function applyWikiSectionUpdates(
  current: UserWikiDocument,
  schema: UserWikiSchema,
  updates: UserWikiSectionUpdate[],
): UserWikiDocument {
  const doc: UserWikiDocument = {
    ...current,
    sections: Object.fromEntries(
      Object.entries(current.sections).map(([key, value]) => [
        key,
        { name: value.name, kind: value.kind, fields: { ...value.fields }, items: [...value.items] },
      ]),
    ),
  };
  let changed = false;

  for (const update of updates) {
    const schemaSection = matchWikiSectionName(update.section, schema);
    if (!schemaSection) continue;
    const section = doc.sections[schemaSection.name] ?? createSection(schemaSection);

    if (schemaSection.kind === "key_value" && update.set_fields) {
      for (const [rawKey, rawValue] of Object.entries(update.set_fields)) {
        const key = normalizeFieldName(rawKey);
        const value = rawValue.trim();
        if (key.length === 0 || value.length === 0) continue;
        if (section.fields[key] !== value) {
          section.fields[key] = value;
          changed = true;
        }
      }
    }

    if (schemaSection.kind === "bullet_list" && update.add_items && update.add_items.length > 0) {
      const mergedItems = appendUniqueItems(section.items, update.add_items);
      if (mergedItems.length !== section.items.length) {
        section.items = mergedItems;
        changed = true;
      }
    }

    doc.sections[schemaSection.name] = section;
  }

  if (changed) {
    doc.lastUpdated = new Date().toISOString();
  }

  return doc;
}

export function parseWikiSectionContent(kind: WikiSectionKind, content: string): Pick<UserWikiSection, "fields" | "items"> {
  const lines = content.replace(/\r/g, "").split("\n");
  return parseSectionBody(lines, kind);
}

export function renderWikiSection(section: UserWikiSection): string {
  if (section.kind === "key_value") {
    return Object.entries(section.fields)
      .map(([key, value]) => `- ${key}: ${value}`)
      .join("\n")
      .trim();
  }
  return section.items.map((item) => `- ${item}`).join("\n").trim();
}
