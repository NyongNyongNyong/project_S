import { promises as fs } from "node:fs";
import path from "node:path";
import { env } from "./config";

export type LoreSlot = "planets" | "universe" | "factions" | "characters" | "locations";

const LORE_SLOT_CONFIG: Record<
  LoreSlot,
  {
    /** `allocateNextLoreSectionId` 등에서 쓰는 시리즈 키 → "faction 1" 형태 */
    seriesKey: string;
    /** 파일명 접두 (faction-001) */
    filePrefix: string;
  }
> = {
  planets: { seriesKey: "planet", filePrefix: "planet" },
  universe: { seriesKey: "universe", filePrefix: "universe" },
  factions: { seriesKey: "faction", filePrefix: "faction" },
  characters: { seriesKey: "character", filePrefix: "character" },
  locations: { seriesKey: "location", filePrefix: "location" }
};

const LORE_REL_PATH: Record<LoreSlot, string> = {
  planets: env.STORAGE_LORE_PLANETS_DIR,
  universe: "lore/universe",
  factions: "lore/factions",
  characters: "lore/characters",
  locations: "lore/locations"
};

/** Git에 비어 있는 채로 두기 위한 lore 하위 구조 (서버 기동 시에도 mkdir 보장) */
const LORE_SUBDIRS = Object.values(LORE_REL_PATH);

export const LORE_SLOTS: LoreSlot[] = ["planets", "universe", "factions", "characters", "locations"];

export function isLoreSlot(value: string): value is LoreSlot {
  return (LORE_SLOTS as string[]).includes(value);
}

export function loreAutoSeriesKey(slot: LoreSlot): string {
  return LORE_SLOT_CONFIG[slot].seriesKey;
}

function getStoragePaths() {
  const rootDir = path.resolve(process.cwd(), env.STORAGE_ROOT_DIR);
  const storiesDir = path.join(rootDir, env.STORAGE_STORIES_DIR);
  const loreDirs = {} as Record<LoreSlot, string>;
  for (const slot of LORE_SLOTS) {
    loreDirs[slot] = path.join(rootDir, LORE_REL_PATH[slot]);
  }
  return { rootDir, storiesDir, loreDirs };
}

async function ensureStorageLayout() {
  const { rootDir, storiesDir, loreDirs } = getStoragePaths();
  await fs.mkdir(rootDir, { recursive: true });
  await fs.mkdir(storiesDir, { recursive: true });
  for (const rel of LORE_SUBDIRS) {
    await fs.mkdir(path.join(rootDir, rel), { recursive: true });
  }
  for (const slot of LORE_SLOTS) {
    await fs.mkdir(loreDirs[slot], { recursive: true });
  }
}

