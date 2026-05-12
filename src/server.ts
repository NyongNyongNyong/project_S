import express from "express";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { env } from "./config";
import { generateSuggestion, reviseScenarioConservatively } from "./ai";
import { listStories, readStory, saveScenarioStory } from "./storage";
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
}

const versionBySection = new Map<string, number>();
const autoSectionBySeries = new Map<string, number>();
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

function nextAutoSectionId(seriesLabel: string): string {
  const current = autoSectionBySeries.get(seriesLabel) ?? 0;
  const next = current + 1;
  autoSectionBySeries.set(seriesLabel, next);
  return `${seriesLabel} ${next}`;
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

function validateChatReviseInput(input: unknown): DraftInput {
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
  if (typeof body.docType === "string" && body.docType.trim().length > 0) {
    const docType = body.docType.trim().toLowerCase();
    if (docType === "lore") {
      category = "worldbuilding";
    } else if (docType === "scenario") {
      category = "plot";
    }
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
      : category === "plot"
        ? nextAutoSectionId("시나리오")
        : category === "worldbuilding"
          ? nextAutoSectionId("planet")
          : nextAutoSectionId("item");

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
    const draft = validateChatReviseInput(req.body);
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
      updatedAt: now
    });
    const expiresAt = new Date(now + env.CHAT_DRAFT_TTL_MS).toISOString();

    res.json({
      mode: "chat",
      draftId,
      expiresAt,
      editMode,
      request: {
        originalMessage: draft.draftText,
        docType: req.body?.docType ?? null
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
    pendingChatDrafts.set(body.draftId, {
      draft: revisedDraft,
      review,
      editMode: activeEditMode,
      revisionCount,
      revisionHistory,
      createdAt: pending.createdAt,
      updatedAt
    });
    const expiresAt = new Date(updatedAt + env.CHAT_DRAFT_TTL_MS).toISOString();

    res.json({
      mode: "chat",
      draftId: body.draftId,
      editMode: activeEditMode,
      revisionCount,
      expiresAt,
      request: {
        originalMessage: originalMessageForResponse,
        docType: req.body?.docType ?? null
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
    const saved = await saveScenarioStory({
      chapterId: pending.draft.chapterId,
      sectionId: pending.draft.sectionId,
      storyText: pending.review.finalText,
      applyKey
    });
    pendingChatDrafts.delete(body.draftId);

    res.status(201).json({
      mode: "chat",
      draftId: body.draftId,
      status: "saved",
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
