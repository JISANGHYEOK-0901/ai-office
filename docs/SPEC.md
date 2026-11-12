# AI Office 설계 기준

이 문서는 현재 동작을 주제별로 정리한다. 날짜별 원문과 결정 이유는 `docs/DECISIONS.md`에 있다.

## 1. 개요와 사용자 흐름

### 개요

- 사무 업무를 역할별 AI 직원에게 나눠 맡기고, 진행 상황을 로컬 대시보드로 관제한다.
- 대표(사용자)는 비서실장 지시창 하나로 업무를 지시한다. 비서실장이 계획·배정·검토·전달을 맡는다.
- 실행 엔진은 Claude Code와 Codex다. 비서실장·직원 모두 엔진·모델·effort를 정할 수 있다.
- 런타임은 모두 로컬이다. Node 20 이상, 서버 호스팅 없음. 운영 의존성은 Playwright(계정 브라우저)뿐이다.

### 사용자 흐름

1. 첫 실행: 정본에 부서가 없다. 온보딩 카드가 "첫 부서 만들기"를 안내한다.
2. 부서 추가: 프리셋(개발·크리에이티브·마케팅·비즈니스·운영·리뷰·리서치·법무·투자·라이프·재무·검증실)에서 고르거나 직접 입력한다(이름, 영문 표기, 색, 설명, 엔진, 허용 도구, 기본 모델).
3. 부서를 만들면 관제 뷰와 사무실 뷰에 카드와 방이 바로 생긴다.
4. 직원 추가: 부서 안에서 이름·직급(사원~팀장)·담당·상세 지침·팀장 여부·모델을 정한다. 직무 프리셋을 고르면 담당·지침·모델이 채워진다.
5. 언제든: 부서·직원 수정·삭제(확인 대화상자), 근무/휴무 전환, 계정 연결, 회사 설정.
6. 업무 지시: 비서실장 지시창에 문장을 쓴다. 직원 개별 지시는 없다.
7. 완료: 비서실장 검토와 최종산출물 저장이 끝나면 업무가 자동 완료되고 결과 모달이 열린다. 승인 단계는 없다.
8. 저장: 조직 변경은 서버가 `org/*.json`에 원자적으로 저장하고 곧바로 sync로 에이전트 파일을 갱신한다.

## 2. 디렉터리·작업 공간·보관함

### 프로그램 레포

```
org/presets.json          부서·직무 프리셋
org/templates/            부서 공통 지침 템플릿(선택), report.html 보고서 양식
scripts/office.mjs        업무·흐름·조직 CLI
scripts/codex-review.mjs  Codex 검토 실행기
scripts/sync-agents.mjs   정본 → 에이전트 파일 생성(--write / --check)
scripts/doctor.mjs        환경 점검
scripts/migrate.mjs       예전 레포 내 데이터 이전
scripts/browser-mcp.mjs   직원용 office_browser MCP 서버
hooks/                    office-event(이벤트), chief-guard(PreToolUse), session-context(SessionStart)
lib/                      공용 모듈
dashboard/                server.mjs, runner.mjs, orchestrator.mjs, continuous.mjs, state.mjs, schemas/, public/
test/                     node:test
```

### 작업 공간

- 회사 데이터와 AI 실행 위치다. 기본 `~/AIOffice`(Windows `%USERPROFILE%\AIOffice`).
- 경로 결정 순서: `AI_OFFICE_ROOT`(테스트·내부용) > `AI_OFFICE_WORKSPACE` > `--workspace` > 레포의 `.office-local.json` > 호환 모드 > 기본값.
- 작업 공간이 프로그램 레포와 같거나 그 안·상위면 `WorkspaceError`다.
- 작업 공간에 두는 것:
  - 데이터: `org/`(departments.json, roster.json, company.md, company.json), `outputs/`, `.office/`, `보관함/`
  - 생성물: `.ai-office-workspace`(표식), `CLAUDE.md`, `AGENTS.md`, `.claude/agents/`, `.claude/settings.json`, `.claude/skills/office-task/SKILL.md`, `.codex/agents/`, `scripts/office.mjs`·`scripts/codex-review.mjs`(프로그램 스크립트 연결)
- 생성물은 생성 표식(텍스트) 또는 `.claude/ai-office-generated.json`의 해시(JSON)가 맞을 때만 갱신한다. 사용자가 만든 파일은 보존한다.
- 서버 시작(데모 제외)·`npm run sync`·migrate가 `ensureWorkspace`로 폴더·생성물·에이전트 파일을 맞춘다.
- 모든 AI 실행은 cwd가 작업 공간이다. codex는 `-C <작업 공간>`.
- 프리셋·템플릿은 작업 공간에 같은 파일이 있으면 그것을, 없으면 프로그램 레포의 것을 쓴다.
- 호환 모드: 작업 공간을 고르지 않았고 기본 작업 공간 표식이 없으며 레포 안에 예전 회사 데이터가 있으면 레포를 데이터 위치로 쓴다. 이때 레포 보호 가드는 적용되지 않는다. 화면 배너·doctor가 `npm run migrate`를 안내한다.
- migrate: 복사 → 파일 수·크기 검증(실패하면 이번 복사만 되돌림) → `.office-local.json`에 기억 → 원본을 `.office-migrated-<KST 날짜>[-N]/`로 이동. 확인이나 `--yes` 없이는 바꾸지 않는다. 서버가 살아 있으면(`.office/server.lock`) 거부한다(`--force`로 무시).

### `.office/` 런타임 데이터

| 경로 | 내용 |
|---|---|
| `events.jsonl` | 정규화 이벤트 |
| `tasks.json`, `sessions.json` | 업무 목록, 세션 → 업무 연결 |
| `runs.json`, `runs/<id>.log`, `runs/<id>.result.md` | 실행 목록(최대 200개 보존), 로그, 답변 전문(0600) |
| `orchestrations/<rootId>.json` | 업무 체크포인트 v2(비공개 0700/0600) |
| `continuous/<rootId>.json` | 지속 감시 체크포인트 |
| `schedules.json` | 업무 예약(1회·N회·매일) |
| `publications/` | 외부 작업 발행 증표 |
| `video-publications.json` | 영상 게시 이력(영구) |
| `final-outputs/settings.json`, `index.json` | 최종산출물 위치·등록 파일·해시 |
| `history.json` | 내역 정리 기준 시각 |

### 업무 폴더와 최종산출물

- 업무 폴더: `outputs/<날짜>/<slug>/`. 업무 id는 `<날짜>/<slug>`(`isTaskId`). 대시보드 지시는 `<날짜>/run-<실행 id>`다.
- 업무 폴더에는 plan.json, brief.md, meeting.md, report.md, `<부서>/<직원id>-<이름>.<확장자>` 산출물, reviews/, evidence/, discoveries/, pause-note.md가 생긴다.
- 최종산출물 기본 위치: `<작업 공간>/보관함/최종산출물/<날짜>/<업무명>--<업무 slug>/`.
  - 업무명은 계획의 `plan.goal`이다. 예전 업무를 다시 모을 때는 기존 폴더 이름을 유지한다.
  - 회사 설정에서 상위 폴더를 바꿀 수 있다(절대 경로). 변경은 다음 전달부터이고 기존 파일은 옮기지 않는다.
  - 예전 `<작업 공간>/최종산출물/`의 기록은 옮기지 않고 색인의 폴더로 계속 연다.
- 지시 경로: 대표가 지시에 전체 경로(`~/…`, `/…`, `C:\…`)를 적고 의도 판별 근거가 원문에 있으면 그 폴더에 바로 모은다(날짜·업무명 하위 폴더 없음).
  - 업무 시작 전 `customOutputDirectory`로 검사한다. 프로그램 폴더, outputs·.office·org·계정 저장소, 작업 공간·홈 폴더 자체면 400이다.
- 저장 위치는 프로그램 폴더, outputs, .office, `~/.config/ai-office/private` 안일 수 없다.

### 보관함

- 서버 시작 때 작업 공간에 `보관함/`(0700)을 만들고 `.gitignore`·`.ignore`·`.rgignore`(`*`)로 Git·검색에서 뺀다.
- `보관함/계정.env`(0600)가 없으면 안내 서식을 만든다.
- 계정 파일 형식: `<이름>_URL`, `<이름>_ID`(또는 USER/USERNAME), `<이름>_PASSWORD`(또는 PW), 선택 `<이름>_HOSTS`. 주소 규칙은 일반 웹사이트 연결과 같다. 형식이 틀린 항목은 값 없이 사유만 낸다.

## 3. 조직 정본과 생성 규칙

### org/departments.json

```json
[{ "id": "research", "name": "리서치부", "en": "RESEARCH", "color": "#38bdf8",
   "engine": "claude", "tools": ["Read","Write","Edit","Glob","Grep","WebSearch","WebFetch"],
   "model": "sonnet", "summary": "시장·경쟁사·고객 조사" }]
```

- `engine`: `claude` | `codex`. `tools`를 생략하면 Claude는 모든 도구를 쓴다.
- 추가 필드: `active`(기본 true), `permission`(`acceptEdits` 기본 | `bypassPermissions` | `default`), `order`, `instructions`(4000자), `capabilities`(40자 이하 20개), `handoffs`(부서 id 20개), `handoffPolicy`(`suggested` 기본 | `required`), `codexModel`, `codexEffort`, `codexRole`.
- `codexRole`: `exec`(workspace-write 실무) | `review`(read-only 검토). 값이 없는 예전 Codex 부서는 review다. 새 부서는 verify 프리셋이면 review, 그 밖은 exec로 저장한다.
- 프리셋으로 만들 때 id가 없으면 프리셋 id를 먼저 쓰고, 있으면 영문 표기로 만든다.
- `handoffPolicy: required`면 필수 부서가 실제 후속 의존 경로로 이어져야 한다. 누락·자기 참조·순환은 거부한다.
- `bypassPermissions`는 명시해야 하고 화면에 경고를 붙인다.

### org/roster.json

```json
[{ "id": "market-researcher", "name": "김대리", "department": "research",
   "title": "선임", "lead": false, "rank": "대리", "role": "market-researcher",
   "specialty": "시장 규모·성장률·세그먼트 추정",
   "description": "시장 규모, 성장률, 세그먼트를 출처와 함께 조사할 때 사용",
   "instructions": "역할별 핵심 지침" }]
```

- 추가 필드: `active`, `model`(부서 기본값보다 우선), `thoughts`(대기 중 혼잣말 2~3개).
- `engine`: 비우면 부서 엔진을 따르고, `"aside"`면 그 직원만 Aside 직원으로 실행한다(브라우저 업무 직원용, 5장 "Aside 직원"). 부서 `engine`도 `claude`·`codex`·`aside` 중 하나다.
- `id`: `^[a-z][a-z0-9-]{1,47}$`, 부서·직원 id 전체에서 유일. `chief`는 쓸 수 없다. 화면이 부서 id와 순번으로 자동 생성한다(예: `research-3`).
- 부서당 `lead: true`는 1명 이하다.
- description·specialty가 모두 비면 저장은 하되 "비서실장이 배정 기준으로 쓸 설명이 없습니다" 경고를 낸다.

### 개인 데이터와 백업

- departments.json·roster.json·company.md·company.json과 생성 파일은 Git에서 제외한다. 파일이 없으면 빈 회사(`[]`)로 시작한다.
- 회사 구성 내보내기: `{version:1, company, departments, roster}`(설정이 있으면 `settings` 포함). 화면의 회사 설정과 `node scripts/office.mjs org export|import <파일> [--yes]`로 한다.
- 가져오기는 검증 실패 시 아무것도 쓰지 않는다. 본문 한도 8MB.

### 생성 규칙 (sync-agents)

- Claude: `.claude/agents/<id>.md`. frontmatter에 `name`, `description`, `tools`, `model`.
- Codex: engine이 codex인 부서의 직원은 `.codex/agents/<id>.toml`(`name`, `description`, `developer_instructions`)만 만든다.
- 휴무 부서·직원은 파일을 만들지 않는다. 그래서 비서실장이 부를 수 없다.
- 생성 표식이 있는 파일 중 정본에 없는 것은 지우고, 표식이 없는 파일은 건드리지 않는다(덮어쓰지 못한 파일은 응답 `warnings`).
- `--check`는 변경이 필요하면 종료 코드 1과 차이를 출력한다.

### 행동 지침 계층

직원 지침 파일은 다음 순서로 조립한다. 각 단계는 화면에서 편집한다.

1. 공통 머리말(자동): 이름·직급·부서, 산출물 경로, 보고 형식, 팀장 규칙, 근무 규칙(계정 파일 접근 금지 포함).
2. 회사 공통 규칙: `org/company.md`(8000자).
3. 부서 공통 지침: 부서 `instructions`. 없으면 `org/templates/<id>.md`.
4. 역할 지침: 직원 `instructions`.

- `.md` 산출물 이름은 report·summary·findings·analysis로 시작하지 않는다. Claude Code가 서브에이전트의 이런 파일 쓰기를 거부하기 때문이다. 팀장 부서 보고서는 `<부서id>/dept-report.md`다.

### 직원 모델 정책

모델은 별칭(`haiku`/`sonnet`/`opus`/`inherit`)으로 지정한다.

| 업무 유형 | 기본 모델 |
|---|---|
| 웹페이지 조사(읽고 핵심 추출, 분류) | haiku |
| 자료조사(여러 출처 검색·정리) | sonnet(부서와 대부분 직무 기본값) |
| 시장조사 | 수집은 sonnet, 최종 분석은 opus |
| 서류작업 | sonnet, 외부 제출·복잡한 문서는 opus |

- 우선순위: 직원 `model` > (팀장이면 opus) > 부서 `model` > sonnet(`resolveAgentModel`).
- presets.json의 각 role에 `model`을 명시한다.

### Codex 모델

- 기본: 모델 `gpt-6.1-sol`, effort `max`. 전역 `~/.codex/config.toml`에 기대지 않고 `-m <모델> -c model_reasoning_effort="<강도>"`로 항상 명시한다.
- 적용 순서: 환경변수 `OFFICE_CODEX_MODEL`/`OFFICE_CODEX_EFFORT`(일회성) > 직원·부서 `codexModel`/`codexEffort` > 기본값.
- 허용 effort: low|medium|high|xhigh|max|ultra. 모델 slug는 `^[a-z0-9][a-z0-9.-]{1,63}$`.
- 모델 목록은 `CODEX_HOME/models_cache.json`의 공개 항목을 읽고, 없으면 기본 목록을 쓴다. 인증 파일은 읽지 않는다.

