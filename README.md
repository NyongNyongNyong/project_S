# project_S MVP

`PLAN-000001`의 경량 시나리오 파이프라인을 위한 최소 실행 서버입니다.

## 포함 기능

- 웹 초안 입력 API: `POST /api/drafts`
- 자연어 채팅 생성 API: `POST /api/chat/generate`
- 자연어 채팅 수정 API: `POST /api/chat/revise-draft`
- 자연어 채팅 저장 API: `POST /api/chat/approve`
- 저장된 시나리오 목록/본문 API: `GET /api/stories`, `GET /api/stories/:fileName`
- 시나리오 리뷰/병합 API: `POST /api/scenario/revise`
- 멀티 모델 리뷰어: `auto x4 + gemini + sonnet` 단계형 파이프라인
  - 생성/수정 결과를 `content/stories/scenario-001.md` 같은 시나리오 파일로 즉시 저장

## 빠른 시작

1) 의존성 설치

```bash
npm install
```

2) 환경변수 준비

```bash
cp .env.example .env
```

`.env`에 아래 값을 채운다.

- 저장소:
  - `STORAGE_ROOT_DIR` (기본: `content`)
  - `STORAGE_STORIES_DIR` (기본: `stories`)
- 모델/브리지:
  - `CURSOR_BRIDGE_URL` (기본: `http://127.0.0.1:8787`)
  - `CURSOR_BRIDGE_TIMEOUT_MS` (기본: `120000`)
  - `CURSOR_BRIDGE_AUTH_TOKEN` (옵션. 서버→브리지 인증 토큰)
  - `CURSOR_IDEATION_MODEL` (기본: `auto`, 1단계 3회 확장에 사용)
  - `CURSOR_STRUCTURING_MODEL` (기본: `auto`, 2단계 구조/플롯 정리에 사용)
  - `CURSOR_CONFLICT_MODEL` (기본: `gemini-3.1-pro`, 3단계 설정 충돌 검사에 사용)
  - `CURSOR_ENABLE_REWRITE` (기본: `true`, `false`면 리라이트 호출 생략)
  - `CURSOR_REWRITE_MODEL` (기본: `claude-4.6-sonnet-medium-thinking`, 4단계 리라이트에 사용)
  - `CHAT_DRAFT_TTL_MS` (기본: `86400000`=24시간, 웹 draft 컨텍스트 만료 시간)
  - `CHAT_DEFAULT_EDIT_MODE` (기본: `preserve`, 입력에 모드가 없을 때 적용)
  - 브리지 실행 옵션:
    - `CURSOR_BRIDGE_PORT` (기본: `8787`)
    - `CURSOR_BRIDGE_HOST` (기본: `127.0.0.1`)
    - `CURSOR_BRIDGE_CWD` (옵션. 추론용 작업 경로 고정)
    - `CURSOR_AGENT_BIN` (기본: `cursor`)
    - `CURSOR_AGENT_MODE` (기본: `ask`)

3) Markdown 저장소 확인

```bash
npm run storage:verify
```

저장소 디렉토리/파일 초기화:

```bash
npm run storage:bootstrap
```

4) Cursor 브리지 실행 (추론 엔진)

```bash
npm run bridge
```

브리지는 `cursor agent --print`를 사용하므로, 최초 1회 인증이 필요합니다.

```bash
cursor agent login
```

5) 개발 서버 실행

```bash
npm run dev
```

6) 웹 입력창 열기 (모바일/외부 요청용)

```text
http://localhost:4000/app
```

웹 결과 화면은 아래 3단으로 표시됩니다.
- 내가 요청한 내용
- 각 모델이 리뷰한 내용
- 머지해서 제안된 내용

PC에서는 Obsidian 등으로 `content/stories/*.md`를 열어도 되고, 모바일에서는 같은 주소(`/app`) 하단의 **저장된 시나리오 보기**에서 목록을 고른 뒤 본문을 불러오면 저장된 Markdown 본문을 바로 확인할 수 있습니다.

