import { env } from "./config";
import { AiReviewResult, DraftInput, ReviewerResult } from "./types";

function getCategoryLabel(input: DraftInput): string {
  return input.category ?? "other";
}

function truncateText(content: string, limit = 1500): string {
  return content.length > limit ? content.slice(0, limit) : content;
}

function buildBaseMeta(input: DraftInput): string {
  const lines: string[] = [
    `- 요청 타입: ${input.requestType}`,
    "- 장르: space-opera",
    `- 카테고리: ${getCategoryLabel(input)}`,
    `- chapter: ${input.chapterId}`,
    `- section: ${input.sectionId}`
  ];
  if (input.worldMemo && input.worldMemo.trim().length > 0) {
    lines.push(`- world_memo: ${truncateText(input.worldMemo, 900)}`);
  }
  return lines.join("\n");
}

function unavailableReview(input: DraftInput, reviewer: string, reason: string): ReviewerResult {
  return {
    reviewer: `${reviewer}(unavailable)`,
    strengths: [],
    concerns: [`${reviewer} 호출 실패: ${reason}`],
    revisionDirection: "Cursor 실행 환경/인증 상태를 확인한 뒤 다시 시도해 주세요.",
    revisedText: `${input.chapterId}/${input.sectionId} 수정안\n${truncateText(input.draftText, 300)}`,
    changeLog: [`${reviewer} disabled: ${reason}`],
    confidence: 0
  };
}

function extractJsonObject(raw: string): string {
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return raw.slice(firstBrace, lastBrace + 1);
  }
  return raw;
}

function clampConfidence(value: number): number {
  if (Number.isNaN(value)) {
    return 0.5;
  }
  return Math.max(0, Math.min(1, value));
}

function parseReviewerJson(raw: string, fallbackReviewer: string): ReviewerResult | null {
  try {
    const parsed = JSON.parse(extractJsonObject(raw)) as Record<string, unknown>;
    const strengths = Array.isArray(parsed.strengths)
      ? parsed.strengths.map((item) => String(item))
      : [];
    const concerns = Array.isArray(parsed.concerns) ? parsed.concerns.map((item) => String(item)) : [];
    const revisionDirectionValue = parsed.revision_direction ?? parsed.revisionDirection;
    const revisedTextValue = parsed.revised_text ?? parsed.revisedText;
    const changeLog = Array.isArray(parsed.change_log)
      ? parsed.change_log.map((item) => String(item))
      : Array.isArray(parsed.changeLog)
        ? parsed.changeLog.map((item) => String(item))
        : [];
    const confidenceValue = parsed.confidence;

    if (strengths.length > 0 && concerns.length > 0 && typeof revisionDirectionValue === "string") {
      return {
        reviewer: fallbackReviewer,
        strengths,
        concerns,
        revisionDirection: revisionDirectionValue,
        revisedText: typeof revisedTextValue === "string" ? revisedTextValue : undefined,
        changeLog,
        confidence:
          typeof confidenceValue === "number"
            ? clampConfidence(confidenceValue)
            : typeof confidenceValue === "string"
              ? clampConfidence(Number(confidenceValue))
              : 0.5
      };
    }
  } catch {
    return null;
  }
  return null;
}

type BridgeInferResponse =
  | {
      ok: true;
      status: string;
      result: string;
      durationMs?: number | null;
    }
  | {
      ok: false;
      error?: string;
      code?: string;
    };