### 비서실장 설정과 실행 모드

- `org/company.json`의 `chief:{engine, model, effort}`는 비서실장 설정이다. 기본은 codex·`gpt-6.1-sol`·`high`다(저장된 값은 그대로 쓴다).
- 단계별 비서실장 모델(`resolveControlChief`):
  - 최종 검토: 회사 설정의 비서실장 모델.
  - 진행 점검: Claude Sonnet/medium. Claude를 쓸 수 없으면 Codex medium(더 낮게 설정했으면 그 값).
  - 계획·재배정 등 조율: Claude가 설치·로그인돼 있고 모드가 codex가 아니면 Claude `opus`/`high`. 아니면 Codex 설정. 로그인 상태를 아직 모르면 "확인 중" 오류로 다시 지시하게 한다.
- `company.json`의 `mode`: `auto`(기본) | `claude` | `codex` | `mixed`. auto면 설치·로그인 점검으로 claude/codex/mixed/none을 정한다(`/api/state.mode`).
- 새 실무 부서는 사용 가능한 Claude가 기본이다. 검토 설정만으로 실무 부서를 Codex로 만들지 않는다.
- doctor는 Claude 또는 Codex 중 하나가 로그인돼 있으면 통과한다.

## 4. 업무 실행 흐름

### 지시와 실행

- 지시창 입력은 `POST /api/runs {prompt, model?, engine?, effort?, schedule?, continuous?}`로 간다. 요청은 20000자 이하.
- `agentId`가 있으면 400("직원에게 직접 지시할 수 없습니다. 비서실장에게 업무를 지시해 주세요.")이고 업무를 만들지 않는다.
- 서버 처리 순서: 의도 판별 → 일시정지·재개면 처리 후 종료 → 예약 지시(1회·N회·매일)면 예약만 저장 → 지시 경로 검사 → `runner.start`.
- runner는 업무(`<날짜>/run-<id>`)를 등록하고, 요청 끝에 `[저장 위치] …` 안내를 붙여 오케스트레이터(`dashboard/orchestrator.mjs`)로 실행한다. 지속 감시면 `dashboard/continuous.mjs`로 실행한다.
- 지시창 파일 올리기: 지시창의 `📎 파일` 버튼이나 끌어다 놓기로 파일을 고르면(한 번에 10개, 파일마다 25MB 이하) 지시할 때 먼저 `POST /api/uploads {name, data(base64)}`로 올린다(`lib/uploads.mjs`).
  - 서버는 작업 공간 `보관함/업로드/<한국 날짜>/<이름>`에 저장하고 `{path, name, size}`를 돌려준다. 같은 이름이 있으면 ` (2)`를 붙여 덮어쓰지 않는다. 이름의 경로·제어 문자는 빼고, 숨김·계정 파일과 허용 목록(문서·한글·그림: docx doc xlsx xls csv pptx ppt pdf txt md hwp hwpx png jpg jpeg gif webp) 밖의 형식은 막는다. 토큰·출처 검사는 다른 쓰기 요청과 같고, 본문 한도만 base64 크기에 맞춰 따로 둔다. 데모 모드는 409.
  - 화면은 올린 경로를 지시문 끝에 `[업로드한 파일]` 목록으로 붙여 `POST /api/runs`로 보낸다("첨부"라고 쓰지 않는다. 메일 첨부로 읽히지 않게). 지시가 실패하면 고른 파일은 남고, 다시 보낼 때 이미 올린 파일은 다시 올리지 않는다. 파일만 고르고 할 일을 비우면 보내지 않고 한 줄 적으라고 안내한다.
- 실제 CLI 동시 실행은 전역 4개다. 넘치면 대기열에 넣는다. 오케스트레이션 자체는 이 수에 넣지 않는다.
- 중지: 오케스트레이션 전체와 진행 중인 모든 자식 프로세스를 끝낸다. 프로세스는 SIGTERM, 5초 뒤 SIGKILL.

### 의도 판별

- 판단은 AI, 권한은 근거 검사로 나눈다(`lib/intent.mjs`, `lib/ai-judge.mjs`).
- 지시 접수 중(판별 최대 15초)에는 지시창이 전달 중 상태를 표시하고 버튼을 잠근다. 서버도 접수 중인 같은 지시를 409로 거절해 다른 탭·터미널의 중복 업무를 막는다.
- 호출: 로그인된 Claude면 `claude -p --model haiku --output-format json --json-schema <스키마> --tools ''`, 아니면 `codex exec -s read-only --output-schema … -c model_reasoning_effort="low"`. 작업 공간 밖(임시 폴더)에서 실행한다. 제한 15초.
- 테스트용 가짜 CLI(`.js`)면 판별하지 않는다. `AI_OFFICE_JUDGE=on`으로 켜고 `off`로 끈다.
- 지시창(`judgeCommand`, `schemas/intent.json`): kind(task/pause/resume), externalActions(mail/post/comment/web), delegated, standing(none/until_stop/duration/deadline + 분·종료 시각·간격), 예약(scheduleTime·scheduleDate·scheduleTimes), outputDir와 각 근거. 예약 날짜는 오늘부터, 횟수는 1~365만 받는다.
- 답장(`judgeAnswer`, `schemas/intent-answer.json`): decision(approve/decline/modify/other), add/removeActions, delegated와 근거.
- 근거 검사: 행동 권한이 되는 판단은 근거 문장(앞말·따옴표 제거 뒤)이 대표 원문에 있을 때만 인정한다.
  - 외부 작업·위임은 근거가 글자 그대로 맞지 않아도 규칙 판별이 같은 결론이면 인정한다.
  - 상시 실행은 간격 10초~24시간, 기간·종료 시각 1년 이내만 받는다. 간격이 없으면 5분이다.
  - outputDir는 전체 경로 형태이고 경로가 원문에 있을 때만 쓴다.
- 대신 처리: 판별 실패·시간 초과·형식 오류면 규칙(`pauseIntent`, `resumeIntent`, `externalActionPolicy`, `continuousRequest`, `scheduleRequest`)을 쓴다. 규칙상 분명한 "멈춰"·"이어서 해줘"는 판별을 기다리지 않는다.
- 실행기가 붙인 `[저장 위치]` 안내는 판별 대상에서 뺀다.
- 판별 결과는 `runner.start`의 `intent`(actions·delegated·outputDir)로 넘겨 체크포인트 `state.intent`에 둔다. 답장 판별은 `decisions[].intent`로 남는다. 판별 결과가 없는 예전 업무는 규칙을 쓴다. 재발송·결과 확인 문구는 규칙으로 판별한다.

### 계획

- 비서실장이 계획 JSON을 낸다(`schemas/plan.json`). 형식:
  - `plan = {version:1, task, goal, stages, review:{by, criteria}, gaps:[{need, suggestion}], publications, deliverables}`
  - `stages[] = {id, title, dept, agent, inputs, output, done, dependsOn, parallelGroup, connection, target}`
  - 응답 바깥 필드: `question`, `needsMeeting`, `meetingAgents`, `meetingSummary`, `rerunStages`.
- `goal`은 짧은 한국어 업무 이름이다(최종산출물 폴더 이름). 전달 단계의 `title`은 대표가 받는 파일 이름이다.
- `review.by`는 기본 `chief`다. 대표가 별도 전문 검토를 명시했을 때만 `codex` 또는 검토 직원 id를 쓴다. 검증실 부재는 역량 공백이 아니다.
- 생산 단계는 근무중 실행 직원에게만 배정한다. 검토 전용 Codex 직원은 stages에 넣지 않는다.
- 검사(`validatePlan`): 근무중 직원, agent와 dept 일치, 순환 없음, 최대 30단계, 단계 id 영문·숫자·`_-` 40자, output이 업무 폴더 안, inputs는 앞 단계 id 또는 작업 공간 안 파일, 금지된 `.md` 이름 없음, publications 형식.
- 계획이 허용 목록에 없는 외부 작업을 요구하면(`requestedActions` 또는 `publications`) 작업 전에 `phase: action-confirm`으로 묻는다. "진행"이면 물어본 작업만 허용해 계획을 다시 세우고, "하지 마"면 초안까지만 만든다. "초안만" 지시와 이미 거절한 작업은 묻지 않는다.
- 검사 실패나 허용되지 않은 외부 작업이 남아 있으면 사유를 붙여 한 번 다시 요청한다. 또 실패하면 업무를 blocked로 둔다.
- `gaps`는 필요한 역량의 직원·부서가 없을 때만 쓴다. 외부 작업 허용·계정 연결·로그인 부족은 역량 공백이 아니다.
- 입력 경로는 직원 실행 전에 절대 경로로 정규화한다. 작업 공간 밖 입력은 거부한다.
- `plan.deliverables`: 대표에게 전달할 단계 id(또는 산출물 경로). 빈 배열은 첨부 없음. 필드가 없으면 후속 의존이 없는 단계 산출물이다.
- 계획을 저장하면 plan.json·brief.md를 쓰고 `plan.set` 이벤트를 남긴다.
- 질문이 꼭 필요하면 `question`에 묶고 plan은 null이다(`phase: plan` 질문).
- 계획용 문서 미리보기: 대표 원문에 작업 공간 안의 Word·Excel·PowerPoint 경로(`보관함/…`, `outputs/…`, `inputs/…`. 공백·괄호가 든 이름 포함, 지시창에서 올린 파일 포함)가 있으면 앞부분 글자(문서마다 1500자, 최대 3개)를 계획 프롬프트에 넣는다(`documentPreview`). 비서실장의 Read는 이 형식을 열지 못해 담당·단계·전달 파일 이름(문서 속 이름 등)을 정할 근거가 없기 때문이다. 연락처 라벨(휴대폰·전화번호·이메일·주소·계좌) 다음 칸과 메일·7자리 넘는 숫자는 가린다. 비밀 위치·숨김 폴더 파일은 읽지 않는다(`blockedReason`). 문서 전체는 담당 직원이 읽는다.

### 업무 시작 전 계정 확인

- 계획 직후 작업 전에, 허용된 외부 작업과 사이트 조회 단계의 계정을 확인한다.
- 쓸 수 있는 계정: `connected`이거나, 첫 로그인을 마쳤고(`firstLoginDone`) 다시 로그인할 정보가 있는 계정.
- 없으면 실행기가 로그인 창을 직접 연다(`outbound.requestLogin`). 없는 연결은 만들고, 대표가 로그인을 마치면 답장 없이 이어 간다. 비밀번호는 다루지 않는다. 로그인 대기 시간은 업무 예산에 세지 않는다.
- 지시의 링크로 서비스를 알 수 있으면(메일·글·댓글 지시) 계획 전에 로그인을 끝내 계획이 연결 계정을 알게 한다. 링크가 없으면 계획 뒤 창을 열고, 로그인 후 계획을 한 번 다시 세운다.
- 지시의 링크로 서비스를 알았고 계정이 저장 상태로는 쓸 수 있어도, 계획 전에 그 링크를 연결 계정 창으로 실제로 열어 확인한다(`outbound.checkLogin`). 저장 상태가 `connected`여도 사이트 로그인은 그사이 풀렸을 수 있기 때문이다. 풀렸으면 그 창이 로그인 창으로 바뀌고 위와 같이 기다린다. 대표가 지시한 직후 자리에 있을 때 로그인하게 하려는 것이다(게시 직전에 알면 대표가 자리를 비웠을 수 있다). 확인하지 못하면(브라우저 오류·계정 보호 등) 막지 않고 게시 단계가 기존대로 다룬다. 공식 API로 올리는 카페 글쓰기 지시는 확인하지 않는다. 예약·상시 업무도 확인하지 않는다.
- 로그인 대기는 30분이다(`LOGIN_WAIT_MS`). 지시하고 자리를 비워도 돌아와 로그인하면 답장 없이 이어 간다. 로그인 창 감시는 이보다 5분 길게 둔다. 직원 창이 로그인 창으로 바뀐 경우도 로그인 창으로 등록해, 로그인 상태 저장과 창 닫힘이 끝난 뒤에 이어 간다.
- 창을 닫았거나 30분이 지나면 `phase: account`로 알리고, 답장을 받으면 다시 연다(AI 판별 없음). "하지 마"면 외부 작업을 하지 않고 마친다.
- 예약·상시 업무는 창을 열지 않고 `phase: account`로 보관함/계정.env 또는 계정 연결을 안내한다.
- 같은 서비스 계정이 여럿이면 어느 계정을 쓸지 묻는다. 계획에 적힌 연결이 목록에 없던 경우(web·조회 단계)는 답장 뒤 계획을 다시 세운다.

### 빠른 조회

- 지시 판별(`quick`, `quickAgent`)이 단순 조회로 보면 계획·회의·진행 점검·최종 검토 없이 직원 한 명이 한 번에 끝낸다(`lib/quick.mjs`). Claude 직원은 Sonnet/low, Codex 직원은 medium으로 실행한다.
- 외부 작업이 허용됐거나, 상시·예약이거나, 지시에 검증·꼼꼼·교차·대조·검토·분석·보고서·HTML·PDF·엑셀·초안·제안서·기획이 있으면 쓰지 않는다. 판별이 실패해도 쓰지 않는다.
- 필수 전달 부서를 거치지 않는다. 출처 자동 확인은 하되 되돌리지 않고, 결과를 보고서의 확인 필요에 적는다. 보고서에 최종 검토 생략을 밝힌다.
- 셸을 쓸 수 있는 Claude 직원은 뉴스·소식 요청이면 `scripts/news-search.mjs`(Bing·Google 뉴스 RSS, AI 호출 없음)로 후보를 받아 바로 쓴다. 날짜별 15건, 전체 40건까지 받고 제목·매체·게시 시각·링크는 받은 값 그대로 적는다.
- 그 밖의 자료 요청은 웹 검색 뒤 `scripts/check-links.mjs`로 후보 링크의 열림 여부·실제 제목·게시일을 한 번에 확인한다. 게시일은 페이지의 메타 태그·구조화 데이터·time 태그에서만 읽고 주소의 숫자로 추정하지 않는다. 둘 다 사내망·로컬 주소를 열지 않는다.
- 부서 도구에 Bash가 없거나 Codex 직원이면(셸 네트워크 차단) 두 명령을 안내하지 않고 웹 검색과 필요한 페이지 열기로 처리한다. 피드를 받지 못해도 웹 검색으로 이어 간다.
- 구글 뉴스 경유 링크는 출처 자동 확인에서 열지 않고 따로 세어 보고서에 밝힌다.

### 문서 제작(PowerPoint·Word·Excel)

