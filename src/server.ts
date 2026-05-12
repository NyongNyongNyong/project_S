import express from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { env } from "./config";
import { generateSuggestion, reviseScenarioConservatively } from "./ai";
import {
  allocateNextLoreSectionId,
  allocateNextScenarioSectionId,
  isLoreSlot,
  listLoreDocs,
  listStories,
  LORE_SLOTS,
  readLoreDoc,
  readStory,
  saveLoreDoc,
  saveScenarioStory,
  type LoreSlot
} from "./storage";
import { DraftInput, EditMode, ScenarioCategory } from "./types";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use("/app", express.static(path.join(process.cwd(), "public")));

interface RevisionEntry {
  message: string;
  createdAt: string;
}

interface PendingChatDraft {
  draft: DraftInput;
  review: Awaited<ReturnType<typeof generateSuggestion>>;
  editMode: EditMode;
  revisionCount: number;
  revisionHistory: RevisionEntry[];
  createdAt: number;
  updatedAt: number;
  docType: "lore" | "scenario";
  /** 시나리오일 때는 null */
  loreSlot: LoreSlot | null;
}

const versionBySection = new Map<string, number>();
const pendingChatDrafts = new Map<string, PendingChatDraft>();
const CATEGORY_SET: Set<ScenarioCategory> = new Set([
  "plot",
  "character",
  "worldbuilding",
  "tone",
  "pacing",
  "dialogue",
  "other"
]);
const CHAT_REVISION_HISTORY_LIMIT = 10;

function resolveEditMode(value: unknown): EditMode {
  if (value === "preserve" || value === "rewrite") {
    return value;
  }
  return env.CHAT_DEFAULT_EDIT_MODE;
}

function hasRewriteTag(text: unknown): boolean {
  return typeof text === "string" && /(^|\s)#rewrite(\s|$)/i.test(text);
}

function resolveChatDocType(input: unknown): "lore" | "scenario" {
  if (typeof input !== "object" || input === null) {
    return "scenario";
  }
  const raw = (input as { docType?: string }).docType;
  if (typeof raw === "string" && raw.trim().toLowerCase() === "lore") {
    return "lore";
  }
  return "scenario";
}

function inferLoreSlotFromMessage(message: string): LoreSlot {
  const t = message.toLowerCase();
  if (
    /세력|팩션|조직|연합|길드|군단|제국|기업\s*연합|카르텔|faction|syndicate|cartel|guild|corporation|empire|megacorp/.test(
      message
    )
  ) {
    return "factions";
  }
  if (/인물|캐릭터|npc|주인공|조연|character|protagonist|antagonist/.test(message)) {
    return "characters";
  }
  if (/정거장|거점|기지|식민지|궤도\s*도시|도시\s*국가|station|habitat|outpost|colony|spaceport|arcology/.test(message)) {
    return "locations";
  }
  if (/행성|대기|자전|위성|중력|생태|지형|planet|moon|orbit|tidal/.test(message)) {
    return "planets";
  }
  if (/은하|공동체|ftl|워프|타임라인|우주\s*법|세계관\s*공통|galactic|cosmology|timeline|diaspora/.test(message)) {
    return "universe";
  }
  if (
    /세계관|설정|lore|worldbuilding/.test(t) &&
    !/장면|대사|시나리오|씬|scene|dialogue|plot/.test(message)
  ) {
    return "universe";
  }
  return "planets";
}

function parseExplicitLoreSlot(body: unknown): LoreSlot | "auto" | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const raw = (body as { loreSlot?: string }).loreSlot;
  if (typeof raw !== "string") {
    return undefined;
  }
  const s = raw.trim().toLowerCase();
  if (s === "auto" || s === "") {
    return "auto";
  }
  if (isLoreSlot(s)) {
    return s;
  }
  return undefined;
}

function resolveLoreSlotFromRequest(body: unknown): LoreSlot {
  const explicit = parseExplicitLoreSlot(body);
  if (explicit && explicit !== "auto") {
    return explicit;
  }
  const message =
    typeof body === "object" && body !== null && typeof (body as { message?: string }).message === "string"
      ? (body as { message: string }).message
      : "";
  return inferLoreSlotFromMessage(message);
}

function scenarioCategoryForLoreSlot(slot: LoreSlot): ScenarioCategory {
  if (slot === "characters") {
    return "character";
  }
  return "worldbuilding";
}

