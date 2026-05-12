# Markdown 저장 워크플로우

현재는 승인 큐 없이 결과를 바로 시나리오 파일에 저장한다.

## 저장 위치

- 스토리 최종본: `content/stories/*.md`

## 저장 동작

- `POST /api/drafts`: 생성 결과를 바로 저장
- `POST /api/chat/approve`: 웹에서 생성/수정한 draft를 바로 저장

## 파일명 규칙

- `sectionId`가 `시나리오 1`/`scenario 1` 패턴이면 `scenario-001.md`
- 그 외 `sectionId`는 안전한 파일명으로 정규화되어 저장