- 단계 출력이 `.pptx`·`.docx`·`.xlsx`이고 셸을 쓸 수 있는 부서면 프로그램에 든 Node 라이브러리(`pptxgenjs`·`docx`·`exceljs`·`jszip`)와 Excel 차트 도우미(`lib/xlsx-chart.cjs`)를 안내한다. 기존 파일을 고칠 때도 원본은 두고 출력 경로에 새 파일로 저장한다.
- 산출물 검사(`lib/office-files.mjs`)는 PPT·Word·Excel·PDF가 열리는 구조인지 코드로 본다. 어긋나면 한 번 다시 시키고, 그래도 안 되면 멈춘다.
- 수식 계산값 누락과 화면 확인 누락은 한 번 다시 시킨다. 그래도 남으면 최종 검토에 알려 보고서의 확인 필요에 적는다.
- 화면 확인은 `scripts/render-doc.mjs`로 파일 옆 `preview-<이름>/`에 이미지를 만들어 직원이 본다. LibreOffice가 없으면 요구하지 않는다. `npm run doctor`가 라이브러리와 LibreOffice를 점검한다(둘 다 필수 아님).

### 간단한 문서 수정

- 지시 판별(`quickEdit`, `quickEditFile`)이 대표가 이름을 적은 파일 1개의 작은 수정으로 보면 계획·회의·진행 점검·최종 검토 없이 직원 한 명이 끝낸다. Claude 직원은 Sonnet/low, Codex 직원은 medium으로 실행한다.
- 외부 작업, 상시·예약, 저장 위치 지정, 문서 파일 2개 이상, 지시에 검증·꼼꼼·교차·대조·검토·분석·보고서·초안·제안서·기획·번역·요약·전체·새로·작성해·만들어가 있으면 쓰지 않는다. 판별이 실패하거나 파일을 찾지 못하면 전체 절차로 간다.
- 파일은 작업 공간 기준 경로, 또는 첨부와 같은 규칙(보관함·다운로드·문서·데스크톱, 숨김·계정 파일 제외)으로 찾는다. 찾은 파일을 업무 폴더 `source/`로 복사하고 직원은 그 사본만 고쳐 새 파일로 저장한다.
- 보고서에 최종 검토 생략과 코드로 대조한 글자·값 차이(추가·삭제)를 적는다. 서식은 비교하지 않는다. 원본의 30%(최소 4곳)를 넘게 지웠으면 빠른 경로를 풀고 최종 검토를 받는다.

### 계정 보호

- 인증 화면에서 보호 조치 문구가 보이면 연결을 `protected`로 두고 멈춘다. 해제 전에는 그 계정으로 브라우저를 띄우지 않는다. 대표가 로그인 창에서 다시 로그인하면 풀린다.
- 등록을 누른 뒤 로그인이 끊기면 다시 로그인하거나 다시 누르지 않고 대표에게 확인을 요청한다.
- 같은 업무의 글·댓글 사이에 간격을 둔다(회사 설정 `postGapSeconds`, 기본 30초, 0~3600). 메일은 별도 20통 제한을 쓴다. 대기 시간은 업무 예산에 세지 않는다.

### 업무 창 재사용

- 같은 연결 계정의 작업은 한 창·한 탭에서 이어 간다. 작업이 끝나도 창을 닫지 않고, 다음 작업 전에 남은 탭을 하나로 줄인다. 창이 닫혔으면 새로 띄우고, 탭만 닫혔으면 같은 창에 새 탭을 연다.
- 로그인 창을 열면 같은 프로필을 쓰는 업무 창을 먼저 닫는다. 업무를 중지하면 창도 닫는다. 서버를 끄면 모두 닫는다. 공개 웹 브라우저는 재사용하지 않고 매번 지운다.

### 공개 웹 브라우저

- `stage.connection`이 예약 값 `public`이면 계정·쿠키 없는 임시 프로필 브라우저를 붙인다(`browsePublic`, `withPublic`). 읽기 전용이고 끝나면 프로필을 지운다. 로그인 내용이 없어 WebSearch·WebFetch도 함께 준다.
- 사내망·로컬 주소는 주소 형식과 DNS로 막는다. 리디렉션 뒤 주소는 화면을 읽기 전에 다시 검사한다. 연결 계정 확인·출처 확인 제외 대상이 아니다.

### 결과 HTML

- 최종 전달물이 md면 같은 이름의 HTML을 함께 저장한다(`lib/md-html.mjs`, AI 호출 없음). 입력의 HTML 태그는 글자로 표시하고 링크는 http·https만 만든다. 이미 같은 이름의 HTML을 전달하면 만들지 않는다.

### 출처 자동 확인

- 최종 검토 전에 단계 산출물의 링크를 AI 호출 없이 연다(`lib/source-check.mjs`). 최대 40개, 동시 6개, 링크당 8초. 결과는 업무 폴더의 `source-check.json`과 검토 프롬프트에 넣는다.
- 404·410·DNS 실패는 열리지 않음, 페이지 제목이 주변 글에 없으면 제목 불일치, 그 밖의 오류·차단은 확인 불가다. 접속 여부와 제목만 보며 본문 수치는 확인하지 않는다.
- 열리지 않음·제목 불일치가 있으면 담당 단계로 한 번만 되돌려 그 항목만 고치게 한다. 제목 없이 참고로 적은 링크도 불일치로 잡힐 수 있어, 담당이 그대로 둘 수 있다. 이후에는 다시 되돌리지 않는다.
- 사내망·로컬 주소는 리디렉션 후 주소까지 검사해 열지 않는다. 로그인 사이트 조회 단계가 있는 업무는 확인 자체를 건너뛴다. 쿠키·계정은 보내지 않는다.

### 회의

- 계획은 대표가 요청한 범위와 결과물만 담는다. 자료 수집·뉴스 찾기는 요청한 건수만 sonnet 이상 실무 직원(없으면 팀장) 한 명의 한 단계로 끝내고, 같은 사건 1건·원문 제목·직접 연 페이지의 수치·부족 사유 표시를 완료 기준에 넣으며, HTML·보고서·재검증 단계는 대표가 요청했거나 외부 제출·재무·법률 자료일 때만 넣는다.
- 한 부서가 끝낼 수 있는 일은 담당이 없어도 회의 없이 배정한다. 여러 부서가 함께 해야 하고 분담을 정하기 어려울 때만 `needsMeeting:true`와 `meetingAgents`(근무중 실행 직원 2~4명)를 낸다.
- 참석자에게 읽기 전용으로 범위·산출물·분담·가정을 받고 meeting.md에 모은 뒤 계획을 다시 받는다. 이벤트는 `meeting.start`/`meeting.end`.

### 단계 실행과 직원 지시

- dependsOn 순서로 진행하고, 준비된 독립 단계는 동시 실행 한도 안에서 함께 돈다.
- 직원 지시 구조(이 순서):
  1. 첫 줄: 단계 제목. 재작업이면 `[반려] `로 시작한다.
  2. `## 목표·대표 요청`: 업무 id, 대표 최초 요청, 추가 지시·결정.
  3. `## 입력·출력·완료 기준`: 입력, 출력, 완료 기준, 반려 사유.
  4. `## 이 단계 안내`: 해당할 때만. 사이트 조회, 메일 문안 JSON, HTML 양식(`org/templates/report.html`), 팀장 취합, 앞 실행 검사 실패.
  5. `## 응답 형식`: 마지막 응답 JSON `status = done | needs_decision | reroute | delegate`와 summary/question/department/agent/reason/assignments(`schemas/stage.json`). 응답 전체가 JSON이 아니어도 설명 문장 앞뒤의 JSON 블록(```json … ``` 또는 `{"status": …}`, 여럿이면 마지막)을 읽는다(`stageResult`).
  6. `## 안전선`: 출력 파일만 쓰기, 외부 작업은 이 단계에서 하지 않음, 비밀값 금지.
- HTML 품질 안내는 HTML 산출물 단계와 HTML 산출물이 있는 검토에만 붙인다.
- 직원 도구는 부서 설정의 도구를 그대로 쓴다. 계정 브라우저는 사이트 조회·외부 작업 단계에만 붙는다.
- 완료 판정: 출력 파일이 있고 비어 있지 않으며 형식 검사(`outputIssues`, HTML은 문서·title·body·viewport·최소 본문)를 통과해야 한다. 실패하면 사유를 붙여 한 번 재시도하고, 그래도 안 되면 업무가 멈춘다.
- 완료 단계는 산출물 해시를 체크포인트에 남긴다. 재개 때 파일이 바뀐 단계와 그 후속 단계만 다시 실행한다.
- needs_decision: 그 단계만 대표 질문으로 기다리고 다른 독립 단계는 계속한다.
- delegate: 팀장만, 단계당 한 번, 같은 부서의 다른 근무중 실행 직원 1~6명에게 분담한다. 분담 산출물은 `<부서>/<직원id>-…`. 하위 단계가 끝나면 팀장 단계가 취합한다.
- replan: 도구·브라우저·권한이 없어 못 한 단계다. 대표에게 묻지 않고 비서실장이 계획을 고쳐(`stage.connection`·공개 웹 단계 분리) 다시 실행한다. 업무당 2회까지이고 그래도 안 되면 대표에게 알린다. 직원이 needs_decision으로 보내도 내용이 도구 문제면 같은 경로로 돌린다. 확인할 수 없는 항목만 남으면 미확인으로 표시하고 done으로 끝낸다.
- reroute: 비서실장이 route JSON으로 다른 근무중 실행 직원을 고른다. 원인 단계와 의존 단계만 무효화한다. 필수 전달 경로·대표 지정 담당을 바꿔야 하면 대표에게 묻는다. 횟수 제한은 없고 업무 예산이 막는다.

### 진행 점검

- 단계 묶음이 끝나고 남은 단계가 있으면 비서실장이 방금 끝난 산출물을 읽기 전용으로 보고 다음 행동을 고른다(`phase: progress`, `schemas/progress.json`).
  - `continue`: 남은 계획대로(기본).
  - `revise`: 단계를 추가·변경·취소한 전체 계획을 `revisedPlan`으로 준다. 계획 검사·경로 정규화를 거치고, 바뀐 단계와 후속 단계만 다시 실행한다.
  - `question`: 대표 결정이 필요할 때만. 답하면 완료 단계를 반복하지 않고 이어 간다.
- 마지막 묶음 뒤에는 점검하지 않는다(최종 검토가 맡음).
- 계획 수정은 업무당 3회, 진행 점검은 12회까지다. 대표 피드백으로 새로 시작하면 다시 센다.
- 완료 단계를 바꾸거나 지우는 수정, 허용되지 않은 외부 작업을 넣는 수정은 버리고 원래 계획대로 간다.
- 수정·거부·건너뜀 이력은 체크포인트 `revisions`(최근 50건)에 남는다.
- 진행 점검이 실패하거나 응답이 깨져도(중지 요청 제외) 남은 계획대로 진행한다.

### 검토 루프

- 검증실 검토: `plan.review.by`가 `codex` 또는 검토 직원 id일 때만, 근무중 Codex review 직원이 읽기 전용으로 검토한다.
  - 검토 기준은 `plan.review.criteria`다. 기술·사실 확인에 집중하고, 첫 줄은 `VERDICT: PASS|FIX|BLOCK`이다. 결과는 `reviews/<직원id>.md`.
  - 요청한 검토 직원이 근무 중이 아니면 비서실장 검토로 진행할지 묻는다.
- 비서실장 최종 검토(`schemas/review.json`): `{verdict, stage, stages:[{id, reason}], reason, report, question, revisedPlan}`.
  - verdict: `pass` | `reject` | `revise` | `block` | `question`.
  - 비서실장은 대표 요청 충족·전달 가능성과 검증실이 다루지 않은 부분을 본다. 검증실이 확인한 항목은 다시 검토하지 않는다.
  - `review-notes.md`가 있으면 추가 검증 근거로 읽는다.
- 통과 조건: verdict pass, 검증실 판정이 모두 PASS, 모든 단계 산출물 해시가 그대로, 외부 작업 형식 오류 없음. 형식 오류가 있으면 반려로 바꾼다.
- 여러 단계 반려: `stages`로 고칠 단계를 한 번에, 단계마다 사유와 함께 반려한다. 각 단계는 자기 사유로, 후속 단계는 합친 사유로 다시 작업한다. 예전 형식(`stage`·`reason`)도 받는다.
- 계획 보완: 기존 단계로 채울 수 없으면 `verdict: revise`와 `revisedPlan`. 진행 점검과 같은 안전선(완료 단계 유지·허용 외부 작업·업무당 수정 3회)을 쓴다. 받을 수 없으면 반려 대상이 함께 있을 때 반려로 진행하고, 없으면 멈춘다.
- 외부 작업(`publications`)과 전문 검토 직원이 없는 업무는 최종 검토 반려·보완을 업무당 1회로 제한한다. 다음 검토는 통과로 처리하고 남은 지적을 보고서의 확인 필요에 적는다. 출처 자동 확인의 되돌리기는 세지 않는다.
- 외부 작업이나 전문 검토가 있는 업무는 횟수를 고정하지 않는다. 검토 지시에 남은 예산·수정 횟수를 알려 주고 비서실장이 정한다.
- 출처 자동 확인은 뒤 단계가 남아 있으면 그 단계 전에 방금 끝난 단계부터 한다. 되돌린 뒤 재작업 중에는 진행 점검을 건너뛴다.
- 같은 계획·완료 상태로 통과한 검토는 서명(`approvedReview`)으로 재사용한다(재개 시 검토를 반복하지 않음).

### 완료와 최종산출물

- 통과하면 외부 작업(5장)을 실행하고, report.md에 외부 작업 결과를 붙인다. 아직 전송 전이므로 검토 보고서는 발송·게시 완료로 쓰지 않는다.
- `collectFinalOutputs`가 최종산출물 폴더에 보고서(`비서실장-보고.md`)와 전달 파일을 모은다.
  - 전달 단계에 title이 있으면 `<제목><확장자>`로 이름을 바꾼다. 폴더 전달은 `<제목>/…`. 같은 이름은 ` (2)`처럼 번호를 붙이고 보고서 링크도 고친다. 파일명 금지 문자는 `-`로 바꾼다.
  - 같은 폴더의 이미지·CSS를 참조하는 HTML은 원래 하위 폴더에 두고 이름만 바꾼다. HTML/CSS가 참조하는 업무 내부 자산도 함께 복사한다.
  - 계획 밖 파일·업무 밖 심볼릭 링크는 거부한다. 묶음 한도 2000파일·100MB.
  - 대표가 전달 폴더의 파일을 고쳤으면 덮어쓰지 않고, 새 결과는 해시를 붙인 이름으로 따로 둔다.
  - 저장에 실패하면 `phase: deliver` 질문으로 멈춘다.
