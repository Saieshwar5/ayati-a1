import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startStoreWatcher, type SkillMeta, type StoreWatcher } from "../../src/ayati-store/watcher.js";

function validSkillJson(id: string): string {
  return JSON.stringify({
    schemaVersion: "ayati-skill/v1",
    id,
    version: "1.0.0",
    title: `Skill ${id}`,
    description: `Description for ${id}`,
    tags: ["test"],
    status: { state: "stable", enabledByDefault: false },
  });
}

function waitForEvent(watcher: StoreWatcher, event: "skill-added" | "skill-removed"): Promise<SkillMeta> {
  return new Promise((resolve) => {
    watcher.on(event, (meta) => resolve(meta));
  });
}

describe("StoreWatcher", () => {
  let tempDir: string;
  let watcher: StoreWatcher | null = null;

  afterEach(async () => {
    watcher?.stop();
    watcher = null;
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it("detects existing skills on start", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "store-test-"));
    const skillDir = join(tempDir, "my-skill");
    await mkdir(skillDir);
    await writeFile(join(skillDir, "skill.json"), validSkillJson("my-skill"));

    watcher = await startStoreWatcher(tempDir);
    const skills = watcher.getKnownSkills();

    expect(skills).toHaveLength(1);
    expect(skills[0]!.id).toBe("my-skill");
    expect(skills[0]!.state).toBe("stable");
    expect(skills[0]!.folder).toBe("my-skill");
  });

  it("emits skill-added when a valid skill folder appears", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "store-test-"));
    watcher = await startStoreWatcher(tempDir);

    const addedPromise = waitForEvent(watcher, "skill-added");

    const skillDir = join(tempDir, "new-skill");
    await mkdir(skillDir);
    await writeFile(join(skillDir, "skill.json"), validSkillJson("new-skill"));

    const meta = await addedPromise;
    expect(meta.id).toBe("new-skill");
    expect(meta.version).toBe("1.0.0");
    expect(meta.title).toBe("Skill new-skill");
  });

  it("does not emit for folders without skill.json", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "store-test-"));
    watcher = await startStoreWatcher(tempDir);

    let eventFired = false;
    watcher.on("skill-added", () => { eventFired = true; });

    await mkdir(join(tempDir, "no-skill-json"));

    // Wait longer than debounce to be sure
    await new Promise((r) => setTimeout(r, 800));
    expect(eventFired).toBe(false);
  });

  it("emits skill-removed when a skill folder is deleted", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "store-test-"));
    const skillDir = join(tempDir, "removable");
    await mkdir(skillDir);
    await writeFile(join(skillDir, "skill.json"), validSkillJson("removable"));

    watcher = await startStoreWatcher(tempDir);
    expect(watcher.getKnownSkills()).toHaveLength(1);

    const removedPromise = waitForEvent(watcher, "skill-removed");
    await rm(skillDir, { recursive: true, force: true });

    const meta = await removedPromise;
    expect(meta.id).toBe("removable");
    expect(watcher.getKnownSkills()).toHaveLength(0);
  });

  it("emits no events after stop", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "store-test-"));
    watcher = await startStoreWatcher(tempDir);
    watcher.stop();

    let eventFired = false;
    watcher.on("skill-added", () => { eventFired = true; });

    const skillDir = join(tempDir, "after-stop");
    await mkdir(skillDir);
    await writeFile(join(skillDir, "skill.json"), validSkillJson("after-stop"));

    await new Promise((r) => setTimeout(r, 800));
    expect(eventFired).toBe(false);
    watcher = null; // already stopped
  });
});