코드를 받은 뒤 목록이 비거나 이상한 오류가 나면, **이미 떠 있던 `npm run dev`를 한 번 끄고 다시 실행**해 주세요. 예전 서버 프로세스는 `GET /api/stories`가 없어 HTML 404를 돌려주고, 모바일 Safari는 그걸 JSON으로 읽다가 짧은 영문 오류만 표시하는 경우가 있습니다.

## API 예시

초안 제출:

```bash
curl -X POST http://localhost:4000/api/drafts \
  -H "Content-Type: application/json" \
  -d '{
    "chapterId":"CH-01",
    "sectionId":"intro",
    "draftText":"함대가 오르트 구름 경계를 넘었다...",
    "requestType":"review",
    "category":"plot"
  }'
```

아이디어/시나리오 리뷰 후 병합 수정안만 먼저 확인:

```bash
curl -X POST http://localhost:4000/api/scenario/revise \
  -H "Content-Type: application/json" \
  -d '{
    "chapterId":"CH-02",
    "sectionId":"battle-entry",
    "draftText":"정찰선이 도약 게이트에서 이탈하자, 통신망 전체가 정적에 잠겼다...",
    "requestType":"review",
    "category":"pacing"
  }'
```

채팅하듯 자연어로 시나리오 생성:

```bash
curl -X POST http://localhost:4000/api/chat/generate \
  -H "Content-Type: application/json" \
  -d '{
    "message":"지구 근처를 항해하던 주인공이 알 수 없는 사건으로 먼 은하에 떨어진다.",
    "docType":"scenario"
  }'
```

`sectionId`를 직접 주지 않으면 서버가 사람이 읽기 쉬운 번호를 자동 부여합니다.
- 시나리오(`scenario`/`plot`): `시나리오 1`, `시나리오 2`, ...
- 세계관(`lore`/`worldbuilding`): `planet 1`, `planet 2`, ...
- 기타: `item 1`, `item 2`, ...

생성된 draft 수정 요청:

```bash
curl -X POST http://localhost:4000/api/chat/revise-draft \
  -H "Content-Type: application/json" \
  -d '{
    "draftId":"<chat-generate에서 받은 draftId>",
    "revisionMessage":"2번 장면에서 상선과의 대사를 더 긴장감 있게 바꿔줘."
  }'
```

웹 입력창은 `draftId`를 브라우저에 저장하므로 새로고침 후에도 이어서 수정할 수 있습니다.
만료된 draft는 자동으로 정리되며(`CHAT_DRAFT_TTL_MS`), 수정 요청 히스토리는 최근 10개까지 표시됩니다.
기본은 원문 보존 모드(`preserve`)이며, `#rewrite`를 메시지(생성/수정 요청)에 포함하거나 웹 UI에서 rewrite 체크를 켰을 때만 재작성 모드로 동작합니다.

생성된 draft 저장:

```bash
curl -X POST http://localhost:4000/api/chat/approve \
  -H "Content-Type: application/json" \
  -d '{
    "draftId":"<chat-generate에서 받은 draftId>"
  }'
```

## 저장 구조

- 최종 스토리 저장 위치: `content/stories/*.md`
- 파일명 규칙:
  - `sectionId`가 `시나리오 1`/`scenario 1`이면 `scenario-001.md`
  - 그 외는 `sectionId`를 안전한 파일명으로 정규화해 저장

## 주의

- 웹 입력은 API 서버가 받고, 모델 추론은 Cursor 브리지(`src/bridge.ts`)가 수행합니다.
- 브리지가 내려가 있거나 인증/실행 상태가 맞지 않으면 해당 리뷰어는 unavailable로 표시됩니다.
- `category`는 `plot`, `character`, `worldbuilding`, `tone`, `pacing`, `dialogue`, `other` 중 하나를 권장합니다.