- 그 뒤 `flow.review(pass)` → task status `done`(`completedAt`) → `flow.deliver`. 승인 단계는 없다.
- 중간 자료는 outputs에 남는다.
- 결과 파일 내려받기: 폴더를 찾지 않고 화면에서 바로 받는다(`GET /api/outputs/file?path=…&download=1`, 토큰).
  - 비서실장 대화 창: 대화의 마지막 업무가 `done`이고 진행 중인 실행이 없으면, 마지막 답변 아래 "결과 파일" 칸에 최종산출물(보고서 포함)을 파일마다 `내려받기`, 여러 개면 `모두 내려받기`로 보여 준다. 업무가 끝나기 전에 불러 둔 목록이면 한 번 다시 불러온다.
  - 완료 창과 산출물 탭의 최종 전달 목록: 파일마다 미리보기 버튼 옆에 `내려받기`를 둔다(Word·PowerPoint처럼 미리보기가 없는 형식도 한 번에 받음).
- 대표 피드백: 완료된 업무의 대화에 답장하면 같은 체크포인트로 다시 계획한다. `rerunStages`에 고칠 단계만 넣고 후속 단계는 프로그램이 다시 실행한다. 고칠 단계가 비면 전체를 다시 한다.

### 업무 예산

- 업무 하나가 쓸 수 있는 AI 호출 수와 작업 시간이다. 기본 40회·60분. 회사 설정(`org/company.json`의 `budget`)에서 5~500회·5~1440분으로 바꾼다(`validateTaskBudget`).
- 오케스트레이터가 부르는 AI 호출(계획·회의·단계·진행 점검·재배정·검토·외부 작업)을 하나씩 센다. 작업 시간은 오케스트레이터가 실제로 도는 시간만이고, 대표 답장을 기다린 시간은 뺀다. 체크포인트 `budget`에 남는다.
- 대표 피드백으로 새로 시작하면 다시 센다.
- 80% 확인: 단계 묶음 전·진행 점검 전·최종 검토 전에 본다. 80%를 넘으면 `phase: budget`로 "계속할까요?"를 묻는다. 거절이면 지금까지 결과로 멈추고, 그 밖에는 처음 예산만큼 늘려 이어 간다. 외부 작업 실행 도중에는 끊지 않는다.
- 대표가 없는 업무(예약 실행, 지속 감시가 만든 후속 업무)는 묻지 않는다. 업무(회차)마다 예산을 따로 세고 100%를 쓰면 그 회차만 멈춘다. 감시·예약 자체는 계속된다.
- 구조 규칙은 예산과 별개로 유지한다: 팀장 분담 1회, 회의 2~4명, 계획 수정 3회, 진행 점검 12회.

### 체크포인트와 대표 결정

- 체크포인트 v2(`.office/orchestrations/<rootId>.json`)는 최초 요청과 질문·답변 이력을 가림 처리해 비공개로 보존한다. 공개 상태·이벤트에는 요약만 싣는다.
- 대표 결정 질문의 phase: plan, account, stage, progress, review, budget, web-confirm, mail-more, attachment, publish, deliver.
- 질문하면 업무는 blocked, 실행은 needsReply가 된다. 답장은 같은 계획의 대기 단계부터 이어 간다. 계획 전 질문도 최초 요청을 먼저 저장한다.
- 서버를 다시 시작하면 진행 중이던 업무는 끊김으로 표시하고 "이어서 재개"로 체크포인트를 재사용한다. 승인된 업무의 산출물은 재개로 덮어쓰지 않는다.

## 5. 외부 작업

### 계정 연결

- 제공자: 네이버웍스 메일(`naverworks`), 네이버 블로그·카페(`naver`), 다음·카카오(다음 카페, 티스토리, 브런치, `kakao`), 일반 웹사이트(`web`).
- 일반 웹사이트: 생성 때 `startUrl`과 `hosts`(추가 허용 도메인, 최대 10개)를 받는다. 시작 주소의 도메인은 자동 포함한다. https만, 단 `localhost`·`127.0.0.1`·`[::1]`은 http도 허용한다. 사용자 정보가 든 주소는 거부한다.
- 주소 허용(`connectionAllowsUrl`): 일반 웹사이트는 저장한 도메인과 하위 도메인, https 기본 포트(로컬은 모든 포트)만 연다. 서비스 연결은 서비스별 고정 규칙이다. 브라우저 열기·연결 완료·업무 준비·재로그인 모두 이 검사를 쓴다.
- 제공자별 전용 Playwright persistent Chromium 프로필을 쓴다. 저장된 로그인 상태(IndexedDB·localStorage 포함)를 다음 실행에서 재사용한다. 설치된 Chrome을 우선 쓰고 없으면 Playwright Chromium을 쓴다.
- 로그인 정보는 대표가 고른 것만 로컬 AES-256-GCM으로 저장한다. 인증 파일은 `~/.config/ai-office/private/<작업 공간 경로 해시>/`(0700/0600)에 둔다. 완전한 보안 금고는 아니다.
- 계정 파일 연결: `보관함/계정.env`의 사이트는 `source:'file'`, id `file-<이름 해시>`로 연결 목록에 합친다. 알려진 서비스 도메인이면 그 서비스, 아니면 web이다. 비밀번호는 저장소에 복사하지 않고 쓸 때마다 파일에서 읽는다. 화면에서 로그인 정보 변경·연결 해제를 하지 않는다.
- 네이버 카페 공식 API(`lib/naver-cafe-api.mjs`): 브라우저와 따로 쓰는 게시 도구다. 앱 키는 `보관함/계정.env`의 `NAVER_API_CLIENT`·`NAVER_API_SECRET`·`NAVER_API_CALLBACK`(콜백은 `http://localhost`·`127.0.0.1`만)에서 서버가 읽는다. 키 이름은 계정 항목 접미사(`_URL/_ID/_PASSWORD`)와 겹치지 않는다. 네이버 계정 카드의 "카페 공식 API 연결"이 `POST /api/connections/:id/naver-api`로 동의 주소(`nid.naver.com/oauth2/authorize`, PKCE S256, `auth_type=reprompt`)를 받아 새 창으로 연다. 콜백(`NAVER_API_CALLBACK`의 경로, 토큰 없이 GET)은 10분 안의 한 번 쓰는 state만 받고 결과 화면만 보여 준다. 토큰 교환에는 PKCE와 함께 client_secret을 보낸다(없으면 `invalid_client`, 2026-11-09 실측). 토큰은 저장소 키로 AES-256-GCM 암호화해 `~/.config/ai-office/private/<해시>/naver-api/`에 두고, 만료 1분 전부터 갱신 토큰으로 새로 받는다. 응답·목록에는 연결 여부(`naverApi.connected`)만 싣는다. 카페 글쓰기는 동의 화면의 [선택] 항목이라 사용자가 체크해야 한다. `DELETE`로 해제하고, 계정 연결 해제 때도 지운다.

### 첫 로그인은 대표가 직접

- 로그인 창(`open`)은 비밀번호를 자동 입력하지 않는다. "직접 로그인해 주세요… 로그인을 마치면 이 창은 자동으로 닫힙니다. 창을 직접 닫지 마세요." 안내를 띄운다.
- `watchLogin`이 1.5초마다 보고, 연결 도메인 안에서 로그인 화면이 아닌 상태가 두 번 연속이면 로그인 상태를 저장(`manualLoginAt`, status connected)하고 창을 닫는다. 30분이 지나면 감시를 멈춘다. "연결 완료" 버튼은 대체 수단이다.
- `firstLoginDone`(직접 로그인 기록이 있거나 이미 connected·needs_login이던 계정)일 때만 만료 시 저장 정보·계정 파일로 자동 재로그인한다. 재로그인 입력은 인증 화면(일반 웹사이트는 허용 도메인 안의 비밀번호 화면)에서만 한다.
- 직접 로그인 전의 계정은 업무에서 "처음 한 번은 계정 연결에서 로그인 창을 열어 직접 로그인해 주세요"로 멈춘다.
- 업무 중 로그인이 풀려 직원 창을 넘겨받을 때도 같은 안내와 감시를 붙인다.
- 외부 작업(글·댓글·메일) 중 연결 계정이 `needs_login`이 되면 실행기가 그 로그인 창을 기다렸다가(`requestLogin`, 업무 시작 전 계정 확인과 같음) 로그인을 마치면 같은 작업을 답장 없이 다시 시작한다. 작업마다 한 번이고, 다시 풀리거나 창을 닫으면 `phase: publish`로 묻는다. 예약·상시 업무는 창을 열지 않는다. 등록을 누른 뒤 끊긴 작업은 다시 시작해도 불확실 기록 때문에 멈춘다.
- 전송을 시도한 뒤에는 자동으로 이동·재로그인하지 않는다. CAPTCHA·추가 인증은 대표 결정으로 남긴다. 탐지 우회는 하지 않는다.

### 카페 공식 API 게시

- 대상: `service: naver_cafe`, `action: post`이고 그 연결 계정에 공식 API가 연결돼 있으면 브라우저를 열지 않고 API로 올린다. 단, 본문에 장소(네이버 지도·플레이스) 카드 링크가 있는 글(`hasPlaceCardLink`)은 브라우저로 올린다. 장소 카드는 글 편집기에 링크를 붙여넣을 때만 생기고 API 본문 HTML로는 일반 링크만 남기 때문이다(유튜브 링크는 API도 영상 재생기를 붙이므로 API 그대로). 블로그·댓글·다른 서비스는 브라우저 그대로다. 실행 전 확인·위임·중복/불확실 기록·글 간격은 브라우저 게시와 같다.
- 대상 주소: 게시판 주소(`https://cafe.naver.com/f-e/cafes/<카페>/menus/<게시판>` 또는 `clubid=`·`menuid=`)에서 번호를 읽는다. 전체글보기(0)와 카페 홈 주소는 거부한다.
- 본문: 검토된 원문을 HTML로 바꾼다. 줄바꿈 `<br>`, 링크 `<a>`, 유튜브 링크 아래 `<embed src='https://www.youtube.com/v/<ID>' …>`(iframe은 카페가 지운다), 속성은 모두 작은따옴표, 본문의 따옴표는 문자 참조로 바꾼다(속성 큰따옴표면 403/999). `openyn`·`searchopen`은 true(전체 공개·검색 허용, 기본값은 멤버 공개). 이미지 첨부·수정·삭제·댓글은 API가 없다.
- 실패: 브라우저로 자동 전환하지 않는다. 요청 거부(게시 안 됨, 예: 999)는 기록을 `failed`로 두고 "브라우저로 진행"이라고 답하면 브라우저로 다시 시도한다고 묻는다(`viaBrowser`). 인증 만료·권한 없음, 계정·게시판 제한(`0005`, `CA002`, `AP002`~`AP008`)은 우회를 제안하지 않고 멈춘다. 응답을 못 받거나 코드 없는 5xx는 `uncertain`으로 두고 "미게시 확인, 재게시" 절차를 따른다.
- 보고: 결과 줄은 "공식 API 게시 완료 · <글 주소>"다.
- 계정 확인: 공식 API가 연결된 네이버 계정은 카페 글쓰기(게시 대상별 확인, 지시의 네이버 링크가 모두 카페 주소일 때의 시작 전 확인)에 브라우저 로그인을 요구하지 않는다. API 실패(`code: NAVER_API`)는 게시 중 재로그인·자동 재시작 경로를 타지 않는다. 장소 링크 글은 브라우저로 올리므로, 그때 로그인이 풀려 있으면 게시 중 로그인 창(답장 없이 재시작) 경로를 탄다.

### Aside 직원

