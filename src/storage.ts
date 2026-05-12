import { promises as fs } from "node:fs";
import path from "node:path";
import { env } from "./config";

function getStoragePaths() {
  const rootDir = path.resolve(process.cwd(), env.STORAGE_ROOT_DIR);
  const storiesDir = path.join(rootDir, env.STORAGE_STORIES_DIR);
  return { rootDir, storiesDir };
}

async function ensureStorageLayout() {
  const { rootDir, storiesDir } = getStoragePaths();
  await fs.mkdir(rootDir, { recursive: true });
  await fs.mkdir(storiesDir, { recursive: true });
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
  const { rootDir, storiesDir } = getStoragePaths();
  return {
    changedProperties: ["storage_initialized"],
    rootDir,
    storiesDir
  };
}

export async function verifyStorageAccess() {
  await ensureStorageLayout();
  const { storiesDir } = getStoragePaths();
  return { storiesDir };
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
    const content = await fs.readFile(fullPath, "utf8");
    const { meta } = parseFrontMatter(content);
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

export async function readStory(fileName: string): Promise<{ summary: StorySummary; body: string }> {
  if (!isValidStoryFileName(fileName)) {
    throw new Error("invalid story file name");
  }
  await ensureStorageLayout();
  const { storiesDir } = getStoragePaths();
  const fullPath = path.join(storiesDir, fileName);
  const content = await fs.readFile(fullPath, "utf8");
  const { meta, body } = parseFrontMatter(content);
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