function getDraftExpiryTimestamp(entry: PendingChatDraft): number {
  return entry.updatedAt + env.CHAT_DRAFT_TTL_MS;
}

function pruneExpiredChatDrafts(now = Date.now()): void {
  for (const [draftId, entry] of pendingChatDrafts.entries()) {
    if (now >= getDraftExpiryTimestamp(entry)) {
      pendingChatDrafts.delete(draftId);
    }
  }
}

function getPendingChatDraftOrThrow(draftId: string): PendingChatDraft {
  const entry = pendingChatDrafts.get(draftId);
  if (!entry) {
    throw new Error("draft not found or expired");
  }
  if (Date.now() >= getDraftExpiryTimestamp(entry)) {
    pendingChatDrafts.delete(draftId);
    throw new Error("draft not found or expired");
  }
  return entry;
}

function validateDraftInput(input: unknown): DraftInput {
  if (typeof input !== "object" || input === null) {
    throw new Error("request body must be an object");
  }

  const body = input as Partial<DraftInput>;
  const requiredStrings: Array<keyof DraftInput> = ["chapterId", "sectionId", "draftText", "requestType"];

  for (const key of requiredStrings) {
    const value = body[key];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`${key} is required`);
    }
  }

  if (!["review", "expand", "tone"].includes(body.requestType!)) {
    throw new Error("requestType must be one of review, expand, tone");
  }

  let category: ScenarioCategory | undefined;
  if (typeof body.category === "string" && body.category.trim().length > 0) {
    const normalized = body.category.trim().toLowerCase() as ScenarioCategory;
    if (!CATEGORY_SET.has(normalized)) {
      throw new Error("category must be one of plot, character, worldbuilding, tone, pacing, dialogue, other");
    }
    category = normalized;
  }

  return {
    chapterId: body.chapterId!.trim(),
    sectionId: body.sectionId!.trim(),
    draftText: body.draftText!.trim(),
    worldMemo: typeof body.worldMemo === "string" ? body.worldMemo : undefined,
    requestType: body.requestType as DraftInput["requestType"],
    category
  };
}

function validateChatReviseInput(
  input: unknown,
  opts: { docType: "lore" | "scenario"; loreSlot: LoreSlot | null }
): DraftInput {
  if (typeof input !== "object" || input === null) {
    throw new Error("request body must be an object");
  }
  const body = input as Partial<DraftInput> & {
    message?: string;
    docType?: string;
  };

  if (typeof body.message !== "string" || body.message.trim().length === 0) {
    throw new Error("message is required");
  }

  const chapterId =
    typeof body.chapterId === "string" && body.chapterId.trim().length > 0
      ? body.chapterId.trim()
      : "CHAT";

  const requestType = body.requestType && ["review", "expand", "tone"].includes(body.requestType)
    ? body.requestType
    : "review";

  let category: ScenarioCategory | undefined;
  if (opts.docType === "lore") {
    category = opts.loreSlot ? scenarioCategoryForLoreSlot(opts.loreSlot) : "worldbuilding";
  } else {
    category = "plot";
  }

  if (typeof body.category === "string" && body.category.trim().length > 0) {
    const normalized = body.category.trim().toLowerCase() as ScenarioCategory;
    if (!CATEGORY_SET.has(normalized)) {
      throw new Error("category must be one of plot, character, worldbuilding, tone, pacing, dialogue, other");
    }
    category = normalized;
  }

  const sectionId =
    typeof body.sectionId === "string" && body.sectionId.trim().length > 0
      ? body.sectionId.trim()
      : (() => {
          throw new Error(
            "sectionId가 비어 있습니다. 채팅 생성 경로에서는 서버가 디스크 기준으로 번호를 붙여야 합니다."
          );
        })();

  return {
    chapterId,
    sectionId,
    draftText: body.message.trim(),
    worldMemo: typeof body.worldMemo === "string" ? body.worldMemo : undefined,
    requestType,
    category
  };
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    message: "project_S MVP API",
    endpoints: {
      app: "GET /app",
      health: "GET /health",
      createDraft: "POST /api/drafts",
      chatGenerate: "POST /api/chat/generate",
      chatDraft: "GET /api/chat/draft/:draftId",
      chatRevise: "POST /api/chat/revise-draft",
      chatSave: "POST /api/chat/approve",
      listStories: "GET /api/stories",
      readStory: "GET /api/stories/:fileName",
      listLore: "GET /api/lore/:slot",
      readLore: "GET /api/lore/:slot/:fileName",
      createScenarioRevision: "POST /api/scenario/revise"
    }
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "project_S_mvp_api" });
});