- 엔진: 직원 `engine: "aside"` 또는 부서 `engine: "aside"`(`lib/aside.mjs`의 `agentEngine`). Aside CLI가 없으면(`ASIDE_BIN` > PATH > `~/.local/bin/aside`) 부서 엔진(부서가 aside면 Claude)으로 실행하고 브라우저 업무는 기존 Playwright 경로를 탄다. 실행기는 `aside exec --json --timeout 60m <지시문>`으로 띄운다(지시문은 인자, 표준 입력 없음). 결과는 마지막 JSON 줄의 `answer`다. 실패·중지·시간 초과 뒤에는 `aside session list --json`으로 이 실행 뒤 CLI가 시작해 아직 도는 세션을 `aside session stop`한다(CLI를 끝내도 세션은 계속 돈다).
- 지침: 직원 지침은 Aside 전용 근무 규칙으로 만든다(파일을 읽거나 쓰지 않고 결과를 마지막 JSON의 `content`에 담음, 로그인·추가 인증·보호 조치는 입력하지 않고 needs_decision, 숫자는 원문 표기 함께). Claude 직원용 파일·office_browser 규칙은 넣지 않는다.
- 단계: 계획은 Aside 직원의 사이트 조회·외부 작업에 `connection: "aside"`를 쓴다. Aside 직원 단계는 office_browser를 붙이지 않고, 입력 파일 내용을 지시문에 붙이며(파일당 2만 자, 합계 6만 자, 막힌 위치 제외), 응답의 `content`를 실행기가 출력 파일로 저장한다. 공개 웹 조회(`connection: "public"`)와 파일 산출물(xlsx·docx·pptx·pdf·이미지 등)을 Aside 직원에게 배정하면 실행하지 않고 replan으로 계획을 고치게 한다. 공개 웹 조사는 요청 단위 사내 주소 차단이 있는 Playwright 임시 브라우저로만 한다(Aside 기본 프로필에는 대표 로그인이 있다).
- 로그인: Aside 직원이 있으면 시작 전 확인·계정 확인에서 계정 연결 창 대신 Aside 숨은 탭(`aside repl`)으로 대상 주소의 로그인 상태를 본다(로그인 주소·비밀번호 칸·로그아웃 링크·보호 조치 문구, `requiresLogin`·`accountProtected`와 같은 기준). 풀려 있으면 대표가 보는 Aside 창의 현재 탭에 로그인 화면을 열고(맥은 `open -a Aside`) 로그인될 때까지 기다렸다가(`LOGIN_WAIT_MS`) 답장 없이 이어 간다. 보호 조치면 멈춘다.
- 외부 작업(`deliver(engine:"aside")`): 계정 연결 없이 대상 서비스·주소만 검사한다. 실행 전 로그인 확인 → 실행 전 화면(댓글: 같은 문구 수, 메일: 보낸메일함의 같은 제목 메일 id) → 기록 `committing`(method `aside`) → 첨부는 Aside 작업 폴더(`~/.aside/u/0/ai-office/<임의>`)에 복사(에이전트는 기본 권한에서 그 밖 파일을 못 읽음)하고 끝나면 지움 → Aside 직원 실행(검토된 원문을 `<<<본문 … 본문>>>`으로 넣고 정확히 한 번만) → 실행기가 숨은 탭으로 다시 읽어 대조한다. 댓글은 같은 문구가 늘었는지, 글은 직원이 보고한 `resultUrl`(서비스 주소만)의 제목·본문, 메일은 새로 생긴 보낸 메일 상세(`/read/popup?nMailId=`)의 본문·받는사람(보낸사람 주소를 모르므로 받는사람 전원과 다른 주소 하나까지만 인정). 확인되면 `confirmed`(`confirmedBy: aside-readback`), 안 보이면 직원이 누르지 않았다고 보고한 경우(`submitted:false`)만 `prepared`, 그 밖은 `uncertain`으로 멈춘다(자동 재시도 없음). 로그인이 필요하면 `code: ASIDE_LOGIN`으로 알리고 실행기가 Aside 로그인을 기다린 뒤 작업마다 한 번 다시 시작한다. 일반 웹사이트 작업(`web`)은 직원 보고(`completed`·`summary`·`resultUrl`)를 증표로 남기고 미완료는 완료로 닫지 않는다.
- 카페 공식 API와의 순서: Aside 직원의 카페 글도 공식 API가 연결된 네이버 계정이 있으면(계획의 connection이 그 계정이거나, API가 연결된 네이버 계정이 하나뿐일 때) 일반 글은 API로 올린다. 장소 카드 글(`hasPlaceCardLink`)과 "브라우저로 진행"(`viaBrowser`)만 Aside로 올린다(Aside가 아닌 직원은 Playwright). API가 연결된 계정이 없으면 모두 Aside로 올린다.
- 결과 확인 재시도: 실행 뒤 결과 화면 읽기가 실패하거나 아직 안 보이면 짧은 간격(기본 3초)으로 3번까지 다시 읽는다(실행은 다시 하지 않음). 끝내 확인하지 못하면 `uncertain` 기록에 `readbackError`를 남기고, 직원이 보고한 결과 주소와 함께 "올라간 것 확인했어"(확인) 또는 "미발송 확인, 재발송"(재시도)을 안내한다. 화면 대기 조건도 대조와 같은 기준(NFKC, 공백·폭 없는 문자 제거)으로 맞춘다.
- 바뀌는 것: office_browser의 클릭 단위 강제(금지 버튼·허용 주소·칸 종류·조회 단계 쓰기 금지)는 Aside 직원에게는 지시문과 사후 대조로 바뀐다. 실행 직전 확인·중복 방지 기록·불확실 시 정지·검토는 같다.
- 권장 안내(`asideAdvice`): 지난 업무 계획(`.office/orchestrations/*.json`)에서 메일·글·댓글·웹사이트 작업·사이트 조회를 맡았던 근무중 직원 중 Aside가 아닌 직원을 찾아 엔진 변경을 권한다. Aside가 없으면 설치를 권한다. `npm run doctor`(선택 항목 `aside`), 대시보드 상단 배너(`state.asideAdvice`, 30초 재사용), 서버 켜기 수칙(AGENTS.md)에서 같은 문장을 쓴다.

### 사이트 조회 단계

- 계획 단계에 `connection`(일반 웹사이트 연결 id)과 `target`(https 또는 localhost 시작 주소)을 두면 조회 단계다. 일반 단계는 둘 다 빈 문자열이다.
- 실행: `outbound.browse`가 연결 세션을 열고 직원 실행에 브라우저 도구를 붙인다. Claude는 Read·Glob·Grep·Write·Edit와 office_browser 도구만, Codex는 workspace-write를 유지한다.
- 읽기 전용: `browser_submit`·`browser_attach`·`browser_fill_content`를 거부한다. 클릭은 이름이 쓰기 동작 자체인 버튼(저장·등록·수정·삭제·승인 등, `READ_ONLY_BLOCK`)만 막는다. Enter는 검색용으로 허용한다.
- 사이트 밖 차단: 조회 단계는 연결 사이트 안 화면만 본다. 웹 검색·다른 사이트는 쓰지 않는다(로그인 화면 내용 유출 방지). 공개 웹 자료가 필요하면 connection 없는 별도 단계로 나누고 조회 결과를 inputs로 받는다.
- 대표가 조사 범위를 정했으면(특정 회원의 글, 특정 메뉴 등) 그 밖의 화면(공지·규칙·다른 게시판)은 열지 않는다.
- 직원은 의도에 맞는 메뉴·탭·필터를 스스로 찾고, `browser_text`의 offset으로 끝까지 읽고, 결과를 출력 파일에 쓴다. 요구 항목(연락처 등)을 빠뜨리지 않는다. 없으면 확인한 화면·조건을 적는다.
- `CONNECTION_REQUIRED`·`BROWSER_ACTION` 오류는 대표 질문으로 넘긴다.

### 외부 작업 계획(publications)

- `plan.publications[] = {id, action, service, connection, agent, target, recipients, subject, content, instructions, files, attachments}`. 모든 필드가 필수다(예전 계획의 `attachments` 누락은 `[]`로 본다).
- action: `mail` | `post` | `comment` | `web`. 대표가 지시한 동작만 넣는다. "초안만"이면 넣지 않는다.
- mail/post/comment: service는 `naverworks_mail`/`naver_blog`/`naver_cafe`/`daum_cafe`/`tistory`/`brunch`. content는 검토할 본문 단계 id. `instructions:''`, `files:[]`.
  - 메일 대상 주소가 비면 서비스 기본 주소로 채운다.
  - 조사 후 정해지는 메일: 본문 단계가 `{messages:[{recipients, subject, body}], skipped:[사유]}`를 쓴다. 수신자별로 개별 발송한다. 주소를 확인하지 못한 업체는 skipped다.
  - 메일 첨부(`attachments`): 대표가 지시문에 적은 파일 이름·경로를 글자 그대로 적는다(10개 이하, 메일만). 비서실장·직원은 파일을 찾거나 열지 않고, 실행기(`lib/attachments.mjs`)가 찾아 모든 수신자 메일에 같은 파일로 붙인다.
    - 대표 원문 근거: 이름이 최초 지시·답장에 실제로 있어야 한다(`evidenceIn`). 없으면 묻는다.
    - 찾는 곳: 대표가 경로를 적었으면 그 파일(공백 든 경로 포함). 이름만 적었으면 작업 공간(보관함 포함)·`~/Downloads`·`~/Documents`·`~/Desktop`에서 깊이 6·항목 2만 개까지. 숨김 항목·심볼릭 링크·비밀 위치는 들어가지 않는다. 확장자 없이 적으면 확장자를 뺀 이름으로, 한글 이름은 NFC로 맞춘다. macOS 개인정보 보호로 막힌 폴더는 건너뛴다.
    - 차단: `secretLocations`(보관함/계정.env, ~/.config/ai-office/private), 숨김 폴더·파일, `.env`·인증서·키·SSH 키 파일, 50MB 초과(`MAX_ATTACHMENT_BYTES`, 일반 웹사이트 첨부와 같은 공통 상한. 네이버웍스 한도는 회사 관리자 설정이라 고정값을 두지 않음). 대표가 지정해도 첨부하지 않는다.
    - 못 찾거나 같은 이름이 여러 개거나 차단되면 `phase: attachment`로 묻는다. 후보는 경로·크기·수정일과 번호로 보여 주고, 답장의 "N번"(여럿이면 "이름은 N번")이나 전체 경로로 확정한다. 확정한 파일은 체크포인트(`attachmentChoices`)에 남긴다.
    - 계획 직후(조사·작성 전)와 검토 통과 후 발송 전에 확인한다. 실행 전 확인 목록에 `(첨부: 파일명)`을 보여 준다.
  - 여러 게시글: `{posts:[{subject, body, target, kind?}], skipped:[사유]}`. 글마다 따로 게시한다. `posts[].target`은 같은 사이트(https, 같은 origin)의 게시판 주소일 때만 쓰고, 아니면 `publication.target`에 올린다.
  - 영상이 아닌 글(장소·정보 소개 등)은 `kind:"info"`를 적고 유튜브 링크를 넣지 않는다. 링크가 있으면 `kind`와 상관없이 영상 글로 본다. 영상 예약이 아니면 `kind`는 게시에 영향을 주지 않는다.
  - 여러 글의 댓글: `{comments:[{target, body, subject, author}], skipped:[사유]}`(`comments` 대신 `posts`로 적어도 받는다). 글마다 댓글 1건씩 따로 등록한다. `target`은 필수이고 `publication.target`과 같은 사이트여야 한다(https, 모바일 주소 `m.`은 같은 사이트로 본다). 빠졌거나 다른 사이트이거나 같은 글이 두 번 나오면 형식 오류다. `subject`·`author`는 대상 글의 제목·작성자로, 실행 전 확인 목록에 보여 주고 직원이 화면과 대조한다. 형식이 다른 JSON은 원문 그대로 댓글로 올리지 않고 형식 오류로 돌린다. 평문 본문은 지금처럼 `publication.target`에 댓글 1건으로 올린다.
- web: `{service:'web', connection, target, instructions, files:[단계 id]}`. subject·content는 빈 문자열, recipients는 `[]`. 지침 4000자 이하, 첨부 20개 이하(계획 단계 산출물만).
- 단순 게시 업무(글·댓글 하나)는 조사·작성·게시를 같은 직원 한 명에게 맡긴다.
- 형식 검사(`preparePublications`): 본문이 있는지, 메일 수신자 형식, 문안 500개 이하, 게시 후보가 없으면 skipped 사유. 오류는 검토 반려로 처리한다.
- 메일 20통 제한(`MAX_MAILS_PER_RUN`, `splitMailBatch`): 대량 발송을 막기 위해 메일은 수신자 기준 20통까지만 보낸다. 여러 문안·publication을 합쳐 센다. 위임("끝까지 자동으로")이 있어도 같다.
  - 남은 메일이 있으면 앞 20통을 보낸 뒤 `phase: mail-more`로 "남은 메일 발송할까요?"를 묻는다. 질문에는 다음에 보낼 20통의 받는사람·제목을 보여 준다. approve면 20통을 더 허용하고, decline이면 남은 메일을 보고서 "확인 필요"에 "대표 결정으로 보내지 않음"으로 남기고 완료한다.
  - 보낸 메일은 수신자·제목·본문 해시(`mailKey`)로 체크포인트(`mailSent`)에 기억한다. 이어 보낼 때 다시 보내지 않고 앞선 결과 줄만 보고한다. 문안은 다시 만들지 않는다.
  - 예약 실행·지속 감시 업무는 묻지 않고 그 회차에 20통만 보낸다. 남은 메일은 "메일 한도 20통 초과로 이번 회차에 보내지 않음"으로 보고한다.
  - 첫 실행 전 확인(web-confirm)에는 이번에 보낼 20통만 보여 주고 남은 통수를 안내한다.

### 위임과 실행 전 확인

- 위임: 대표 대화 어디든 "끝까지·자동으로·확인 없이·묻지 말고·알아서·전부 맡·위임"이 있으면(또는 AI 판별이 근거와 함께 위임으로 보면) 확인 없이 진행한다.
- 위임이 없으면 검토 통과 뒤 외부 작업을 실행하기 전에 한 번 묶어 확인한다(`phase: web-confirm`). 목록에 종류·계정·받는사람 또는 대상·제목·본문 앞부분·첨부를 보여 준다.
- 예외: 예약 실행·지속 감시가 만든 업무의 메일·글·댓글은 등록이 곧 지시이므로 묻지 않는다. web 작업은 이 경우에도 확인한다.
- 답장 판별이 decline이면 실행하지 않고 보고서에 "대표 결정으로 실행하지 않음"을 남긴다. approve 또는 위임이면 실행한다. 답장 뒤 계획·검토는 재사용한다.
- web만 추정됐고 계획에 외부 작업이 없으면 비서실장 계획을 따른다. 메일·글·댓글이 허용됐는데 계획에 없으면 대표에게 확인한다.

### 브라우저 도구(office_browser)

- 실행별 MCP 서버다. 그 업무의 계정·대상·검토된 원문에 한정한 조회·이동·입력·등록 도구만 준다. 비밀번호·쿠키·임의 JS 실행 도구는 없다. 임시 권한 파일은 업무가 끝나면 지운다.
- Claude 직원은 정본과 같은 직원 지침을 실행별 agent 정의(`--agents`)로 쓰고, `--strict-mcp-config`와 좁은 도구 목록(`--tools`, `--allowedTools`)을 준다. 전역 설정·훅 신뢰는 바꾸지 않는다.
- 입력은 현재 snapshot의 `r숫자` ref만 쓴다.
- 금지 동작(모든 작업): 삭제·탈퇴·로그아웃·결제·송금·이체·비밀번호 버튼.
- 되돌리기 어려운 버튼(발송·발행·게시·등록·작성 완료, web은 업로드·저장·제출·적용·반영·생성·추가 포함)은 `browser_click` 대신 `browser_submit`으로만 누르고 누를 때마다 `committing`을 기록한다. '게시판 선택'은 최종 버튼이 아니다.
- web 작업 전용: `browser_type`(자유 입력, 파일 칸 제외), `browser_attach`(지정 첨부 파일만. 숨긴 파일 칸은 "파일 선택" 버튼 클릭으로 열린 선택 창에 넣고, 5초 안에 창이 없으면 거부). web 작업에서 `browser_fill_content`는 거부한다.
- 첨부를 지정한 메일: `browser_attach`만 추가로 쓴다(지정 파일만, 발송 버튼을 누른 뒤에는 거부). `browser_submit`은 모든 파일을 첨부하고 화면의 첨부 목록에 파일 이름(또는 앞 12자)이 보일 때만 누른다. 실행 직전에 비밀 위치·크기·이름 중복을 다시 확인하고, 첨부 내용 해시를 발송 기록 `contentHash`에 넣는다(첨부 없는 메일의 기록 형식은 그대로).
- `browser_text`: 허용 도메인 프레임(about:blank 편집기 프레임 포함)의 보이는 글자를 40000자씩 `offset`으로 이어 읽는다.
- `browser_scroll`: ref를 주면 그 요소 위에서, 없으면 화면 가운데에서 굴린다(보이는 행만 그리는 표를 끝까지 읽기 위해).
- 주소·프레임·링크·탭은 연결의 허용 도메인으로 검사한다.