function toSafeFilename(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function parseScenarioNumber(sectionId: string): number | null {
  const match = sectionId.match(/(?:시나리오|scenario)\s*([0-9]+)/i);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  if (!Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

function toScenarioFileStem(sectionId: string): string {
  const scenarioNumber = parseScenarioNumber(sectionId);
  if (scenarioNumber !== null) {
    return `scenario-${String(scenarioNumber).padStart(3, "0")}`;
  }
  return toSafeFilename(sectionId).toLowerCase();
}

function parseLoreSeriesNumber(sectionId: string, seriesKey: string): number | null {
  const re = new RegExp(`^${seriesKey}\\s+([0-9]+)$`, "i");
  const match = sectionId.match(re);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  if (!Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

function toLoreFileStem(slot: LoreSlot, sectionId: string): string {
  const { filePrefix, seriesKey } = LORE_SLOT_CONFIG[slot];
  const n = parseLoreSeriesNumber(sectionId, seriesKey);
  if (n !== null) {
    return `${filePrefix}-${String(n).padStart(3, "0")}`;
  }
  return toSafeFilename(sectionId).toLowerCase();
}

export interface StorySummary {
  fileName: string;
  scenarioId: string;
  sectionId: string;
  updatedAt: string;
}

function parseFrontMatter(content: string): { meta: Record<string, string>; body: string } {
  if (!content.startsWith("---\n")) {
    return { meta: {}, body: content };
  }
  const endMarker = content.indexOf("\n---\n", 4);
  if (endMarker < 0) {
    return { meta: {}, body: content };
  }
  const rawMeta = content.slice(4, endMarker);
  const body = content.slice(endMarker + 5);
  const meta: Record<string, string> = {};
  for (const line of rawMeta.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) {
      continue;
    }
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    meta[key] = value;
  }
  return { meta, body };
}

const STORY_FILE_NAME_RE = /^[a-zA-Z0-9._-]+\.md$/;

export function isValidStoryFileName(fileName: string): boolean {
  return STORY_FILE_NAME_RE.test(fileName);
}

export async function ensureStorageSchema() {
  await ensureStorageLayout();
  const { rootDir, storiesDir, loreDirs } = getStoragePaths();
  return {
    changedProperties: ["storage_initialized"],
    rootDir,
    storiesDir,
    lorePlanetsDir: loreDirs.planets
  };
}

export async function verifyStorageAccess() {
  await ensureStorageLayout();
  const { storiesDir, loreDirs } = getStoragePaths();
  return { storiesDir, lorePlanetsDir: loreDirs.planets, loreDirs };
}

/**
 * `sectionId` 없이 채팅 생성만 할 때, 기존 `scenario-NNN.md` 와 겹치지 않도록
 * `시나리오 N` 형태를 부여한다 (서버 재기동·메모리 카운터와 무관하게 디스크 기준).
 */
export async function allocateNextScenarioSectionId(): Promise<string> {
  await ensureStorageLayout();
  const { storiesDir } = getStoragePaths();
  const entries = await fs.readdir(storiesDir, { withFileTypes: true });
  let max = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
      continue;
    }
    const m = entry.name.match(/^scenario-(\d+)\.md$/i);
    if (m) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n > max) {
        max = n;
      }
    }
  }
  return `시나리오 ${max + 1}`;
}

/** lore 슬롯별 `planet-NNN.md` 등 기존 번호 다음을 쓴다. */
export async function allocateNextLoreSectionId(slot: LoreSlot): Promise<string> {
  await ensureStorageLayout();
  const { filePrefix, seriesKey } = LORE_SLOT_CONFIG[slot];
  const { loreDirs } = getStoragePaths();
  const dir = loreDirs[slot];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  let max = 0;
  const re = new RegExp(`^${filePrefix}-(\\d+)\\.md$`, "i");
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const m = entry.name.match(re);
    if (m) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n > max) {
        max = n;
      }
    }
  }
  return `${seriesKey} ${max + 1}`;
}

export async function saveScenarioStory(args: {
  chapterId: string;
  sectionId: string;
  storyText: string;
  applyKey: string;
}) {
  await ensureStorageLayout();
  const { storiesDir } = getStoragePaths();
  const scenarioStem = toScenarioFileStem(args.sectionId);
  const scenarioFilePath = path.join(storiesDir, `${scenarioStem}.md`);
  const now = new Date().toISOString();
  const content = [
    "---",
    `scenario_id: ${scenarioStem}`,
    `section_id: ${args.sectionId}`,
    `chapter_id: ${args.chapterId}`,
    `apply_key: ${args.applyKey}`,
    `updated_at: ${now}`,
    "---",
    "",
    `# ${args.sectionId}`,
    "",
    args.storyText.trim(),
    ""
  ].join("\n");
  await fs.writeFile(scenarioFilePath, content, "utf8");
  return { filePath: scenarioFilePath };
}