app.get("/api/stories", async (_req, res) => {
  try {
    const stories = await listStories();
    res.json({ stories });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    res.status(500).json({ error: message });
  }
});

app.get("/api/stories/:fileName", async (req, res) => {
  try {
    const fileName = req.params?.fileName;
    if (!fileName) {
      res.status(400).json({ error: "fileName is required" });
      return;
    }
    const { summary, body } = await readStory(fileName);
    res.json({ summary, body });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    if (message === "invalid story file name") {
      res.status(400).json({ error: message });
      return;
    }
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      res.status(404).json({ error: "story not found" });
      return;
    }
    res.status(500).json({ error: message });
  }
});

app.get("/api/lore/:slot/:fileName", async (req, res) => {
  try {
    const slot = req.params?.slot;
    if (!slot || !isLoreSlot(slot)) {
      res.status(400).json({ error: `slot must be one of: ${LORE_SLOTS.join(", ")}` });
      return;
    }
    const fileName = req.params?.fileName;
    if (!fileName) {
      res.status(400).json({ error: "fileName is required" });
      return;
    }
    const { summary, body } = await readLoreDoc(slot, fileName);
    res.json({ summary, body });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    if (message === "invalid story file name") {
      res.status(400).json({ error: message });
      return;
    }
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      res.status(404).json({ error: "lore document not found" });
      return;
    }
    res.status(500).json({ error: message });
  }
});

app.get("/api/lore/:slot", async (req, res) => {
  try {
    const slot = req.params?.slot;
    if (!slot || !isLoreSlot(slot)) {
      res.status(400).json({ error: `slot must be one of: ${LORE_SLOTS.join(", ")}` });
      return;
    }
    const items = await listLoreDocs(slot);
    res.json({ slot, items });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    res.status(500).json({ error: message });
  }
});