### 메일·글 본문 입력과 발송 확인

- `browser_fill_content`는 칸 종류를 확인한다: 본문은 여러 줄 편집기에만, 제목은 한 줄 칸(제목 단서가 있으면 textarea도)에만, 받는사람은 받는사람 단서가 있는 칸에만. 그 밖은 거부한다.
- 서식 편집기는 기본 서명·명함 이미지를 지우지 않고 편집기 루트의 맨 앞에 본문을 넣는다. 서명 표 칸을 골라도 감싸는 편집기 전체의 맨 앞이다.
- 유튜브 영상을 소개하는 글 본문은 본문 → 빈 줄 → 유튜브 링크 순서로 쓴다(영상이 아닌 글은 유튜브 링크 없이). 장소 글의 네이버 지도·플레이스 링크(`naver.me`, `map.naver.com`, `*.place.naver.com` 등)도 같은 순서로 쓴다. 카드 링크(유튜브·네이버 지도)는 글과 나눠 단독으로 붙여넣고 카드가 만들어지기를 기다린다(`bodySegments`). 게시 확인에서는 카드 링크 글자를 뺀다(카드로 바뀌면 보이지 않음). 본문 대조는 공백과 폭 없는 글자(U+200B~U+200D, U+2060)를 빼고 한다. 카페 편집기는 빈 줄을 U+200B만 든 문단으로 저장한다.
- 본문이 이미 편집기에 있으면 다시 넣지 않는다. 다른 화면으로 옮기면 입력 기록을 지운다. 칸 유출은 본문이 실제로 들어간 칸만 본다(화면이 스스로 바꾸는 칸은 무시). 보내기 직전에 본문이 정확히 한 번 있는지 확인해 비었거나 중복이면 막는다.
- 입력 순서: ① 붙여넣기 이벤트(편집기가 링크를 영상·미리보기 카드로 바꾸게. 대표 컴퓨터의 클립보드는 쓰지 않음) → ② 편집기 문서에 직접 삽입 → ③ 초점·커서를 맞춘 뒤 키보드 입력.
- 다른 칸 값이 바뀌면 되돌리고 거부한다. 화면(모든 프레임)에서 본문 앞부분이 확인되지 않으면 입력 완료로 치지 않아 발송 버튼도 누를 수 없다. 두 번째 입력은 하지 않는다.
- 직원에게는 이번 한 건의 받는사람·제목과 본문 앞부분만 주고 본문 파일 경로는 주지 않는다.
- 메일 발송 확인: 완료 문구가 바로 사라지는 화면은 보낸메일함 목록에 제목과 모든 수신자가 보이면 발송 완료로 본다.

### 증표와 중복 방지

- 실제 결과 증표를 `.office/publications/`에 저장한다. 증표 없이 완료로 처리하지 않는다.
- 같은 대화·계정·대상·내용이 이미 confirmed면 다시 실행하지 않는다. post 증표 키에는 publication id를 넣어 같은 게시판에 서로 다른 글을 올릴 수 있다.
- 결과가 불확실하면(`committing`·`uncertain`) 재전송하지 않는다. "미발송 확인, 재발송" 같은 대표 지시가 있어야 다시 시도한다. 대표가 "게시 완료 확인했어", "글은 올라가 있어", "올라간 내용 확인은 했어"처럼 실제 반영을 확인했다고 답하면 같은 내용의 기록만 `confirmedBy: user`로 닫는다("안·못 올라왔어", "올라왔는지 봐줘", 물음표로 끝나는 "올라왔어?", 뒤에서 부정한 "올라가 있지 않아"는 확인이 아님). 확인된 대상의 수정본은 재발송·재게시 지시가 필요하다.
- web 작업의 `browser_finish`는 summary와 completed가 필요하다. 결과 화면 전체 캡처를 업무 폴더 `evidence/`에 저장한다.
  - completed=true: `{status:'confirmed', confirmedBy:'staff-report', resultUrl, summary, evidence}`.
  - completed=false: `status:'incomplete'`. 완료로 닫지 않고 대표 확인을 요청한다. 대표가 이어서 지시하면 다시 시도한다.
- 연결 오류 등으로 멈추면 `phase: publish` 질문으로 남긴다. 재개 때 파일 해시·현재 권한·검토 서명이 유효하면 검토·완료 단계를 다시 하지 않는다.
- 과거 미발송 상태·재발송 금지는 최초 발송의 철회가 아니다. "발송 없음" 같은 열거형 지시는 발송 요청으로 만들지 않는다.

## 6. 안전선

### 안전선 모듈(`lib/guardrails.mjs`)

AI 판단이 넓어져도 모든 경로가 같은 규칙을 거친다. 규칙 표는 `test/guardrails.test.mjs`가 고정한다.

- 금지 동작, 되돌리기 어려운 버튼·최종 확인 버튼 판정, 조회 단계 쓰기 버튼 차단.
- 외부 작업 허용·위임 규칙 판별(`requestedExternalActions`, `externalActionPolicy`), AI 판별 근거 검사(`evidenceIn`).
- 한도: 상시 실행(10초~24시간, 1년), 업무 예산(기본 40회·60분, 5~500회·5~1440분, 80% 확인), 사용량 이상(3배·10회·7일·2일), 계획 수정 3회·진행 점검 12회, CLI 방식 반려 2회.
- 비밀값 위치·언급 패턴(`보관함/계정.env`, `~/.config/ai-office/private`).

제자리에 둔 안전선(데이터·상태와 묶임):

- 허용 도메인: `connections.mjs` `connectionAllowsUrl`.
- 중복 실행 방지: `browser-work.mjs` 실행 원장, `video-history.mjs`.
- 비밀값 차단 훅: `chief-guard.mjs` `decideSecretGuard`.
- 도구 제한: `chief-guard.mjs`, `browser-cli.mjs`.

### 비밀값 차단

- PreToolUse 훅이 직원 포함 모든 에이전트에 대해 `보관함/계정.env`와 `~/.config/ai-office/private`를 가리키는 파일 도구 입력·셸 명령을 거부한다. 직원 공통 근무 규칙에도 금지를 넣는다.
- Codex 직원은 실행 환경상 읽기 자체를 막을 수 없어 지침·권한·검색 제외로 줄인다.

### 프로그램 레포 보호(`decideRepoGuard`)

- 데이터 위치가 프로그램 레포와 다르면 모든 에이전트에 적용한다.
- Write·Edit·MultiEdit·NotebookEdit 대상이 레포 안이면 거부한다(실제 경로 비교).
- Bash·PowerShell은 리다이렉션 대상, rm·mv·touch·tee·sed -i·Set-Content·Remove-Item 등의 인자, cp·ln 등의 대상, `cd`·`git -C` 뒤 git 쓰기, 파일 쓰기 API와 레포 경로가 함께 보이는 인라인 스크립트를 최선 노력으로 거부한다. 한계는 README에 적는다.

### 개인정보·비밀값 기록

- 원문 프롬프트 전체, 도구 입력 전문, 도구 응답은 이벤트에 저장하지 않는다.
- 요청 요약은 남긴다: request 이벤트 summary 200자, runs.json request 120자. 저장 전 redact로 가린다.
- `summary`는 200자 이내, 줄바꿈은 공백. `password|token|secret|api[_-]?key|authorization|cookie` 패턴의 값, JSON 키 값, `Cookie:` 헤더, `--key 값`을 가린다. Bash 명령은 앞 80자만.

## 7. 지속 감시·업무 예약

### 지속 감시

- 의도 판별이 상시 실행(until_stop/duration/deadline)으로 보면 지속 감시로 실행한다. 시간 미지정은 대표가 중지할 때까지다. 기간·종료 시각은 처음 시작 때 절대 시각으로 저장한다.
- 기본 간격 5분, 명시 간격 10초~24시간, 기간·종료 시각 1년 이내.
- 비서실장이 근무중 실행 직원 1명과 조사·새 자료 기준, 후속 전달 절차를 정한다(`phase: watch-plan`).
- 담당 직원이 차례마다 한 번 확인하고 `{cursor, summary, question, items:[{key, title, url, summary, observedAt}]}`를 낸다(`phase: watch`). 무한 반복은 실행기가 맡는다.
- 같은 자료 키는 다시 전달하지 않는다. 새 자료는 `discoveries/<키>.json`에 모으고, 자료 묶음마다 후속 유한 업무를 띄운다. 정상 수집 중에는 동시에 두 묶음까지, 나머지는 보존했다가 수집 종료 때 전역 대기열로 넘긴다.
- 기술 오류는 지연 재시도한다(최대 30분 간격). 대표 결정이 필요하면 알림으로 기다린다.
- 체크포인트 `.office/continuous/<rootId>.json`에 원래 요청·결정·커서·자료 키·후속 업무·종료 시각을 비공개로 둔다.
- 서버 종료는 복구 가능한 일시 중단이다(다음 시작 때 원래 기한으로 재개). 대표 중지는 영구 중지다. 결정 대기는 자동 재개하지 않는다. 결정 대기 중 기한이 지나면 AI 호출 없이 마감한다.
- 감시 실행에 "중지/종료/그만"으로 답하면 감시를 중지한다.
- macOS에서는 감시 중 `caffeinate`로 자동 유휴 잠자기를 막는다. 수동 잠자기·네트워크 중단까지 보장하지 않는다.
- 종료 때 보고서를 쓰고 최종산출물로 모은 뒤 완료한다.

### 상시 업무 하루 사용량

- 실행마다 한국 날짜별 AI 호출 수·토큰을 최근 14일만 남긴다(`run.dailyUsage`, `lib/usage.mjs` `addDailyUsage`).
- 상시 업무 하나의 사용량은 감시 실행, 답장으로 이어진 실행, 감시가 만든 후속 업무를 합친다(`monitorUsage`). 카드에 "오늘 사용: AI 호출·토큰·평소 하루 평균"을 보여 준다.
- 오늘 AI 호출이 최근 7일 중 기록이 있는 날(2일 이상)의 하루 평균보다 3배 이상이고 10회 이상이면 "사용량 이상" 알림(attention `usage`)을 띄운다. 업무는 멈추지 않는다. 멈춘 상시 업무는 알리지 않는다.

### 업무 예약(1회·N회·매일)

- 회사 설정의 "업무 예약 → 예약 설정"에서 관리한다. 상단 "예약"은 바로가기다. 예약 저장은 회사 규칙 저장과 독립이다.
- `lib/schedules.mjs`가 Asia/Seoul 기준 예약을 `.office/schedules.json`에 원자적으로 저장한다. 예약당 시각(`time`)·시작 날짜(`startDate`, 선택)·횟수(`times`, 선택)·마지막 날(`untilDate`)·지시·검토 AI·다음 시각·날짜별 마지막 실행·끝남(`completed`)을 둔다.
  - 1회: `times:1`. 지정 날짜·시각에 한 번 실행하고 끝난다. 지정 시각이 이미 지났으면 등록을 거부한다.
  - N회: 시작일(없으면 다음 그 시각)부터 N일 동안 매일 실행한다. 놓친 날(앱 꺼짐·이전 회차 진행 중·일시중지)도 한 회로 센다. 마지막 날이 지나면 끝난다.
  - 매일: `times` 없음. 예전 예약(시각만 있음)도 그대로 매일 반복이다.
- 지시가 "매일 오전 11시에 …", "내일 오전 10시에 …", "11월 5일 9시에 …", "내일부터 3일간 매일 10시에 …" 형태면 `POST /api/runs`가 `{scheduled:true, schedule}`를 돌려주고 바로 실행하지 않는다. 시각이 업무 내용일 뿐인 문장("내일 10시에 있는 회의 자료 준비")은 예약이 아니다. 모호한 시각·지난 시각은 400. `schedule:false`면 바로 실행한다.
- 예약 실행 지시에는 "지시의 날짜·시각·반복 표현은 예약으로 이미 처리했으니 지금 바로 이번 회차만 처리"하라는 안내를 붙인다.
- 서버가 1초마다 확인한다. 시작 전에 날짜별 시도를 기록해 재시작 후 같은 회차를 다시 돌리지 않는다. 부팅 때 지난 시각과 1분을 넘긴 지연은 건너뛴다(1회 예약이면 끝남). 이전 회차가 running/queued/needsReply면 겹치지 않는다.
- 시각·날짜·횟수를 고치면 회차를 새로 센다(끝난 예약도 다시 켜짐). 단순히 다시 켜면 남은 회차만 이어 가고, 남은 회차가 없으면 거부한다. 중지·삭제는 실행 중 업무를 취소하지 않는다.
- 실행·답장에 `schedule:{id, slot, uniqueYoutube?, minPosts?, maxPosts?, infoPosts?}`를 보존한다.

### 영상 게시 이력

- 유튜브 카페/블로그 예약은 기본 하루 2~3개(지시에서 1~20개로 조정), 영상 1개당 글 1개다. 제외 영상 ID를 업무 폴더 `video-exclusions.json`으로 넘긴다. 후보가 부족하면 실제 개수와 사유로 보고한다.
- 섞인 예약: `videoPostPolicy`는 지시의 개수마다 앞 문구에 영상 단어(유튜브·숏츠·영상 등)가 있는지 본다. 영상 개수와 영상이 아닌 개수가 함께 있으면(예: "유튜브 숏츠 2개와 애견 동반 핫플 1개") 영상 개수를 `minPosts~maxPosts`로, 영상이 아닌 마지막 개수를 `infoPosts`(1~20)로 둔다. 둘 중 하나만 있으면 예전처럼 범위 우선·마지막 개수를 영상 글 수로 본다.
  - 영상이 아닌 글(`kind:"info"`, 링크 없음)은 영상 링크 검사·영상 이력·영상 목표 수에서 빠지고, 한 회차에 `infoPosts`개까지만 올린다. `infoPosts`가 없는 영상 예약에서는 제외하고 사유를 보고한다. 링크가 없는데 `kind:"info"`가 아닌 글은 지금처럼 형식 오류다.
  - 완료 보고에 "영상 게시 N건 / 목표" 뒤로 영상이 아닌 글 수를 따로 적는다.
- `lib/video-history.mjs`가 shorts/watch/공유/임베드 URL의 영상 ID를 뽑는다. 게시했거나 결과가 불명인 영상은 작업 공간 전체에서 다시 쓰지 않는다.
- `browser_submit` 직전에 ID와 예약·날짜별 한도를 동기적으로 기록해 계정 간 동시 게시도 한 번으로 막는다. 실제 클릭 전 실패는 ID를 소비하지 않고, 클릭 뒤에는 확정 전에도 보류한다.
- `.office/video-publications.json`은 영상별 committing/confirmed, 소유 증표, 결과 주소, 예약 날짜별 시도 수를 보관한다. 내역 초기화·예약 삭제·재시작으로 지우지 않는다.

