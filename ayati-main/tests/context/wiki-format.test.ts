import { describe, expect, it } from "vitest";
import { emptyUserProfileContext } from "../../src/context/types.js";
import {
  applyWikiSectionUpdates,
  buildWikiFromProfile,
  defaultUserWikiSchema,
  parseUserWiki,
  parseUserWikiSchema,
  projectUserProfileFromWiki,
  renderUserWiki,
  renderUserWikiSchema,
} from "../../src/context/wiki-format.js";

describe("wiki format", () => {
  it("round-trips the default schema", () => {
    const schema = defaultUserWikiSchema();
    const rendered = renderUserWikiSchema(schema);
    const parsed = parseUserWikiSchema(rendered);

    expect(parsed).not.toBeNull();
    expect(parsed?.sections.map((section) => section.name)).toEqual(schema.sections.map((section) => section.name));
  });

  it("builds wiki from profile and projects back to profile", () => {
    const schema = defaultUserWikiSchema();
    const profile = {
      ...emptyUserProfileContext(),
      name: "Sai",
      occupation: "Engineer",
      languages: ["English", "TypeScript"],
      interests: ["Robotics"],
      facts: ["Prefers direct answers"],
      people: ["Arun"],
      projects: ["Ayati"],
      communication: {
        formality: "casual",
        verbosity: "brief",
        humor_receptiveness: "high",
        emoji_usage: "rare",
      },
      emotional_patterns: {
        mood_baseline: "focused",
        stress_triggers: ["vague requirements"],
        joy_triggers: ["shipping features"],
      },
      active_hours: "evenings",
      last_updated: "2026-04-05T00:00:00.000Z",
    };

    const wiki = buildWikiFromProfile(profile, schema);
    const projected = projectUserProfileFromWiki(wiki);

    expect(projected.name).toBe("Sai");
    expect(projected.occupation).toBe("Engineer");
    expect(projected.languages).toEqual(["English", "TypeScript"]);
    expect(projected.interests).toEqual(["Robotics"]);
    expect(projected.facts).toEqual(["Prefers direct answers"]);
    expect(projected.people).toEqual(["Arun"]);
    expect(projected.projects).toEqual(["Ayati"]);
    expect(projected.communication.verbosity).toBe("brief");
    expect(projected.emotional_patterns.stress_triggers).toEqual(["vague requirements"]);
    expect(projected.active_hours).toBe("evenings");
  });

  it("applies unique updates and remains parseable after render", () => {
    const schema = defaultUserWikiSchema();
    const wiki = applyWikiSectionUpdates(buildWikiFromProfile(emptyUserProfileContext(), schema), schema, [
      { section: "Projects", add_items: ["Ayati", "ayati"] },
      { section: "Communication Preferences", set_fields: { Verbosity: "brief" } },
    ]);

    expect(wiki.sections["Projects"]?.items).toEqual(["Ayati"]);
    expect(wiki.sections["Communication Preferences"]?.fields["Verbosity"]).toBe("brief");

    const reparsed = parseUserWiki(renderUserWiki(wiki, schema), schema);
    expect(reparsed?.sections["Projects"]?.items).toEqual(["Ayati"]);
    expect(reparsed?.sections["Communication Preferences"]?.fields["Verbosity"]).toBe("brief");
  });
});