export async function saveLoreDoc(
  slot: LoreSlot,
  args: {
    chapterId: string;
    sectionId: string;
    storyText: string;
    applyKey: string;
  }
) {
  await ensureStorageLayout();
  const { loreDirs } = getStoragePaths();
  const stem = toLoreFileStem(slot, args.sectionId);
  const filePath = path.join(loreDirs[slot], `${stem}.md`);
  const now = new Date().toISOString();
  const content = [
    "---",
    `lore_slot: ${slot}`,
    `lore_id: ${stem}`,
    `section_id: ${args.sectionId}`,
    `chapter_id: ${args.chapterId}`,
    `apply_key: ${args.applyKey}`,
    `updated_at: ${now}`,
    "---",
    "",
    `# ${args.sectionId}`,
    "",
    args.storyText.trim(),
    ""
  ].join("\n");
  await fs.writeFile(filePath, content, "utf8");
  return { filePath };
}

function summaryIdFromLoreMeta(meta: Record<string, string>, stem: string): string {
  return meta.lore_id ?? meta.planet_id ?? stem;
}

export async function listStories(): Promise<StorySummary[]> {
  await ensureStorageLayout();
  const { storiesDir } = getStoragePaths();
  const entries = await fs.readdir(storiesDir, { withFileTypes: true });
  const stories: StorySummary[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    if (!isValidStoryFileName(entry.name)) {
      continue;
    }
    const fullPath = path.join(storiesDir, entry.name);
    const fileContent = await fs.readFile(fullPath, "utf8");
    const { meta } = parseFrontMatter(fileContent);
    const stem = entry.name.replace(/\.md$/, "");
    stories.push({
      fileName: entry.name,
      scenarioId: meta.scenario_id ?? stem,
      sectionId: meta.section_id ?? stem,
      updatedAt: meta.updated_at ?? new Date(0).toISOString()
    });
  }
  return stories.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export async function listLoreDocs(slot: LoreSlot): Promise<StorySummary[]> {
  await ensureStorageLayout();
  const { loreDirs } = getStoragePaths();
  const dir = loreDirs[slot];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const stories: StorySummary[] = [];
  for (const entry of entries) {
    if (entry.name === ".gitkeep") {
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    if (!isValidStoryFileName(entry.name)) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    const raw = await fs.readFile(fullPath, "utf8");
    const { meta } = parseFrontMatter(raw);
    const stem = entry.name.replace(/\.md$/, "");
    stories.push({
      fileName: entry.name,
      scenarioId: summaryIdFromLoreMeta(meta, stem),
      sectionId: meta.section_id ?? stem,
      updatedAt: meta.updated_at ?? new Date(0).toISOString()
    });
  }
  return stories.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export async function readStory(fileName: string): Promise<{ summary: StorySummary; body: string }> {
  if (!isValidStoryFileName(fileName)) {
    throw new Error("invalid story file name");
  }
  await ensureStorageLayout();
  const { storiesDir } = getStoragePaths();
  const fullPath = path.join(storiesDir, fileName);
  const fileContent = await fs.readFile(fullPath, "utf8");
  const { meta, body } = parseFrontMatter(fileContent);
  const stem = fileName.replace(/\.md$/, "");
  return {
    summary: {
      fileName,
      scenarioId: meta.scenario_id ?? stem,
      sectionId: meta.section_id ?? stem,
      updatedAt: meta.updated_at ?? new Date(0).toISOString()
    },
    body: body.trim()
  };
}

export async function readLoreDoc(
  slot: LoreSlot,
  fileName: string
): Promise<{ summary: StorySummary; body: string }> {
  if (!isValidStoryFileName(fileName)) {
    throw new Error("invalid story file name");
  }
  await ensureStorageLayout();
  const { loreDirs } = getStoragePaths();
  const fullPath = path.join(loreDirs[slot], fileName);
  const fileContent = await fs.readFile(fullPath, "utf8");
  const { meta, body } = parseFrontMatter(fileContent);
  const stem = fileName.replace(/\.md$/, "");
  return {
    summary: {
      fileName,
      scenarioId: summaryIdFromLoreMeta(meta, stem),
      sectionId: meta.section_id ?? stem,
      updatedAt: meta.updated_at ?? new Date(0).toISOString()
    },
    body: body.trim()
  };
}