## 8. 일시정지·재개·내역 정리

- 판별(`lib/pause.mjs` 규칙 또는 AI 판별): 지시창에서만 본다.
  - 일시정지: 멈춤 동사 + 이어서/정리/노트북 등 + 작업 범위어가 있고 새 산출물 요청어가 없는 160자 이하 문장, 또는 "일시정지".
  - 재개: "이어서 해줘·재개해줘·하던 작업 계속해" 형태의 40자 이하 문장 전체. "계속 시장을 조사해 줘"는 새 업무다.
  - 해당하면 새 업무·실행을 만들지 않는다.
- 일시정지(`runner.pause`): 단계 실행이 아닌 진행·대기 실행 전체를 멈춘다. 오케스트레이션은 `abort('user-pause')`, 대기열은 취소. `paused:true`이고 `userStopped`는 남기지 않는다. 지속 감시는 `desired:false, status:'paused'`.
- 정리 노트: 업무 폴더 `pause-note.md`. 계획·완료 단계·대표 결정 대기, 감시 조회·발견·보고 수, 파일 목록(40개), 재개 방법. AI를 부르지 않는다. 일시정지 직전에 끝난 업무는 완료 결과를 유지한다.
- 끊김: 서버 종료와 재시작 때 실행 중이던 비단계 실행에 `interrupted:true`. 답장으로 이어가면 지운다.
- 업무 끝내기: 답을 기다리는 업무의 대화에 "이 업무 끝내줘"라고 쓰면 AI 호출 없이 `closed`로 끝낸다. 만든 파일은 남고 내역 초기화로 목록에서 지울 수 있다. 예산 질문에 "그만"이라고 답해도 같다.
- 추가 지시: 지시 판별이 진행 중인 업무에 덧붙이는 말로 보면(`kind: follow_up`, `followUpRun`) 새 업무를 만들지 않고 그 업무에 전달한다. 다음 AI 호출부터 반영되며 이미 실행 중인 단계는 바꾸지 않는다. 판별이 실패하면 진행 중인 업무가 하나이고 "참고로" 같은 말로 시작할 때만 규칙으로 처리한다.
- 내역 지우기: "작업 내역 지워줘" 같은 지시는 새 업무를 만들지 않고 내역 초기화와 같은 동작을 한다(`historyClearIntent`, `kind: clear_history`). 지시창과 대화 창 모두에서 받는다. 최종 산출물·계정·발송 증표, 진행 중이거나 답변을 기다리는 업무는 보존한다.
- 일괄 재개(`runner.resumeAll`): 대화(rootId)별 마지막 비단계 실행 중 paused 또는 interrupted이고 stopped/failed이며 userStopped가 아니고 업무가 done이 아닌 것. 오케스트레이션은 "이어서 재개"로 체크포인트를 재사용한다. 이어갈 대화가 없으면 건너뛰고 사유를 돌려준다. 시작한 지 24시간이 넘은 interrupted 실행은 일시정지하지 않은 한 자동으로 재개하지 않고 사유를 돌려주며, 해당 대화의 답장으로 이어갈 수 있다.
- 응답: `{pauseRequested, paused:[…]}`, `{resumeRequested, resumed:[…], skipped:[{reason}]}`.
- 내역 정리(`DELETE /api/history`): 끝난 대화·로그·체크포인트를 지우고 완료 업무는 `historyArchivedAt`으로 목록에서 뺀다. 진행·결정 대기·재개 예정 감시와 연결된 대화, 최종산출물·원본·계정·발송 증표·산출물 조회용 메타데이터는 보존한다. 이벤트는 cutoff 시각 기준으로 가린다.

## 9. 터미널 비서실장(CLI 방식)

대시보드 실행은 위 오케스트레이터를 쓴다. 작업 공간에서 직접 연 `claude` 세션의 비서실장은 다음 규칙을 따른다.

- 업무 등록: `node scripts/office.mjs task start "<제목>" [--slug x]`가 `outputs/<오늘 KST>/<slug>/brief.md`를 만들고 tasks.json에 등록하고 `OFFICE_TASK=<id>`를 출력한다. 같은 slug면 오류이고, 다른 slug로 다시 등록한다.
- 세션 연결: 그 명령의 단독 실행 출력에서 `OFFICE_TASK=<id>`를 보면 `.office/sessions.json`에 세션 → 업무를 기록한다. 이후 그 세션 이벤트에 `task`가 붙는다.
- 흐름 기록: `office.mjs flow <업무> review-request|review|deliver|cooperate`, `meeting <업무> start|end`, `plan validate <업무>`, `task files <업무>`.
- `flow deliver`는 report.md와 마지막 `flow.review` pass가 있어야 하고, 최종산출물을 모은 뒤 done으로 끝낸다.
- 상태 전이: 비서실장은 active↔blocked만 바꾼다. 대표는 `--by-user`로 그 밖을 바꾼다(`OFFICE_CHIEF_RUN=1`이면 거부).
- 반려 한도: 마지막 deliver·사용자 반려 이후 반려는 최대 2회(`MAX_REVIEW_REJECTS`). 넘으면 남은 문제를 report.md "확인 필요"에 적고 업무를 blocked로 둔다. office.mjs와 chief-guard가 함께 막는다.
- chief-guard(업무 연결 세션의 메인 세션):
  - 직접 실무 금지. 허용: Read/Glob/Grep, Agent, 조율 도구, `node scripts/office.mjs …`·`node scripts/codex-review.mjs …` 단독 실행, 업무 폴더 바로 아래의 brief.md·meeting.md·plan.json·report.md·review-notes.md 쓰기.
  - 셸 연결·리다이렉션·명령 치환·위험한 백슬래시·유니코드 따옴표는 거부한다. org export·import와 task status done·review도 거부한다.
  - Agent 대상은 근무중 Claude 직원만. 내장 에이전트·생략·`run_in_background: true`는 거부한다.
  - 연결 업무가 tasks.json에 없거나 done이면 제한하지 않는다.
- 조직도 주입: SessionStart 훅이 비서실장 수칙 요약과 `buildOrgMap`을 additionalContext로 넣는다(9,500자에서 자름). 직원 세션은 넣지 않는다.
- `.claude/settings.json`의 `permissions.allow`는 office.mjs의 task·flow·meeting·plan 하위 명령과 codex-review.mjs만 Bash·PowerShell 두 형식으로 둔다.
- 비서실장 수칙: 담당이 지시문에 있으면 그대로 따르고, 한 부서가 끝낼 수 있는 일은 회의 없이 배정한다. 여러 부서가 함께 해야 하고 분담을 정하기 어려울 때만 `[회의]` 호출로 2~4명을 모은다. 반려는 `[반려]` 호출로 전달한다. 모든 단계·검토·deliver가 끝나기 전에 최종 답변으로 끝내지 않는다.

### Codex 검토 실행기

```
node scripts/codex-review.mjs --target outputs/<날짜>/<slug> [--reviewers <id·role 목록>|all] [--task <id>] [--model <slug>] [--effort <강도>] [--dry-run]
```

- 검토자마다 `codex exec --json -s read-only -C <작업 공간> -m <모델> -c model_reasoning_effort="<강도>" -`를 동시 3개까지 띄운다. 검토자는 `engine === 'codex'` 부서 직원이다.
- 결과는 `<target>/reviews/<reviewer>.md`. 판정을 못 읽으면 FIX. 종료 코드: BLOCK 2, ERROR 1, 그 밖 0.
- 대상은 실제 경로 기준 `outputs/` 안만 받는다. `POST /api/reviews`도 같은 실행기를 쓴다.

## 10. 대시보드 화면

### 구성

- 상단 바: 로고, 지표 칩(ACTIVE/STANDBY/IDLE/OFFLINE/TASKS/REVIEWS/TOOLS), 시각, 연결 상태, 모드 배지, 계정 연결, 예약, 회사 설정.
- 뷰 탭: 관제 | 사무실 | 조직 | 산출물.
  - 관제: 부서 카드 격자(부서색 테두리, 인원/활동/대기, 진행률, LIVE 목록).
  - 사무실: 캔버스 픽셀아트. 부서마다 방, 대표실, 비서실, 회의실. 작업 중이면 모니터 발광·타이핑·도구명 말풍선, 대기 중 혼잣말. 자동 순찰, 확대·축소·드래그.
  - 조직: 부서 프리셋 그리드, 부서·직원 목록(추가·수정·삭제·근무 전환), 일괄 추가, 회사 설정.
  - 산출물: 최종산출물을 먼저 보여 주고 "전체 업무 자료"로 중간 업무를 본다. 상세의 계획·대화·자료는 접어 둔다. 폴더 열기는 등록된 최종 폴더를 연다.
- 직원 프로필: 이름·직급·부서·담당·근무 상태·최근 활동·실행 결과, 최종 지침 미리보기, 중지·근무 전환·수정·삭제. 작업 지시 버튼은 없다.
- 회사 설정: 회사 공통 규칙, 작업 공간 경로·폴더 열기, 최종산출물 저장 위치(기본 미리보기 `<작업 공간>/보관함/최종산출물`), 업무 예산, 업무 예약, 회사 구성 내보내기·가져오기, 내역 초기화.
- 지시 폼의 설명은 항상 폼 아래에 둔다. 1366·1024·390px에서 넘침 없이 동작한다.
- select는 폼 값을 정본으로 유지하는 DOM combobox/listbox다. 목록은 선택 상자에 붙여 화면 안에 두고, 모달 안 목록은 그 모달에 속한다.

### 실시간 피드와 업무 흐름

- 기본은 업무 언어 피드다. `deriveFlow` 항목을 업무별로 묶어 시간순으로 보인다. 부서색 칩과 from→to 화살표를 단다.
- progress는 실행 인스턴스마다 한 줄로 갱신한다. 묶음마다 최근 6줄, "이전 N건 보기"로 30줄까지.
- "상세 보기"(기본 꺼짐)를 켜면 도구 이벤트를 가린 요약으로 보여 준다.
- 도구 번역: WebSearch "자료 검색", WebFetch "웹페이지 확인", Read/Glob/Grep "자료 확인", Write/Edit "문서 작성", Bash "데이터 처리 중", Skill "양식 사용".
- 업무 카드 단계 표시줄: 요청 → 확인 → 하달 → 진행 → 협조 → 검토 → 사용자 확인 → 완료. 반려가 있으면 되돌아간 화살표와 횟수를 단다.
- 계획 단계 상태: 대기, 진행, 완료, 반려, 완료(산출물 없음).
- 결과에 끝내지 못했다는 표현이 있으면 "작업 종료(확인 필요)"로 쓰고 `warn`을 붙인다.

### 사용자 의견 필요(attention)

- `attention:[{kind, agent, runId?, task?, since, text}]`, since 오름차순.
  - `reply`: 대화마다 needsReply인 마지막 실행. 연결 업무가 review·done이면 뺀다.
  - `complete`: done이고 아직 읽지 않은 업무(`resultSeenAt` 없음).
  - `approve`: review 상태 업무(예전 업무 호환).
  - `gap`: 완료되지 않은 업무의 plan.gaps.
  - `usage`: 상시 업무 사용량 이상.
- 사무실 캐릭터 머리 위에 픽셀 아이콘을 띄운다(튀는 애니메이션, 1/z 크기 보정, 아이콘 클릭 우선). 자동 순찰은 attention이 있는 방으로 먼저 간다.
- 클릭: reply는 대화 창, complete는 결과 모달, gap은 공백 내용과 [조직 탭으로], usage는 그 상시 업무 대화.
- 결과 모달: 새 완료는 다른 대화상자가 없을 때 자동으로 연다. 완료 보고와 최종 파일만 보여 준다. 닫으면 `POST /api/tasks/:id/seen`으로 읽음만 기록한다.
- HTML 결과는 부모가 인증해 읽은 원문을 CSP가 붙은 Blob으로 새 탭에 연다. 인증 값을 URL에 넣지 않는다.
- 지시창에 "승인"만 쓰면 완료 결과를 연다(상태를 바꾸지 않음). 완료된 업무가 없으면 "검토가 끝나면 자동으로 완료됩니다"를 안내한다.
- 페이지 밖 알림: `document.title` 앞에 `(N) 답변 필요` 또는 `(N) 업무 완료`. 브라우저 알림은 기본 꺼짐이고 설정에서 켠다.
- 대화 창: 같은 rootId의 실행을 [요청 요약 → 답변 전문]으로 보인다. 마크다운은 제목·목록·굵게·코드만 해석해 `textContent`로 그린다. 답장 입력은 실행 중·세션 없음·데모에서 비활성이다.

### 회의실 킥오프

- plan.set(없으면 그 업무의 첫 하달·협조)이 트리거다. 참석자는 계획의 모든 담당과 비서실장이다. 업무마다 한 번이다.
- state `meetings:[{task, kind:'kickoff'|'meeting', attendees, since, until?, requested?, waiting?}]`. 킥오프는 8초, 회의실이 쓰이면 대기열로 순서대로 연다. 실제 회의는 meeting.end까지(없으면 30분).
- 비서실장은 상석, 말풍선에 업무 제목. 피드 문구 "비서실장: ○○ 업무 킥오프 — 참석 김팀장, 최대리"(6명 넘으면 "외 N명").
- 협조 연출: 두 부서 담당이 받는 부서 문 안쪽에서 만나 3초간 서류를 넘긴다. 만날 수 없으면 서류만 날아간다.

### 테마

- `neon`(기본, 어두운 남색·네온 관제판)과 `pastel`(파스텔 핑크·라벤더, 레트로 창). 상단 토글, localStorage에 기억한다.

## 11. 이벤트·상태·인터페이스 계약

### 정규화 이벤트(`.office/events.jsonl`, 한 줄에 JSON 하나)

```json
{ "v": 1, "ts": "2026-10-29T05:00:00.000Z", "engine": "claude", "session": "<session_id>",
  "agent": "market-researcher", "instance": "<agent_id 또는 session>", "kind": "tool.start",
  "task": "2026-10-29/competitor-scan", "tool": "WebSearch", "summary": "짧은 설명" }
```

- `agent`는 서브에이전트면 그 id, 메인 세션·오케스트레이터면 `"chief"`다. 사용자 행동(session `office-server`)에는 agent를 붙이지 않는다.
- session이 `office-`로 시작하는 이벤트(office-cli·office-server·office-runner·office-orchestrator-*)는 대화 세션이 아니다.