async function callBridgeInference(prompt: string, modelId: string): Promise<BridgeInferResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.CURSOR_BRIDGE_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (env.CURSOR_BRIDGE_AUTH_TOKEN) {
      headers["x-bridge-token"] = env.CURSOR_BRIDGE_AUTH_TOKEN;
    }
    const response = await fetch(`${env.CURSOR_BRIDGE_URL}/infer`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt,
        modelId,
        timeoutMs: env.CURSOR_BRIDGE_TIMEOUT_MS
      }),
      signal: controller.signal
    });
    const data = (await response.json()) as BridgeInferResponse;
    if (!response.ok) {
      return {
        ok: false,
        error: data.ok ? `bridge http ${response.status}` : data.error ?? `bridge http ${response.status}`,
        code: data.ok ? "bridge_http_error" : data.code
      };
    }
    return data;
  } catch (error) {
    const message =
      error instanceof Error && error.message.trim().length > 0
        ? error.message
        : "bridge network error";
    return {
      ok: false,
      error: message,
      code: "bridge_network_error"
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function callTextStep(
  input: DraftInput,
  reviewerName: string,
  modelId: string,
  prompt: string,
  defaultDirection: string,
  defaultConfidence = 0.6
): Promise<ReviewerResult> {
  const bridgeResult = await callBridgeInference(prompt, modelId);
  if (!bridgeResult.ok) {
    const reason = bridgeResult.code ? `${bridgeResult.code}: ${bridgeResult.error ?? "unknown error"}` : bridgeResult.error ?? "unknown error";
    return unavailableReview(input, reviewerName, reason);
  }
  if (bridgeResult.status !== "finished") {
    return unavailableReview(input, reviewerName, `bridge run status=${bridgeResult.status}`);
  }
  if (!bridgeResult.result || bridgeResult.result.trim().length === 0) {
    return unavailableReview(input, reviewerName, "empty result");
  }
  const text = trimFencedOutput(bridgeResult.result);
  return {
    reviewer: `${reviewerName}:${modelId}`,
    strengths: [`${reviewerName} 단계 결과 생성`],
    concerns: [],
    revisionDirection: defaultDirection,
    revisedText: text,
    changeLog: [`${reviewerName} 실행`],
    confidence: defaultConfidence
  };
}

function trimFencedOutput(raw: string): string {
  const fenced = raw.match(/```(?:text|markdown)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  return raw.trim();
}

function buildIdeationPrompt(input: DraftInput, variant: number): string {
  const variantGuide = [
    "관점 A: 생존 리소스/우주 항로/즉각적 위험 중심으로 장면 디테일을 확장한다.",
    "관점 B: 인물 감정/관계/대사 긴장감을 중심으로 장면 디테일을 확장한다.",
    "관점 C: 세계관 떡밥/미지 문명 단서/중장기 플롯 훅 중심으로 장면 디테일을 확장한다."
  ][variant] ?? "관점 A";

  return [
    "너는 유저 아이디어를 풍부하게 만드는 크리에이티브 시나리오 보조 작가다.",
    "출력 목표: 유저 아이디어를 기반으로 상황 디테일/설정/갈등 요소를 자연스럽고 창의적으로 확장한다.",
    "규칙:",
    "1) 원 아이디어의 핵심 사건은 유지한다.",
    "2) 같은 내용 반복 금지. 구체 디테일을 새로 추가한다.",
    "3) 한국어 서술문으로만 작성한다.",
    "4) 번호 목록/JSON/코드블록 금지.",
    "5) 4~6개 단락, 각 단락 2~4문장.",
    "",
    `[변형 지시] ${variantGuide}`,
    "",
    "[유저 아이디어]",
    truncateText(input.draftText, 1600),
    "",
    "[메타]",
    buildBaseMeta(input)
  ].join("\n");
}

function buildStructuringPrompt(input: DraftInput, ideations: string[]): string {
  return [
    "너는 여러 초안을 정리해 일관된 오프닝 시나리오 구조를 만드는 편집자다.",
    "목표: 플롯/논리/설정 정합성을 높이고, 실제 게임 오프닝으로 바로 쓸 수 있는 본문을 만든다.",
    "규칙:",
    "1) 핵심 사건(먼 은하 표류, 자원 고갈, 상선 조우, 보급, 행성 출발)을 유지한다.",
    "2) 시간 순서와 인과를 명확히 한다.",
    "3) 중복 묘사와 과장 표현을 줄인다.",
    "4) 번호 목록/JSON/코드블록 금지.",
    "5) 본문 5~7개 단락.",
    "",
    "[원본 아이디어]",
    truncateText(input.draftText, 1400),
    "",
    "[확장안 A]",
    ideations[0] ?? "",
    "",
    "[확장안 B]",
    ideations[1] ?? "",
    "",
    "[확장안 C]",
    ideations[2] ?? "",
    "",
    "[메타]",
    buildBaseMeta(input)
  ].join("\n");
}

function buildConflictPrompt(input: DraftInput, structuredText: string): string {
  const worldMemo =
    input.worldMemo && input.worldMemo.trim().length > 0
      ? truncateText(input.worldMemo, 2000)
      : "설정집 미제공. 아래 정리본 내부의 설정 충돌/논리 충돌 중심으로 점검.";
  return [
    "너는 SF 세계관 검수 담당자다.",
    "임무: 정리본이 설정집(world_memo)과 충돌하는지 검사하고, 필요한 보정 텍스트를 제안한다.",
    "반드시 아래 JSON만 출력한다.",
    "",
    "{",
    '  "strengths": ["..."],',
    '  "concerns": ["..."],',
    '  "revision_direction": "...",',
    '  "revised_text": "...",',
    '  "change_log": ["..."],',
    '  "confidence": 0.0',
    "}",
    "",
    "[설정집]",
    worldMemo,
    "",
    "[검토 대상 정리본]",
    structuredText,
    "",
    "[메타]",
    buildBaseMeta(input)
  ].join("\n");
}

function buildConservativeRevisionPrompt(args: {
  input: DraftInput;
  sourceText: string;
  revisionMessage: string;
}): string {
  const { input, sourceText, revisionMessage } = args;
  return [
    "너는 원문 보존 편집자다.",
    "목표: 기존 본문을 최대한 유지하면서, 사용자가 요청한 수정만 최소 범위로 반영한다.",
    "절대 규칙:",
    "1) 사용자가 지시한 삭제/치환/표현 수정만 반영하고, 요청하지 않은 설정/사건/전개를 추가하지 않는다.",
    "2) 문단 구조와 문장 순서를 가능한 한 유지한다. 전체 재작성 금지.",
    "3) 입력 원문에 없는 새 사건, 새 인물, 새 배경을 만들지 않는다.",
    "4) 코드블록/번호목록/해설 없이 수정된 본문만 출력한다.",
    "",
    "[원문 본문]",
    sourceText,
    "",
    "[수정 요청]",
    revisionMessage,
    "",
    "[메타]",
    buildBaseMeta(input)
  ].join("\n");
}

async function rewriteMergedScenario(input: DraftInput, finalDraft: string): Promise<string | null> {
  if (!env.CURSOR_ENABLE_REWRITE) {
    return null;
  }

  const rewritePrompt = [
    "너는 시나리오 리라이터다.",
    "목표: 플롯은 유지하고 문체를 자연스러운 현대 한국어로 다듬는다.",
    "출력은 게임 화면 하단 대화형 UI에 직접 표시할 텍스트다.",
    "반드시 자연스러운 현대 한국어 문장으로 작성한다.",
    "영어 번역투, 직역체, 어색한 피동/관념 표현을 금지한다.",
    "중요 규칙:",
    "1) 번호 목록을 절대 쓰지 않는다.",
    "2) 4~6개 단락으로 작성하고, 단락 사이에는 빈 줄 하나를 둔다.",
    "3) 각 단락은 자연스러운 서술 문장 2~4개로 구성한다.",
    "4) 대사는 필요한 장면에만 넣고, 대사 줄은 앞뒤를 줄바꿈으로 분리한다.",
    "5) 대사 형식은 `주인공: \"...\"` / `상선 함장: \"...\"`만 사용한다.",
    "6) 설명문 과다 금지, 지나치게 건조한 보고체도 금지",
    "7) 입력의 핵심 사건(먼 은하 표류, 자원 고갈, 상선 조우, 보급, 행성으로 출발)을 유지",
    "8) '(이름/호출부호)' 같은 플레이스홀더, 슬래시 표기, 괄호 메타 문구를 금지",
    "9) 다음 번역투를 금지: '턱을 잠그다', '조건을 맞추다', '입을 잘 다스리다', '항구에 선다'",
    "10) 코드블록/머리말/해설 없이 시나리오 본문만 출력",
    "",
    "[유저 원본 입력]",
    truncateText(input.draftText, 1500),
    "",
    "[리라이트 대상 본문]",
    finalDraft
  ].join("\n");

  const result = await callBridgeInference(rewritePrompt, env.CURSOR_REWRITE_MODEL);
  if (!result.ok || result.status !== "finished" || !result.result || result.result.trim().length === 0) {
    return null;
  }

  return trimFencedOutput(result.result);
}

function normalizeScenarioText(text: string): string {
  const cleaned = text
    .split("\n")
    .map((line) => line.replace(/^\d+\.\s*/, "").trim())
    .filter((line) => line.length > 0);
  if (cleaned.length === 0) {
    return "아이디어를 기반으로 장면을 생성하지 못했습니다. 입력을 조금 더 구체화해 주세요.";
  }
  return cleaned.join("\n");
}

export async function reviseScenarioConservatively(args: {
  input: DraftInput;
  sourceText: string;
  revisionMessage: string;
}): Promise<AiReviewResult> {
  const { input, sourceText, revisionMessage } = args;
  const prompt = buildConservativeRevisionPrompt({
    input,
    sourceText,
    revisionMessage
  });
  const result = await callBridgeInference(prompt, env.CURSOR_REWRITE_MODEL);
  const fallbackText = normalizeScenarioText(sourceText);
  if (!result.ok || result.status !== "finished" || !result.result || result.result.trim().length === 0) {
    return {
      strengths: [],
      concerns: ["원문 보존 편집 호출 실패로 이전 본문을 유지함"],
      finalText: fallbackText,
      reviewSummary: "- preserve-edit(unavailable): 원문 유지",
      reviewerResults: [
        {
          reviewer: "preserve-edit(unavailable)",
          strengths: [],
          concerns: ["원문 보존 편집 실패"],
          revisionDirection: "편집 실패 시 이전 본문 유지",
          revisedText: fallbackText,
          changeLog: ["preserve edit 실패: fallback 유지"],
          confidence: 0
        }
      ],
      usedModels: ["preserve-edit(unavailable)"],
      changeReason: "원문 보존 편집이 실패하여 기존 본문을 유지했습니다.",
      suggestionText: `[${input.chapterId}/${input.sectionId}] 시나리오 편집안\n\n${fallbackText}\n\n핵심 변경 로그:\n- 원문 유지`
    };
  }

  const revisedText = normalizeScenarioText(trimFencedOutput(result.result));
  const reviewer: ReviewerResult = {
    reviewer: `preserve-edit:${env.CURSOR_REWRITE_MODEL}`,
    strengths: ["요청된 수정만 최소 범위로 반영"],
    concerns: [],
    revisionDirection: "원문 보존 모드로 선택된 요청만 반영",
    revisedText,
    changeLog: [`요청 반영: ${revisionMessage}`],
    confidence: 0.86
  };

  return {
    strengths: reviewer.strengths,
    concerns: reviewer.concerns,
    finalText: revisedText,
    reviewSummary: `- ${reviewer.reviewer} (confidence=${(reviewer.confidence ?? 0.5).toFixed(2)}): ${reviewer.revisionDirection}`,
    reviewerResults: [reviewer],
    usedModels: [reviewer.reviewer],
    changeReason: "원문 보존 모드: 요청된 수정만 보수적으로 반영합니다.",
    suggestionText:
      `[${input.chapterId}/${input.sectionId}] 시나리오 편집안\n\n` +
      `${revisedText}\n\n` +
      "핵심 변경 로그:\n" +
      `- 요청 반영: ${revisionMessage}`
  };
}

export async function generateSuggestion(input: DraftInput): Promise<AiReviewResult> {
  const ideationSteps = await Promise.all(
    [0, 1, 2].map((variant) =>
      callTextStep(
        input,
        `ideation-${variant + 1}`,
        env.CURSOR_IDEATION_MODEL,
        buildIdeationPrompt(input, variant),
        `아이디어 확장안 ${variant + 1} 생성`,
        0.65
      )
    )
  );

  const ideationTexts = ideationSteps.map((step) => step.revisedText?.trim() ?? "").filter((text) => text.length > 0);
  const structuringStep = await callTextStep(
    input,
    "structuring",
    env.CURSOR_STRUCTURING_MODEL,
    buildStructuringPrompt(input, ideationTexts),
    "확장안을 기반으로 구조/플롯/논리/설정 정리",
    0.72
  );
  const structuredText = structuringStep.revisedText?.trim() || input.draftText;

  const conflictPrompt = buildConflictPrompt(input, structuredText);
  const conflictRaw = await callBridgeInference(conflictPrompt, env.CURSOR_CONFLICT_MODEL);
  let conflictStep: ReviewerResult;
  if (!conflictRaw.ok) {
    const reason = conflictRaw.code ? `${conflictRaw.code}: ${conflictRaw.error ?? "unknown error"}` : conflictRaw.error ?? "unknown error";
    conflictStep = unavailableReview(input, "conflict-check", reason);
  } else if (conflictRaw.status !== "finished") {
    conflictStep = unavailableReview(input, "conflict-check", `bridge run status=${conflictRaw.status}`);
  } else if (!conflictRaw.result || conflictRaw.result.trim().length === 0) {
    conflictStep = unavailableReview(input, "conflict-check", "empty result");
  } else {
    const parsed = parseReviewerJson(conflictRaw.result, `conflict-check:${env.CURSOR_CONFLICT_MODEL}`);
    conflictStep = parsed ?? unavailableReview(input, "conflict-check", "invalid json response");
  }

  const postConflictText =
    conflictStep.revisedText && conflictStep.revisedText.trim().length > 0 ? conflictStep.revisedText.trim() : structuredText;
  const rewritten = await rewriteMergedScenario(input, postConflictText);
  const finalScenario = normalizeScenarioText((rewritten && rewritten.trim().length > 0 ? rewritten : postConflictText).trim());

  const rewriteStep: ReviewerResult = rewritten
    ? {
        reviewer: `rewrite:${env.CURSOR_REWRITE_MODEL}`,
        strengths: ["최종 문체 리라이트 완료"],
        concerns: [],
        revisionDirection: "최종 문체/호흡/대사 배치를 다듬어 출력",
        revisedText: rewritten,
        changeLog: ["final rewrite 수행"],
        confidence: 0.78
      }
    : {
        reviewer: `rewrite:${env.CURSOR_REWRITE_MODEL}(skipped-or-failed)`,
        strengths: [],
        concerns: ["리라이트 비활성화 또는 실패로 정리본/충돌검사본을 그대로 사용"],
        revisionDirection: "리라이트를 건너뛰고 직전 단계 결과를 최종본으로 사용",
        revisedText: postConflictText,
        changeLog: ["final rewrite 생략"],
        confidence: 0.5
      };

  const reviewers = [...ideationSteps, structuringStep, conflictStep, rewriteStep];
  const strengths = Array.from(new Set(reviewers.flatMap((reviewer) => reviewer.strengths)));
  const concerns = Array.from(new Set(reviewers.flatMap((reviewer) => reviewer.concerns)));
  const mergedChangeLog = Array.from(new Set(reviewers.flatMap((reviewer) => reviewer.changeLog ?? [])));
  const reviewSummary = reviewers
    .map((reviewer) => {
      const confidenceText = (reviewer.confidence ?? 0.5).toFixed(2);
      return `- ${reviewer.reviewer} (confidence=${confidenceText}): ${reviewer.revisionDirection}`;
    })
    .join("\n");

  return {
    strengths,
    concerns,
    finalText: finalScenario,
    reviewSummary,
    reviewerResults: reviewers,
    usedModels: reviewers.map((reviewer) => reviewer.reviewer),
    changeReason:
      "3회 auto 아이디어 확장 → auto 구조화 → gemini 설정 충돌 검사 → sonnet 4.6 리라이트 플로우로 최종 시나리오를 생성합니다.",
    suggestionText:
      `[${input.chapterId}/${input.sectionId}] 시나리오 생성안\n\n` +
      `${finalScenario}\n\n` +
      "핵심 변경 로그:\n" +
      `${mergedChangeLog.map((item) => `- ${item}`).join("\n") || "- 변경 로그 없음"}`
  };
}