app.post("/api/drafts", async (req, res) => {
  try {
    const draft = validateDraftInput(req.body);
    const taskId = randomUUID();
    const sectionKey = `${draft.chapterId}:${draft.sectionId}`;
    const version = (versionBySection.get(sectionKey) ?? 0) + 1;
    versionBySection.set(sectionKey, version);
    const applyKey = `${draft.chapterId}:${draft.sectionId}:v${version}`;

    const review = await generateSuggestion(draft);
    const saved = await saveScenarioStory({
      chapterId: draft.chapterId,
      sectionId: draft.sectionId,
      storyText: review.finalText,
      applyKey
    });

    res.status(201).json({
      taskId,
      status: "saved",
      storagePath: saved.filePath,
      applyKey,
      mergedReview: {
        usedModels: review.usedModels,
        strengths: review.strengths,
        concerns: review.concerns,
        summary: review.reviewSummary
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    res.status(400).json({ error: message });
  }
});

app.post("/api/scenario/revise", async (req, res) => {
  try {
    const draft = validateDraftInput(req.body);
    const review = await generateSuggestion(draft);

    res.json({
      category: draft.category ?? "other",
      input: {
        chapterId: draft.chapterId,
        sectionId: draft.sectionId,
        requestType: draft.requestType
      },
      reviewerResults: review.reviewerResults,
      merged: {
        usedModels: review.usedModels,
        strengths: review.strengths,
        concerns: review.concerns,
        changeReason: review.changeReason,
        reviewSummary: review.reviewSummary,
        suggestionText: review.suggestionText,
        finalText: review.finalText
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    res.status(400).json({ error: message });
  }
});

app.post("/api/chat/generate", async (req, res) => {
  try {
    pruneExpiredChatDrafts();
    const docType = resolveChatDocType(req.body);
    const loreSlot = docType === "lore" ? resolveLoreSlotFromRequest(req.body) : null;

    const body =
      typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};
    const rawSection = typeof body.sectionId === "string" ? body.sectionId.trim() : "";

    let generateBody: unknown = req.body;
    if (!rawSection) {
      const allocated =
        docType === "scenario"
          ? await allocateNextScenarioSectionId()
          : await allocateNextLoreSectionId(loreSlot ?? "planets");
      generateBody = { ...body, sectionId: allocated };
    }

    const draft = validateChatReviseInput(generateBody, { docType, loreSlot });
    const review = await generateSuggestion(draft);
    const editMode = hasRewriteTag(req.body?.message) ? "rewrite" : resolveEditMode(req.body?.editMode);
    const draftId = randomUUID();
    const now = Date.now();
    pendingChatDrafts.set(draftId, {
      draft,
      review,
      editMode,
      revisionCount: 0,
      revisionHistory: [],
      createdAt: now,
      updatedAt: now,
      docType,
      loreSlot
    });
    const expiresAt = new Date(now + env.CHAT_DRAFT_TTL_MS).toISOString();

    res.json({
      mode: "chat",
      draftId,
      expiresAt,
      editMode,
      docType,
      loreSlot,
      request: {
        originalMessage: draft.draftText,
        docType: docType === "lore" ? "lore" : "scenario",
        loreSlot: loreSlot ?? undefined
      },
      category: draft.category ?? "other",
      input: {
        chapterId: draft.chapterId,
        sectionId: draft.sectionId,
        requestType: draft.requestType
      },
      reviewerResults: review.reviewerResults,
      revisionHistory: [],
      merged: {
        usedModels: review.usedModels,
        strengths: review.strengths,
        concerns: review.concerns,
        changeReason: review.changeReason,
        reviewSummary: review.reviewSummary,
        suggestionText: review.suggestionText,
        finalText: review.finalText,
        changeLogs: Array.from(new Set(review.reviewerResults.flatMap((item) => item.changeLog ?? [])))
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    res.status(400).json({ error: message });
  }
});

app.get("/api/chat/draft/:draftId", async (req, res) => {
  try {
    const draftId = req.params?.draftId;
    if (!draftId) {
      throw new Error("draftId is required");
    }
    const pending = getPendingChatDraftOrThrow(draftId);
    const expiresAt = new Date(getDraftExpiryTimestamp(pending)).toISOString();

    res.json({
      mode: "chat",
      draftId,
      expiresAt,
      editMode: pending.editMode,
      revisionCount: pending.revisionCount,
      docType: pending.docType,
      loreSlot: pending.loreSlot ?? undefined,
      request: {
        originalMessage: pending.draft.draftText
      },
      category: pending.draft.category ?? "other",
      input: {
        chapterId: pending.draft.chapterId,
        sectionId: pending.draft.sectionId,
        requestType: pending.draft.requestType
      },
      reviewerResults: pending.review.reviewerResults,
      revisionHistory: pending.revisionHistory,
      merged: {
        usedModels: pending.review.usedModels,
        strengths: pending.review.strengths,
        concerns: pending.review.concerns,
        changeReason: pending.review.changeReason,
        reviewSummary: pending.review.reviewSummary,
        suggestionText: pending.review.suggestionText,
        finalText: pending.review.finalText,
        changeLogs: Array.from(new Set(pending.review.reviewerResults.flatMap((item) => item.changeLog ?? [])))
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    res.status(404).json({ error: message });
  }
});

app.post("/api/chat/revise-draft", async (req, res) => {
  try {
    pruneExpiredChatDrafts();
    const body = req.body as { draftId?: string; revisionMessage?: string; editMode?: EditMode };
    if (!body?.draftId || typeof body.draftId !== "string") {
      throw new Error("draftId is required");
    }
    if (!body?.revisionMessage || typeof body.revisionMessage !== "string" || body.revisionMessage.trim().length === 0) {
      throw new Error("revisionMessage is required");
    }
    const pending = getPendingChatDraftOrThrow(body.draftId);
    const revisionMessage = body.revisionMessage.trim();
    const activeEditMode = hasRewriteTag(revisionMessage) ? "rewrite" : resolveEditMode(body.editMode ?? pending.editMode);

    let revisedDraft: DraftInput;
    let review: Awaited<ReturnType<typeof generateSuggestion>>;
    let originalMessageForResponse: string;
    if (activeEditMode === "preserve") {
      const baseText =
        pending.review.finalText && pending.review.finalText.trim().length > 0
          ? pending.review.finalText
          : pending.draft.draftText;
      review = await reviseScenarioConservatively({
        input: pending.draft,
        sourceText: baseText,
        revisionMessage
      });
      revisedDraft = {
        ...pending.draft,
        draftText: baseText
      };
      originalMessageForResponse = baseText;
    } else {
      revisedDraft = {
        ...pending.draft,
        draftText: `${pending.draft.draftText}\n\n[수정 요청]\n${revisionMessage}`
      };
      review = await generateSuggestion(revisedDraft);
      originalMessageForResponse = revisedDraft.draftText;
    }

    const revisionCount = pending.revisionCount + 1;
    const revisionHistory = [...pending.revisionHistory, { message: revisionMessage, createdAt: new Date().toISOString() }]
      .slice(-CHAT_REVISION_HISTORY_LIMIT);
    const updatedAt = Date.now();
    const docType = pending.docType;
    pendingChatDrafts.set(body.draftId, {
      draft: revisedDraft,
      review,
      editMode: activeEditMode,
      revisionCount,
      revisionHistory,
      createdAt: pending.createdAt,
      updatedAt,
      docType,
      loreSlot: pending.loreSlot
    });
    const expiresAt = new Date(updatedAt + env.CHAT_DRAFT_TTL_MS).toISOString();

    res.json({
      mode: "chat",
      draftId: body.draftId,
      editMode: activeEditMode,
      revisionCount,
      expiresAt,
      docType,
      loreSlot: pending.loreSlot ?? undefined,
      request: {
        originalMessage: originalMessageForResponse,
        docType: docType === "lore" ? "lore" : "scenario",
        loreSlot: pending.loreSlot ?? undefined
      },
      reviewerResults: review.reviewerResults,
      revisionHistory,
      merged: {
        usedModels: review.usedModels,
        strengths: review.strengths,
        concerns: review.concerns,
        changeReason: review.changeReason,
        reviewSummary: review.reviewSummary,
        suggestionText: review.suggestionText,
        finalText: review.finalText,
        changeLogs: Array.from(new Set(review.reviewerResults.flatMap((item) => item.changeLog ?? [])))
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    res.status(400).json({ error: message });
  }
});

app.post("/api/chat/approve", async (req, res) => {
  try {
    pruneExpiredChatDrafts();
    const body = req.body as { draftId?: string };
    if (!body?.draftId || typeof body.draftId !== "string") {
      throw new Error("draftId is required");
    }
    const pending = getPendingChatDraftOrThrow(body.draftId);

    const sectionKey = `${pending.draft.chapterId}:${pending.draft.sectionId}`;
    const version = (versionBySection.get(sectionKey) ?? 0) + 1;
    versionBySection.set(sectionKey, version);
    const applyKey = `${pending.draft.chapterId}:${pending.draft.sectionId}:v${version}`;
    const saveArgs = {
      chapterId: pending.draft.chapterId,
      sectionId: pending.draft.sectionId,
      storyText: pending.review.finalText,
      applyKey
    };
    const saved =
      pending.docType === "lore" && pending.loreSlot
        ? await saveLoreDoc(pending.loreSlot, saveArgs)
        : await saveScenarioStory(saveArgs);
    pendingChatDrafts.delete(body.draftId);

    res.status(201).json({
      mode: "chat",
      draftId: body.draftId,
      status: "saved",
      docType: pending.docType,
      loreSlot: pending.loreSlot ?? undefined,
      storagePath: saved.filePath,
      applyKey,
      mergedReview: {
        usedModels: pending.review.usedModels,
        strengths: pending.review.strengths,
        concerns: pending.review.concerns,
        summary: pending.review.reviewSummary,
        finalText: pending.review.finalText,
        suggestionText: pending.review.suggestionText,
        changeReason: pending.review.changeReason,
        changeLogs: Array.from(new Set(pending.review.reviewerResults.flatMap((item) => item.changeLog ?? [])))
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    res.status(400).json({ error: message });
  }
});

const cleanupTimer = setInterval(() => {
  pruneExpiredChatDrafts();
}, Math.min(env.CHAT_DRAFT_TTL_MS, 60_000));
cleanupTimer.unref();

app.listen(env.PORT, () => {
  // Keep startup log simple for terminal checks.
  console.log(`project_S API running on http://localhost:${env.PORT}`);
});