| kind | 원천 |
|---|---|
| session.start, request, agent.start, agent.stop, tool.start/tool.end, turn.end | Claude 훅(SessionStart, UserPromptSubmit, SubagentStart/Stop, Pre/PostToolUse, Stop). `<task-notification>` 요청은 무시 |
| review.start/review.end(`verdict`) | codex-review, Codex 검토 실행 |
| task.start, task.update | office.mjs, runner |
| flow.review_request, flow.review(`verdict`, `to?`, `target?`, `stage?`), flow.deliver, flow.cooperate(`from`, `to`), flow.user_approve, flow.user_reject, flow.offplan | office.mjs, 오케스트레이터, 서버 |
| meeting.start(`attendees`), meeting.end, plan.set(`plan` 요약) | office.mjs, 오케스트레이터 |
| agent.pause, reply.wait(`run`) | 오케스트레이터, runner |
| monitor.discovered, monitor.deliver, monitor.error | 지속 감시 |

- Agent(Task) tool 이벤트에는 `target`(subagent_type)과 `desc`(120자)를 붙인다.
- 훅은 어떤 오류에도 종료 코드 0, stdout 무출력(chief-guard 거부와 session-context 주입만 예외), 2초 안에 끝낸다. 한 줄씩 `appendFileSync`.

### 업무 흐름 도출(`lib/flow.mjs`)

- `deriveFlow(events, org, {plans?, tasks?})` 항목: `{task, ts, stage, from, to, actor, dept, text, detail?, files?}`.
- `stage`: `request|intake|meeting|kickoff|assign|accept|progress|done|cooperate|review_request|review_pass|review_reject|deliver|user_approve|user_reject|codex_review|reply_wait`.
- `deriveTaskFlows`는 업무별 steps·current·rejects·userRejects·depts·plan·goal·gaps와 `meetings`를 낸다. `scheduleMeetings(meetings, now)`가 회의실 대기열을 적용한다.
- 협조 판정: 계획 단계에 걸리면 그 단계의 앞 단계(dependsOn 전이)에 다른 부서가 있을 때만 협조다. 계획이 없으면 같은 업무에서 다른 부서가 앞서 완료했을 때다.
- `plan.set` 이후 계획 밖 직원 호출은 서버가 `flow.offplan`을 한 번 남긴다.

### 상태(`buildState`)

```
{ metrics:{active,standby,idle,offline,tasks,reviews,tools,needsReply,attention},
  departments:[{...dept, members, activeCount, idleCount, progress, live}],
  agents:{[id]:{status:'working'|'standby'|'idle'|'off-duty', lastEvent, lastTool, lastSummary, runId, queued?}},
  unregistered, tasks, runs, feed(최근 200), flow(최근 300), attention, meetings }
```

- working: 진행 중 실행, agent.start 후 stop 없음, 또는 90초 안의 tool 이벤트.
- `/api/state`는 여기에 presets, schedules(가린 요약), demo, tools(`{claude,codex}.{installed,loggedIn}`), settings, models, mode, connectionStatus, workspace(`{compat, legacyPending}`)를 더한다. 경로 값은 싣지 않는다.

### 실행(run)

- 필드: `id`, 대상, `request`(120자 요약), pid, `status`(queued/running/done/failed/stopped), 시작·종료 시각, `summary`, `sessionId`, `parentId`, `rootId`, `model`, `needsReply`, `task`, `orchestration`, `phase`(자식 실행), `continuous`, `monitorId`, `schedule`, `usage`, `dailyUsage`, `paused`, `interrupted`, `userStopped`.
- 화면·API에는 sessionId 대신 `canReply`만 싣는다.
- 이어서 답하기(`POST /api/runs/:id/reply`): 같은 대화가 실행 중이면 409, 세션 없음 409, 원래 직원 삭제·휴무·엔진 변경 400. claude는 `--resume <sessionId>`, codex는 `codex exec … resume <thread_id> -`. 답변 전문은 `.office/runs/<id>.result.md`.

### 모듈 인터페이스

- `lib/paths.mjs`: `programRoot()`, `resolveWorkspace(opts)` → `{path, source:'env'|'arg'|'local'|'compat'|'default', compat, legacy}`, `kstDate()`, `renameWithRetry(from, to)`(Windows EPERM/EBUSY/EACCES 5회 재시도).
- `lib/cli.mjs`: `findExecutable`, `resolveCommand(name, envVar)`, `spawnCli`(windowsHide, POSIX detached), `writePrompt`, `killTree`, `codexModelArgs`.
- `lib/org.mjs`: `loadOrg`, `loadPresets`, `validateOrg` → `{ok, errors, warnings}`, `saveOrg`(원자적 저장 후 sync), `mutateOrg`(직렬화), `loadCompanyRules`/`saveCompanyRules`, `exportOrg`/`checkOrgImport`/`importOrg`.
- `lib/sync.mjs`: `syncAgents(root, {write})` → `{changed, removed, ok, diffs, conflicts, errors}`, `previewAgentFile`, `resolveAgentModel`.
- `lib/plan.mjs`: `validatePlan(plan, {org, taskId, root, fileExists})` → `{ok, errors, warnings, plan}`, `compactPlan`, `normalizePlanInputs`, `isTaskId`.
- `lib/events.mjs`: `redact`, `redactContext`, `normalizeClaudeHook`, `normalizeCodexItem`, `appendEvent`, `readEvents(file, offset)`, `extractOfficeTask`.
- `dashboard/runner.mjs` `createRunner({root, onChange, maxConcurrent = 4, spawnImpl})`: `start`, `stop`, `stopAll`, `pause`, `resumeAll`, `list`, `startReview`, `reply`, `result`, `latestForTask`, `clearNeedsReply`, `restoreContinuous`, `clearHistory`. 명령 인자는 배열이고 프롬프트는 stdin이다. 오류는 `err.status`(400/404/409)와 한국어 메시지.
- `dashboard/orchestrator.mjs`: `orchestrate({root, run, prompt, execute, signal, maxParallel, resume, onDecision, outbound, intent, judge})`, `checkpointFile`.
- `lib/final-outputs.mjs`: `finalOutputSettings`, `customOutputDirectory`, `collectFinalOutputs`, `resolveFinalOutput`.

### HTTP API (`dashboard/server.mjs`, 기본 127.0.0.1:4777)

| 메서드·경로 | 동작 |
|---|---|
| GET /api/state, /api/stream | 상태 JSON, SSE(`state` 300ms 디바운스, `ping` 15초) |
| GET /api/orgmap | 비서실장 조직도 Markdown(토큰 불필요) |
| POST/PUT/DELETE /api/departments[/:id] | 부서 추가·수정·삭제(직원이 있으면 `?cascade=1` 없이 409) |
| POST/PUT/DELETE /api/agents[/:id], POST /api/agents/:id/duty | 직원 추가·수정·삭제, 근무 전환 |
| GET /api/agents/:id/preview | 생성될 지침 전문(토큰) |
| GET/PUT /api/company | 회사 규칙·설정·작업 공간·최종산출물 위치(토큰) |
| PUT /api/settings | mode·chief·budget 저장 |
| POST /api/runs | 비서실장 지시. `agentId`가 있으면 400 |
| POST /api/uploads | 지시창 파일 올리기 `{name, data(base64)}` → `보관함/업로드/<날짜>/`, 201 `{path, name, size}`(25MB, 허용 형식 밖 415, 너무 큼 413) |
| POST /api/runs/:id/stop, /reply | 중지, 이어서 답하기 |
| GET /api/runs/:id/log, /result | 로그 마지막 64KB, 답변 전문(`X-Result-Source`, `X-Session-Id`)(토큰) |
| POST /api/tasks/:id/seen | 완료 결과 읽음 기록 |
| POST /api/tasks/:id/approve, /reject | review 상태 업무 전용(예전 클라이언트 호환) |
| GET /api/outputs, /api/outputs/:taskId/files, /api/outputs/file?path= | 산출물 목록·파일(토큰, realpath 검사, 미리보기 5MB) |
| POST /api/outputs/:taskId/open, /api/workspace/open | 폴더 열기(셸 없는 open/explorer/xdg-open) |
| POST /api/reviews | codex-review 백그라운드 실행 |
| GET/POST /api/connections, POST /api/connections/:id/open·confirm, PUT·DELETE /api/connections/:id | 계정 연결 |
| GET/POST /api/schedules, PUT·DELETE /api/schedules/:id | 예약(`prompt, time(HH:mm), startDate?(YYYY-MM-DD), times?(1~365), chief?`, 수정에 `enabled`) |
| DELETE /api/history | 내역 정리 |
| GET /api/org/export, POST /api/org/import | 회사 구성 백업·복원(가져오기 8MB) |

- 오류 응답: `{error:"한국어 메시지"}`. 검증 실패 400, 없음 404, 충돌 409. 데모 모드의 변경 요청은 409.
- 상태 변경 API는 `X-Office-Token`(index.html에 주입), 같은 `Origin`, `Content-Type: application/json`을 모두 요구한다. 본문 1MB(가져오기 8MB).
- 루프백이 아닌 `--host`는 시작 때 출력하는 `?key=` 주소로 받은 HttpOnly·SameSite=Strict 쿠키만 허용한다.
- 터미널 지시 넣기(`scripts/office-ask.mjs`, `npm run office:ask`): 프로그램 폴더에서 연 터미널 AI가 대표 대신 `ask`(POST /api/runs), `status`·`wait`(GET /api/state, /api/runs/:id/result), `reply`(POST /api/runs/:id/reply)를 지시창과 같은 API·헤더로 부른다. 접속 정보(주소·토큰·pid)는 루프백 실행 중에만 `<작업 공간>/.office/dashboard-access.json`(0600)에 남기고 close에서 지운다. 실행기가 띄운 모든 AI 프로세스에는 `OFFICE_AI_RUN=1`을 붙이고, 이 표시(또는 `OFFICE_CHIEF_RUN`·`OFFICE_ORCHESTRATOR_CHILD`)가 있으면 명령이 거부한다. 작업 공간 연결 파일(shim)은 만들지 않는다. 지시문 원문 보존 규칙은 `office-request` 스킬에 둔다.
- 정적 html에는 CSP(`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; … frame-ancestors 'none'`)를 붙이고 `X-Frame-Options: DENY`를 둔다. html 미리보기는 토큰으로 읽은 원문을 CSP meta가 든 Blob으로 `sandbox=""` iframe에 띄운다.

## 12. Windows·macOS 공통 동작

Windows 10 이상(PowerShell·CMD 네이티브)과 macOS 13 이상에서 같은 명령으로 동작해야 한다.

- 경로: 항상 `path.join`/`path.resolve`/`fileURLToPath`. 경로 탈출은 `path.relative`가 `..`로 시작하거나 절대 경로인지로 판정한다.
- 원자적 저장: 임시 파일 후 rename. Windows rename 실패는 짧은 백오프로 5회 재시도한다.
- CLI: `claude`·`codex`는 PATH·PATHEXT를 직접 탐색한다. `.cmd`/`.bat` shim은 `shell: true`로 실행한다. 그래서 프롬프트는 항상 stdin으로 넘기고, 명령 인자에는 검증된 토큰만 넣는다.
- `CLAUDE_BIN`/`CODEX_BIN`이 `.js`/`.mjs`면 `process.execPath`로 실행한다(테스트용 가짜 CLI).
- 조직도가 6000자를 넘거나 `.cmd` shim이면 `.office/orgmap.md`(0600)에 쓰고 `--append-system-prompt-file`로 넘긴다.
- 프로세스 종료: POSIX는 프로세스 그룹에 SIGTERM, 5초 뒤 SIGKILL. Windows는 `taskkill /PID <pid> /T /F`.
- 훅 명령은 셸을 거치지 않는 exec 형식이다. 작업 공간의 `.claude/settings.json`에는 프로그램 레포 훅의 절대경로를 args로 넣는다.
- 파일 감시는 `fs.watch`가 실패해도 1초 폴링으로 동작한다. 줄바꿈은 `.gitattributes`로 LF 통일, CRLF가 섞인 JSONL도 읽는다.
- npm 스크립트(`office`/`demo`/`check`/`sync`/`migrate`/`doctor`)는 셸 문법을 쓰지 않는다. `check`는 사용자 작업 공간을 읽지 않는다.
- CI: macOS·Windows·Ubuntu × Node 20·22에서 `npm run check`. 실제 claude/codex는 쓰지 않는다.

## 13. 배포 방식

- 각자 레포를 받아 자기 컴퓨터와 자기 claude·codex 로그인으로 실행한다. 대시보드를 공유하거나 원격 접속하지 않는다.
- 레포에는 프로그램, `org/presets.json`, `org/templates/`만 둔다. 개인 데이터·생성 파일·`.office-local.json`·`.office-migrated-*/`·`보관함/`은 Git에서 제외한다.
- 설치 순서: 받기 → Node 설치 → `npm ci` → claude·codex 설치와 로그인 → `npm run doctor` → `npm run office`.
- `npm run doctor`(`scripts/doctor.mjs [--json] [--port N]`):
  - Node 20 이상, claude·codex 설치·버전·로그인 여부, Windows Git Bash(선택), 포트 4777, 작업 공간 경로·출처를 점검한다.
  - 로그인 여부만 표시하고 인증 정보·이메일은 출력하지 않는다. API 키 환경변수가 있으면 이름만 경고한다.
  - 레포에 예전 데이터가 남아 있으면 `npm run migrate`를 안내한다. 작업 공간과 충돌해 `migrate`가 거부하는 경우에는 대신 `--dry-run` 확인과 프로그램 폴더 밖 보관을 안내한다. 화면 배너와 서버 시작 문구는 이 판단을 doctor에 맡기고 `npm run doctor`를 안내한다.
  - 종료 코드: 필수 항목 실패 1, 그 밖 0, 잘못된 옵션 64.
- 서버 시작 때 실행 파일 존재만 빠르게 확인하고(`tools.*.installed`), 로그인 상태는 비동기로 조회한다. 없는 도구는 상단 배너로 알린다.
- `--demo`는 `.office/demo-events.jsonl`과 시뮬레이터로 연출만 보인다. 데모에서는 실행·답장·변경을 보낼 수 없다.
- 한 사람의 구독을 여러 사람이 함께 쓰지 말고 각자 계정으로 실행한다.

## 결정 기록

날짜별 원문 기록과 결정 이유는 `docs/DECISIONS.md`를 본다.
