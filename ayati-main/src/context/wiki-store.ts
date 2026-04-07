import { access, copyFile, mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { UserProfileContext } from "./types.js";
import { readTextFile, writeJsonFileAtomic, backupFile } from "./loaders/io.js";
import {
  applyWikiSectionUpdates,
  buildWikiFromProfile,
  createEmptyUserWiki,
  defaultUserWikiSchema,
  matchWikiSectionName,
  parseUserWiki,
  parseUserWikiSchema,
  parseWikiSectionContent,
  projectUserProfileFromWiki,
  renderUserWiki,
  renderUserWikiSchema,
  renderWikiSection,
} from "./wiki-format.js";
import type {
  UserWikiDocument,
  UserWikiSchema,
  UserWikiSectionUpdate,
  WikiSchemaSection,
} from "./wiki-types.js";
import { devWarn } from "../shared/index.js";

const USER_WIKI_FILE = "user.wiki";
const USER_WIKI_SCHEMA_FILE = "user.wiki.schema";
const USER_PROFILE_FILE = "user_profile.json";

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeTextFileAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, content, "utf-8");
  await rename(tmpPath, filePath);
}

async function backupTextFileIfExists(
  filePath: string,
  historyDir: string,
  baseName: string,
  extension: string,
): Promise<void> {
  if (!await exists(filePath)) {
    return;
  }
  await mkdir(historyDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destPath = resolve(historyDir, `${baseName}_${timestamp}.${extension}`);
  await copyFile(filePath, destPath);
}

export interface UserWikiStoreOptions {
  contextDir: string;
  historyDir: string;
}

export interface WikiSearchMatch {
  section: string;
  snippet: string;
}

export interface WikiSectionSummary {
  name: string;
  kind: string;
  entryCount: number;
  hasContent: boolean;
}

export class UserWikiStore {
  private readonly contextDir: string;
  private readonly historyDir: string;

  constructor(options: UserWikiStoreOptions) {
    this.contextDir = options.contextDir;
    this.historyDir = options.historyDir;
  }

  get wikiPath(): string {
    return resolve(this.contextDir, USER_WIKI_FILE);
  }

  get schemaPath(): string {
    return resolve(this.contextDir, USER_WIKI_SCHEMA_FILE);
  }

  get profilePath(): string {
    return resolve(this.contextDir, USER_PROFILE_FILE);
  }

  async loadSchema(): Promise<UserWikiSchema> {
    if (!await exists(this.schemaPath)) {
      return defaultUserWikiSchema();
    }
    const raw = await readTextFile(this.schemaPath, USER_WIKI_SCHEMA_FILE);
    if (!raw) {
      return defaultUserWikiSchema();
    }
    const parsed = parseUserWikiSchema(raw);
    if (!parsed) {
      devWarn("User wiki schema missing or invalid. Using default wiki schema.");
      return defaultUserWikiSchema();
    }
    return parsed;
  }

  async ensureSchemaFile(): Promise<UserWikiSchema> {
    const schema = await this.loadSchema();
    if (!await exists(this.schemaPath)) {
      await writeTextFileAtomic(this.schemaPath, renderUserWikiSchema(schema));
    }
    return schema;
  }

  async loadWiki(seedProfile?: UserProfileContext | null): Promise<UserWikiDocument> {
    const schema = await this.loadSchema();
    if (!await exists(this.wikiPath)) {
      return seedProfile ? buildWikiFromProfile(seedProfile, schema) : createEmptyUserWiki(schema);
    }
    const raw = await readTextFile(this.wikiPath, USER_WIKI_FILE);
    if (!raw) {
      return seedProfile ? buildWikiFromProfile(seedProfile, schema) : createEmptyUserWiki(schema);
    }
    const parsed = parseUserWiki(raw, schema);
    if (!parsed) {
      devWarn("User wiki missing or invalid. Using reconstructed wiki context.");
      return seedProfile ? buildWikiFromProfile(seedProfile, schema) : createEmptyUserWiki(schema);
    }
    return parsed;
  }

  async ensureInitialized(seedProfile: UserProfileContext): Promise<UserWikiDocument> {
    const schema = await this.ensureSchemaFile();
    const existingWiki = await this.loadWiki(seedProfile);
    if (!await exists(this.wikiPath)) {
      await writeTextFileAtomic(this.wikiPath, renderUserWiki(existingWiki, schema));
    }
    return existingWiki;
  }

  async syncProfileFromWiki(seedProfile: UserProfileContext): Promise<UserProfileContext> {
    const doc = await this.ensureInitialized(seedProfile);
    const profile = projectUserProfileFromWiki(doc);
    await this.writeProfile(profile);
    return profile;
  }

  async writeWiki(doc: UserWikiDocument, schema?: UserWikiSchema): Promise<void> {
    const activeSchema = schema ?? await this.loadSchema();
    const rendered = renderUserWiki(doc, activeSchema);
    const current = await exists(this.wikiPath) ? await readTextFile(this.wikiPath, USER_WIKI_FILE) : undefined;
    if (current === rendered) {
      return;
    }
    await backupTextFileIfExists(this.wikiPath, this.historyDir, "user_wiki", "wiki");
    await writeTextFileAtomic(this.wikiPath, rendered);
  }

  async writeProfile(profile: UserProfileContext): Promise<void> {
    const rendered = JSON.stringify(profile, null, 2) + "\n";
    const current = await exists(this.profilePath) ? await readTextFile(this.profilePath, USER_PROFILE_FILE) : undefined;
    if (current === rendered) {
      return;
    }
    if (await exists(this.profilePath)) {
      await backupFile(this.profilePath, this.historyDir, "user_profile");
    }
    await writeJsonFileAtomic(this.profilePath, profile);
  }

  async saveWikiAndProjectProfile(doc: UserWikiDocument, schema?: UserWikiSchema): Promise<UserProfileContext> {
    const activeSchema = schema ?? await this.loadSchema();
    await this.writeWiki(doc, activeSchema);
    const profile = projectUserProfileFromWiki(doc);
    await this.writeProfile(profile);
    return profile;
  }

  async listSections(): Promise<WikiSectionSummary[]> {
    const schema = await this.loadSchema();
    const doc = await this.loadWiki();
    return schema.sections.map((section) => {
      const current = doc.sections[section.name];
      const entryCount = current
        ? current.kind === "key_value"
          ? Object.keys(current.fields).length
          : current.items.length
        : 0;
      return {
        name: section.name,
        kind: section.kind,
        entryCount,
        hasContent: entryCount > 0,
      };
    });
  }

  async readSection(sectionName: string): Promise<{ schema: WikiSchemaSection; content: string }> {
    const schema = await this.loadSchema();
    const matched = matchWikiSectionName(sectionName, schema);
    if (!matched) {
      throw new Error(`Unknown wiki section: ${sectionName}`);
    }
    const doc = await this.loadWiki();
    const section = doc.sections[matched.name];
    return {
      schema: matched,
      content: section ? renderWikiSection(section) : "",
    };
  }

  async search(query: string, limit = 5): Promise<WikiSearchMatch[]> {
    const searchQuery = query.trim().toLowerCase();
    if (searchQuery.length === 0) {
      return [];
    }
    const schema = await this.loadSchema();
    const doc = await this.loadWiki();
    const matches: WikiSearchMatch[] = [];

    for (const section of schema.sections) {
      const current = doc.sections[section.name];
      if (!current) continue;
      if (section.name.toLowerCase().includes(searchQuery)) {
        matches.push({ section: section.name, snippet: section.description });
      }

      if (current.kind === "key_value") {
        for (const [key, value] of Object.entries(current.fields)) {
          const line = `${key}: ${value}`;
          if (line.toLowerCase().includes(searchQuery)) {
            matches.push({ section: section.name, snippet: line });
          }
        }
      } else {
        for (const item of current.items) {
          if (item.toLowerCase().includes(searchQuery)) {
            matches.push({ section: section.name, snippet: item });
          }
        }
      }
    }

    return matches.slice(0, Math.max(1, Math.min(8, Math.floor(limit))));
  }

  async updateSection(
    sectionName: string,
    mode: "append" | "replace",
    content: string,
  ): Promise<{ wiki: UserWikiDocument; profile: UserProfileContext }> {
    const schema = await this.loadSchema();
    const matched = matchWikiSectionName(sectionName, schema);
    if (!matched) {
      throw new Error(`Unknown wiki section: ${sectionName}`);
    }

    const currentWiki = await this.loadWiki();
    const parsed = parseWikiSectionContent(matched.kind, content);
    const update: UserWikiSectionUpdate = {
      section: matched.name,
      ...(matched.kind === "key_value"
        ? { set_fields: parsed.fields }
        : { add_items: parsed.items }),
    };

    let nextWiki = currentWiki;
    if (mode === "replace") {
      nextWiki = {
        ...currentWiki,
        sections: {
          ...currentWiki.sections,
          [matched.name]: {
            name: matched.name,
            kind: matched.kind,
            fields: parsed.fields,
            items: parsed.items,
          },
        },
        lastUpdated: new Date().toISOString(),
      };
    } else {
      nextWiki = applyWikiSectionUpdates(currentWiki, schema, [update]);
    }

    const profile = await this.saveWikiAndProjectProfile(nextWiki, schema);
    return { wiki: nextWiki, profile };
  }
}
