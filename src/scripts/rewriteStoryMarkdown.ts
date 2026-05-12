/**
 * 시나리오 Markdown 본문을 Sonnet(CURSOR_REWRITE_MODEL)으로만 리라이트해 파일에 다시 씁니다.
 * 사용: npx tsx src/scripts/rewriteStoryMarkdown.ts content/stories/scenario-002.md ["유저 원 한줄 힌트"]
 * 선행: Cursor bridge 실행 (npm run bridge:start), .env에 CURSOR_BRIDGE_URL 등 설정.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { rewriteMergedScenario } from "../ai";
import type { DraftInput } from "../types";

function splitFrontMatter(raw: string): { front: string; body: string } {
  if (!raw.startsWith("---\n")) {
    throw new Error("파일은 --- 로 시작하는 front matter가 있어야 합니다.");
  }
  const end = raw.indexOf("\n---\n", 4);
  if (end < 0) {
    throw new Error("front matter 닫는 --- 를 찾을 수 없습니다.");
  }
  const front = raw.slice(0, end + 5);
  const body = raw.slice(end + 5).replace(/^\n+/, "");
  return { front, body };
}

function pickSectionId(front: string): string {
  const m = front.match(/^section_id:\s*(.+)$/m);
  return m?.[1]?.trim() || "시나리오";
}

async function main() {
  const rel = process.argv[2] || "content/stories/scenario-002.md";
  const filePath = path.resolve(process.cwd(), rel);
  const userHint =
    process.argv[3]?.trim() ||
    "오래 붙은 현상수배로 행성 알파-가칭의 거대 AI(스카이넷 가칭)를 끄러 가면, 무인 폐허 도시·중앙 건물·로그 고백·전원 차단으로 이야기가 끝난다.";

  const raw = await readFile(filePath, "utf8");
  const { front, body } = splitFrontMatter(raw);
  const sectionId = pickSectionId(front);

  const input: DraftInput = {
    chapterId: "CHAT",
    sectionId,
    draftText: userHint,
    requestType: "review",
    category: "plot"
  };

  const rewritten = await rewriteMergedScenario(input, body.trimEnd() + "\n");
  if (!rewritten || rewritten.trim().length === 0) {
    console.error(
      "리라이트 실패. 확인: (1) `npm run bridge:start` 로 Cursor bridge 실행 (2) .env CURSOR_ENABLE_REWRITE=true (3) CURSOR_BRIDGE_URL·인증"
    );
    process.exitCode = 1;
    return;
  }

  const inLen = body.trim().length;
  const outLen = rewritten.trim().length;
  if (inLen > 800 && outLen < Math.floor(inLen * 0.45)) {
    console.error(
      `리라이트 결과가 비정상적으로 짧습니다 (${outLen}자, 원본 ${inLen}자). 파일은 바꾸지 않았습니다. 프롬프트·모델 응답을 확인하세요.`
    );
    process.exitCode = 1;
    return;
  }

  const now = new Date().toISOString();
  const frontUpdated = /^updated_at:/m.test(front)
    ? front.replace(/^updated_at:.*$/m, `updated_at: ${now}`)
    : front.replace(/\n---\n$/, `\nupdated_at: ${now}\n---\n`);

  const out = `${frontUpdated}\n${rewritten.trim()}\n`;
  await writeFile(filePath, out, "utf8");
  console.log(`OK: ${filePath} (model=${process.env.CURSOR_REWRITE_MODEL || "env 기본"})`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
