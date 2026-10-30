# AI Office 설계 기준

사무 업무를 역할별 AI 에이전트에게 나눠 맡기고, 진행 상황을 로컬 대시보드로 실시간 관제한다.

- **Claude Code:** 실행 조직이다. 메인 세션은 비서실장이고, 약 50명의 역할 서브에이전트를 둔다.
- **Codex:** 기본 비서실장(gpt-6.1-sol/max), 실행 직원 또는 읽기 전용 검토 직원으로 사용한다. 비서실장은 Claude/Codex·모델·effort를 선택할 수 있다.
- **런타임:** 모두 로컬에서 돈다. Node 20 이상의 표준 라이브러리만 쓰고 운영 의존성은 없다. 개발 브라우저 검증에는 Playwright를 쓴다. 서버 호스팅은 필요 없다.

## 사용자 흐름 (최우선 요구사항)

1. **첫 실행:** 화면이 비어 있다. 정본에 부서가 없고, 온보딩 카드가 "첫 부서 만들기"를 안내한다.
2. **부서 추가:**
   - 프리셋에서 고를 수 있다. 영상 레퍼런스의 개발·크리에이티브·마케팅·비즈니스·운영·리뷰·리서치·법무·투자·라이프와 재무·검증실이 들어 있다.
   - 직접 입력도 된다: 이름, 영문 표기, 색, 설명, 엔진(claude/codex), 허용 도구, 기본 모델.
3. **부서 생성:** 생성하면 관제 뷰와 사무실 뷰에 부서 카드와 방이 바로 생긴다.
4. **직원 추가:**
   - 부서 안에서 추가한다. 이름(예: 김대리), 직급(사원/주임/대리/과장/차장/부장/팀장), 담당 업무, 상세 지침, 팀장 여부, 모델을 정한다.
   - 직무 프리셋을 고르면 담당 업무와 지침이 자동으로 채워지고, 수정할 수 있다.
5. **언제든 가능한 조작:**
   - 부서와 직원의 수정·삭제. 삭제는 확인 대화상자를 거친다.
   - 근무 상태 전환(근무중/휴무). 휴무인 직원은 에이전트 파일을 만들지 않아서 비서실장이 부를 수 없다.
   - 작업 지시와 중지(아래 "작업 실행").
6. **저장:** 모든 변경은 서버가 `org/*.json`에 원자적으로 저장하고, 곧바로 sync를 실행해 `.claude/agents`·`.codex/agents`에 반영한다.

## 작업 실행 (대시보드에서 시작·중지)

- **직원에게 작업 지시:**
  - 화면에서 요청 문장을 입력하면 서버가 `claude -p --output-format stream-json --verbose --permission-mode <부서 설정> --agent <id> [--allowedTools <부서 도구>] [--model <별칭>]`을 레포 루트에서 실행하고, 요청 문장은 stdin으로 넣는다(아래 "Windows·macOS 공통 동작").
  - codex 엔진 부서는 `codex-review.mjs`를 거쳐 `codex exec`를 실행한다.
- **비서실장에게 지시:** 직원을 지정하지 않으면 `claude -p`를 메인 세션(비서실장)으로 실행한다. 비서실장은 `office-task` 절차에 따라 업무를 나누고 직원들에게 배정한다.
- **실행 관리:**
  - 서버는 실행 목록(`runs`)을 메모리와 `.office/runs.json`에 둔다. 필드는 `id`, 대상, 요청 요약, pid, 상태(running/done/failed/stopped), 시작·종료 시각, 마지막 출력 요약이다. 이어서 답하기용으로 `sessionId`·`parentId`·`rootId`·`model`·`needsReply`가 붙는다(아래 "이어서 답하기").
  - 중지하면 프로세스 그룹에 SIGTERM을 보내고, 5초 뒤에도 살아 있으면 SIGKILL을 보낸다.
  - 동시 실행은 기본 4개로 제한하고, 넘치면 대기열에 넣는다.
- **화면 반영:** 실행 중인 직원은 사무실 뷰에서 작업 애니메이션이 나온다. Claude 훅 이벤트가 들어오므로 실행 경로와 관계없이 화면은 같은 방식으로 갱신된다. 실행 결과(마지막 답변)는 직원 상세 패널에서 본다.
- **보안:**
  - 기본 바인딩은 127.0.0.1이다.
  - 상태를 바꾸는 API(POST/PUT/DELETE)는 세 가지를 모두 요구한다.
    - 서버 시작 때 만든 임의 토큰을 `X-Office-Token` 헤더로 보낼 것. 토큰은 index.html 응답에 주입한다.
    - `Origin`이 서버 자신일 것.
    - `Content-Type`이 `application/json`일 것.
  - 이렇게 해서 다른 웹사이트가 로컬 서버에 요청을 보내 에이전트를 실행시키는 CSRF를 막는다.
  - 기본 권한 모드는 `acceptEdits`다. `bypassPermissions`는 부서 설정에서 명시해야 하고, 화면에 경고 표시를 붙인다.

## 디렉터리

```
org/departments.json      부서 정본
org/roster.json           에이전트 정본 (Claude 실행 조직 + Codex 검증실)
org/templates/<dept>.md   부서 공통 지침(선택). 생성 시 에이전트 본문 앞에 붙는다
scripts/sync-agents.mjs   정본 → .claude/agents/*.md, .codex/agents/*.toml 생성(--write / --check)
scripts/office.mjs        업무 폴더 관리 CLI (task start|status|list)
scripts/codex-review.mjs  Codex 검증 실행기 (codex exec --json → 리뷰 파일 + 이벤트)
scripts/simulate-events.mjs  데모 이벤트 생성기(.office/demo-events.jsonl 전용)
hooks/office-event.mjs    Claude 훅 입력 → 정규화 이벤트 추가
hooks/chief-guard.mjs     PreToolUse: 업무 중 비서실장의 직접 실무·근무중 아닌 직원 호출 거부(판정은 lib/chief-guard.mjs)
hooks/session-context.mjs SessionStart: 비서실장 세션에 현재 조직도 주입
lib/                      공용 모듈(이벤트 스키마, 정본 로더, 경로)
dashboard/server.mjs      HTTP + SSE 서버 (기본 127.0.0.1:4777)
dashboard/state.mjs       이벤트 → 화면 상태 리듀서(순수 함수)
dashboard/public/         index.html, app.js, styles.css, office.js(픽셀 사무실 캔버스)
test/                     node:test 테스트
.office/                  런타임 데이터(Git 제외): events.jsonl, demo-events.jsonl, tasks.json, sessions.json
outputs/YYYY-MM-DD/<slug>/  업무 산출물(Git 제외)
```

작업 공간 분리(아래 "작업 공간 분리") 뒤로는 `org/` 정본·`.office/`·`outputs/`·생성물이 작업 공간(기본 `~/AIOffice`)에 있다. 위 표의 데이터 경로는 작업 공간 기준이다.

## org/departments.json

```json
[{ "id": "research", "name": "리서치부", "en": "RESEARCH", "color": "#38bdf8",
   "engine": "claude", "tools": ["Read","Write","Edit","Glob","Grep","WebSearch","WebFetch"],
   "model": "sonnet", "summary": "시장·경쟁사·고객 조사" }]
```
- `engine`은 `claude`나 `codex` 중 하나다. `tools`를 생략하면 Claude는 모든 도구를 쓸 수 있다. `model`은 구성원 기본값이다. 팀장의 기본값은 `opus`다(아래 "직원 기본 모델 정책").
- 추가 필드: `active`(bool, 기본 true), `permission`(`acceptEdits`|`bypassPermissions`|`default`, 기본 `acceptEdits`), `order`(정렬 순서), `instructions`(부서 공통 지침), `codexModel`/`codexEffort`(codex 엔진 부서).
- 프리셋으로 부서를 만들 때 id를 주지 않으면 프리셋 id(예: `verify`)를 먼저 쓰고, 이미 있으면 영문 표기로 만든다.
- 저장소에는 이 파일을 두지 않는다(아래 "배포 방식"). 파일이 없으면 빈 배열(`[]`)로 읽는다. 부서 프리셋은 `org/presets.json`에 둔다. 영상의 10개 부서, 재무, 검증실(engine=codex)과 각 부서의 직무 프리셋 4~8개가 들어 있다. 50명 규모는 사용자가 프리셋으로 직접 구성한다.

## org/roster.json

```json
[{ "id": "market-researcher", "name": "시장조사 담당", "department": "research",
   "title": "선임" , "lead": false,
   "specialty": "시장 규모·성장률·세그먼트 추정",
   "description": "시장 규모, 성장률, 세그먼트를 출처와 함께 조사할 때 사용",
   "instructions": "역할별 핵심 지침(2~6문장)" }]
```
- 추가 필드: `active`(bool, 기본 true), `model`(선택, 부서 기본값보다 우선), `rank`(직급 표시, 예: 대리), `role`(선택, 만들 때 고른 직무 프리셋 key). `name`은 사람 이름이고 표시용이다(예: 김대리).
- `id`는 화면에서 이름과 직무를 바탕으로 자동 생성한다(예: `research-kim-1`). 사용자가 수정할 수 있다.
- `id`는 kebab-case이고 전체에서 유일해야 한다. Claude에서는 `agent_type`, Codex에서는 `name`이 된다.
- `title`은 `팀장`, `선임`, `담당` 중 하나다. 부서마다 `lead: true`가 정확히 한 명 있어야 한다. chief 부서는 예외로, 메인 세션이 비서실장이라 정본에는 보조 인원만 둔다.
- 팀장은 서브에이전트라서 다른 에이전트를 직접 부를 수 없다. 팀장의 역할은 부서 산출물을 취합·검토하고 부서 보고서를 쓰는 것이다. 업무 배정은 비서실장(메인 세션)만 한다.

## 생성 규칙 (sync-agents)

- **Claude:** `.claude/agents/<id>.md`에 frontmatter로 `name`, `description`, `tools`(있을 때, 쉼표 구분), `model`을 쓴다. 본문은 공통 머리말(부서·직함·산출물 규칙), 부서 템플릿, `instructions` 순서다.
- **Codex:** `.codex/agents/<id>.toml`은 engine이 `codex`인 부서(프리셋 기준 검증실)의 직원에게 생성하고, 그 직원의 Claude `.md`는 만들지 않는다. 필드는 `name`, `description`, `developer_instructions`다.
- **파일 관리:** 생성 파일 첫머리에 생성 표식을 넣는다. Claude는 frontmatter 다음 줄의 HTML 주석, Codex는 `#` 주석이다. 표식이 있는 파일 중 정본에 없는 것은 삭제하고, 표식이 없는 파일은 손대지 않는다.
- **`--check`:** 변경이 필요하면 종료 코드 1을 반환하고, 무엇이 다른지 출력한다.

## 정규화 이벤트 (.office/events.jsonl, 한 줄에 JSON 하나)

```json
{ "v": 1, "ts": "2026-10-29T05:00:00.000Z", "engine": "claude", "session": "<session_id>",
  "agent": "market-researcher", "instance": "<agent_id 또는 session>", "kind": "tool.start",
  "task": "2026-10-29/competitor-scan", "tool": "WebSearch", "summary": "짧은 설명" }
```

`agent`는 서브에이전트면 그 `agent_type`이고, 메인 세션이면 `"chief"`다. `kind`의 종류:

| kind | Claude 훅 원천 | 비고 |
|---|---|---|
| session.start | SessionStart | |
| request | UserPromptSubmit | 프롬프트가 `<task-notification>`으로 시작하면 무시한다 |
| agent.start | SubagentStart | |
| agent.stop | SubagentStop | summary는 last_assistant_message 앞부분 |
| tool.start / tool.end | PreToolUse / PostToolUse | tool_name이 Agent면 summary에 subagent_type과 description |
| turn.end | Stop | |
| review.start / review.end | codex-review.mjs | review.end에 `verdict`(PASS/FIX/BLOCK) |
| task.start / task.update | office.mjs | |

**개인정보·비밀값:**
- 원문 프롬프트, 도구 입력 전문, 도구 응답은 저장하지 않는다.
- `summary`는 200자 이내로 자른다. 줄바꿈은 공백으로 바꾸고, `password|token|secret|api[_-]?key|authorization|cookie` 패턴이 보이면 그 값을 가린다.
- Bash 명령은 앞 80자만 남긴다.

**훅 처리 원칙:**
- 훅은 어떤 오류에서도 종료 코드 0으로 끝내고, stdout에 아무것도 쓰지 않는다. 쓰면 Claude 컨텍스트에 섞인다.
- 2초 안에 끝내야 한다.
- 파일 추가는 `appendFileSync`로 한 번에 한 줄씩 한다.

## 업무(task)와 세션 연결

- `node scripts/office.mjs task start "<제목>" [--slug x]`를 실행하면 다음이 일어난다.
  - `outputs/<오늘 KST>/<slug>/brief.md`를 만든다.
  - `.office/tasks.json`에 업무를 등록한다. 필드는 `{id, title, status:"active", created}`이고, id는 `<날짜>/<slug>`다.
  - `task.start` 이벤트를 기록하고, stdout 마지막 줄에 `OFFICE_TASK=<id>`를 출력한다.
- 훅이 PostToolUse(Bash·PowerShell)의 응답 stdout에서 `OFFICE_TASK=<id>`를 발견하면 `.office/sessions.json`에 `{session: id}`를 기록한다. 이후 그 세션에서 나오는 모든 이벤트(서브에이전트 포함)에 `task`가 붙는다.
  - 연결 조건(리뷰 반영): 그 도구 호출의 `tool_input.command`가 `node scripts/office.mjs task start …` 단독 실행(chief-guard와 같은 토큰 분리·실제 경로 검사)이고, id가 업무 id 형식(`isTaskId`)이며 tasks.json에 등록돼 있을 때만 연결한다. 테스트 파일을 cat·grep한 출력에 `OFFICE_TASK=`가 보여도 일반 세션이 업무에 연결(→ 가드에 잠김)되지 않게 하려는 것이다.
- `office.mjs task status <id> blocked|active`로 상태를 바꾼다(전이 규칙은 아래 "리뷰 반영: 업무 흐름·오케스트레이션"). 화면에서는 산출물 폴더에 `report.md`와 `reviews/*.md`가 있는지도 함께 보여준다.

## Codex 검증 (codex-review.mjs)

```
node scripts/codex-review.mjs --target outputs/<날짜>/<slug> [--reviewers fact-checker,number-auditor|all] [--task <id>] [--model <slug>] [--effort <강도>] [--dry-run]
```

- **실행:** 검토자마다 `codex exec --json -s read-only -C <repo> -m <모델> -c model_reasoning_effort="<강도>" -`를 별도 프로세스로 동시에 띄우고 프롬프트는 stdin으로 넣는다. 기본 동시 실행은 3개다.
- **프롬프트:** 정본의 instructions, 공통 검토 기준, 대상 경로로 구성한다. 첫 줄에 `VERDICT: PASS|FIX|BLOCK`을 쓰게 하고, 그 아래에 근거(파일:위치)를 쓴 Markdown 지적 목록을 받는다.
- **이벤트:** JSON 스트림의 `item.started`/`item.completed`(command_execution 등)를 tool.start/tool.end로 바꾼다. 이때 `engine: "codex"`, agent는 검토자 id다.
- **결과:** 마지막 agent_message를 `<target>/reviews/<reviewer>.md`에 저장한다. 판정을 파싱하지 못하면 FIX로 간주한다. 종합 결과는 stdout에 출력하고, 하나라도 BLOCK이면 종료 코드 2, BLOCK 없이 ERROR가 있으면 1, 그 밖에는 0을 반환한다.
- **실패 처리:** `codex`가 없거나 실패하면 review.end에 verdict `ERROR`와 이유를 남긴다.
- **시험 실행:** `--dry-run`을 주면 codex를 실행하지 않고 프롬프트만 출력한다(테스트용).

## 대시보드

- **서버:**
  - `npm run office`로 띄우며 기본 주소는 127.0.0.1:4777이다. `--port`와 `--host`를 지원하고, 외부 노출은 사용자가 명시할 때만 한다.
  - `GET /api/state`는 현재 상태 JSON을 돌려준다. `GET /api/stream`은 SSE로, 상태 스냅샷과 새 이벤트를 전송한다. 정적 파일은 `dashboard/public`에서 제공한다.
  - events.jsonl은 tail 방식으로 증분만 읽는다.
  - `--demo`를 주면 demo-events.jsonl을 읽고 화면에 "DEMO" 배지를 표시한다. 시뮬레이터는 서버가 함께 실행한다. 데모 데이터는 실제 이벤트 파일에 쓰지 않는다.
- **상태 리듀서(state.mjs):**
  - 입력: roster, departments, 이벤트 배열, 현재 시각.
  - 출력: 지표(ACTIVE: 최근 90초 안에 활동했거나 agent.start 후 stop이 없는 인원 / IDLE / OFFLINE: 오늘 활동 없음 / TASKS / REVIEWS / TOOLS: 오늘 도구 호출 수), 부서별 인원·활동 인원·진행률, 에이전트별 상태와 마지막 활동, 업무 목록, 최근 이벤트 200개.
  - 정본에 없는 agent도 "미등록"으로 표시하고 버리지 않는다.
- **화면** (영상 레퍼런스: 어두운 남색 배경, 네온 강조, 정보 밀도 높은 관제판):
  1. 상단 바: AGENT HQ 로고, 지표 칩(ACTIVE/STANDBY/IDLE/OFFLINE/TASKS/REVIEWS/TOOLS), 현재 시각, 연결 상태.
  2. 관제 뷰: 부서 카드 격자. 카드마다 부서색 테두리, 인원/활동/대기 수, 진행률 막대, 지금 일하는 인원 목록(LIVE)이 들어간다.
  3. 사무실 뷰: 캔버스에 그린 픽셀아트 사무실.
     - 부서마다 방이 있고, 인원마다 책상·모니터·픽셀 캐릭터가 있다. 캐릭터는 외부 이미지 없이 코드로 그린다.
     - 작업 중이면 모니터가 빛나고 타이핑 애니메이션과 도구명 말풍선이 나온다. 대기 중이면 정지, 오프라인이면 흐리게 표시한다.
     - 이름표를 단다. "자동 순찰"을 켜면 활동 중인 부서로 카메라가 천천히 이동한다. 확대·축소·드래그를 지원한다.
  4. 우측 패널: 실시간 이벤트 피드, 업무 목록(상태·보고서·리뷰 판정).
  5. 뷰 전환 탭, 다크 기본, 1280px 이상 데스크톱 우선. 모바일 폭에서도 깨지지 않게 한다.

## 화면 테마와 연출 (레퍼런스 2종)

- **테마:** 두 가지를 넣고 상단 토글로 바꾼다. 선택은 localStorage에 기억한다.
  - `neon`(기본): 영상 레퍼런스. 어두운 남색에 네온 강조, 관제판 느낌.
  - `pastel`: 갓생맘 AI Office 레퍼런스. 파스텔 핑크·라벤더, 레트로 창 프레임, 픽셀 폰트 느낌.
  - 레퍼런스 코드는 복사하지 않고 연출만 참고한다.
- **사무실 뷰 연출:**
  - 부서 방들 옆에 대표실(사용자 본인 = 대표)과 회의실을 둔다.
  - 직원이 작업을 시작하면 자기 책상으로 걸어가 앉는다. 걷기는 간단한 보간 이동이면 된다.
  - 작업이 끝나면 대표실로 "보고"하러 가는 짧은 연출 뒤 자리로 돌아온다.
  - 리뷰가 진행 중이면 검증실이나 회의실에 모인다.
  - 직원을 클릭하면 프로필 패널이 열린다: 이름·직급·부서·담당·근무 상태·최근 활동·실행 결과, 그리고 작업 지시·중지·수정·삭제 버튼.
- **혼잣말 말풍선:** 직원 정본의 선택 필드 `thoughts`(문자열 2~3개)를 쓴다. 대기 중일 때 가끔 표시한다. 작업 중에는 실제 도구명이나 요약을 보여준다.
- **부서 수:** 제한이 없다. 방 배치는 부서 수에 맞춰 격자로 자동 배치한다. 방 크기는 인원수에 맞춰 늘어난다.

## 모듈 인터페이스 (구현 간 계약)

모든 모듈은 ESM(`.mjs`)이다. `root`는 레포 루트의 절대경로다.

### lib/paths.mjs
`programRoot()`(프로그램 레포, 파일 위치 기준. 예전 이름 `repoRoot`는 같은 값), `resolveWorkspace(opts)`·`workspaceRoot()`(데이터 위치, 아래 "작업 공간 분리 구현 계약"), `officeDir(root)`(`.office`가 없으면 만든다), `outputsDir(root)`, `kstDate(d = new Date())`는 `YYYY-MM-DD`를 반환한다. `renameWithRetry(from, to)`는 Windows rename 실패(EPERM/EBUSY/EACCES)를 짧은 백오프로 최대 5회 재시도한다.

### lib/cli.mjs
- `findExecutable(name)`: PATH와 PATHEXT를 직접 탐색해 절대경로를 반환한다(없으면 null).
- `resolveCommand(name, envVar)`: `CLAUDE_BIN`/`CODEX_BIN` 대체(`.js`/`.mjs`면 `process.execPath`로 실행)를 반영해 `{command, prefixArgs, shell, display}`를 반환한다. Windows `.cmd`/`.bat`이면 `shell: true`.
- `spawnCli(resolved, args, {cwd, spawnImpl})`: `windowsHide: true`, POSIX는 `detached: true`. `writePrompt(child, text)`로 stdin에 프롬프트를 넣는다.
- `killTree(child, signal)`: POSIX는 `-pid` 그룹 신호, Windows는 `taskkill /PID <pid> /T /F`.
- `codexModelArgs({model, effort})`: `-m <모델> -c model_reasoning_effort="<강도>"`. 환경변수 > 명시값 > 기본값(`gpt-6.1-sol`/`max`), 형식 검증 실패 시 예외.

### lib/org.mjs
- `loadOrg(root)`는 `{departments, roster}`를 반환한다. 파일이 없으면 빈 배열이다.
- `loadPresets(root)`는 `{departments:[{...부서필드, roles:[{key,name?,specialty,description,instructions,thoughts,lead?}]}]}`를 반환한다.
- `validateOrg(org)`는 `{ok, errors:[string]}`를 반환한다. 검사 항목:
  - id 형식 `^[a-z][a-z0-9-]{1,47}$`, 전체 id 유일
  - 직원의 department가 존재
  - 부서당 lead는 1명 이하
  - engine은 claude 또는 codex
  - permission 값의 허용 여부
  - 문자열 길이 제한: name 40자, instructions 4000자
- `saveOrg(root, org)`는 검증에 실패하면 예외를 던진다. 저장은 임시 파일을 쓰고 rename하는 원자적 방식이다. 저장 후 `syncAgents(root, {write:true})`를 호출하고, 그 결과를 반환한다.
- `mutateOrg(root, fn)`은 load → fn(org) → save를 직렬화해 실행한다(프로세스 내 큐). 반환은 `{org, sync, result}`(result는 fn의 반환값)이고, saveOrg 예외에는 `err.errors`(문자열 배열)가 붙는다.
- `loadCompanyRules(root)`/`saveCompanyRules(root, rules)`: `org/company.md` 읽기·원자적 저장(8000자 제한) 후 sync.
- 검증 추가 항목: 부서·직원 `model`은 `haiku|sonnet|opus|inherit`(또는 `claude-…` 전체 id), `codexModel`은 slug 정규식, `codexEffort`는 허용 목록, `tools`는 도구 이름 정규식.
- `slugifyId(base, existingIds)`는 한글 이름도 처리한다. 로마자 변환 없이 부서 id와 순번을 쓴다. 예: `research-3`.

### lib/sync.mjs (scripts/sync-agents.mjs가 감싼다)
`syncAgents(root, {write})`는 `{changed:[path], removed:[path], ok}`(추가로 `diffs`, `conflicts`, `errors`)를 반환한다. 경로는 레포 기준 상대경로다. 생성 규칙은 위 "생성 규칙"과 같다. `active:false`인 부서·직원은 파일을 만들지 않는다.
`previewAgentFile(root, agentId, org?)`는 휴무 여부와 관계없이 생성될 파일 `{path, content, engine}`을 반환한다(없으면 null). `resolveAgentModel(agent, dept)`는 직원 model > (팀장이면 opus) > 부서 model > sonnet.

### lib/events.mjs
- `redact(text, max = 200)`
- `normalizeClaudeHook(input, {sessionsMap})`는 정규화 이벤트를 반환한다. 무시할 입력이면 null이다.
- `normalizeCodexItem(jsonLine, {agent, task, session})`는 이벤트 또는 null을 반환한다.
- `appendEvent(root, ev, {file = 'events.jsonl'})`
- `readEvents(file, fromOffset = 0)`는 `{events, offset}`를 반환한다. 잘린 마지막 줄은 다음 호출로 넘긴다.
- `extractOfficeTask(stdoutText)`는 task id 또는 null을 반환한다.

### dashboard/runner.mjs
- `createRunner({root, onChange, maxConcurrent = 4, spawnImpl = child_process.spawn})`가 반환하는 객체:
  - `start({agentId | null, prompt, model?})`는 run을 반환한다. agentId가 null이면 비서실장이다. model은 `haiku|sonnet|opus` 허용 목록으로 검증한다.
  - `stop(runId)`
  - `list()`
  - `startReview({target, reviewers, task})`: codex-review.mjs를 백그라운드로 실행하고 runs에 engine `codex`, target `review`로 등록한다(종료 코드 2는 done).
  - `reply(runId, {prompt, model?})`: 끝난 실행의 세션을 이어서 새 run을 만든다(아래 "이어서 답하기").
  - `result(runId)`: `{text, source:'file'|'summary', engine, sessionId}`. 답변 전문 파일이 없으면 요약을 준다.
- **명령 인자:** 배열로 전달하고 셸을 쓰지 않는다(Windows `.cmd` shim만 예외). prompt는 명령 인자가 아니라 stdin으로 넣는다. 오류는 `err.status`(400/404/409)와 한국어 메시지로 던진다.
- **사전 검사:** agentId는 org에 있는지 확인한다. 휴무 상태면 거부한다.
- **출력 처리:** stream-json 출력의 마지막 result 요약을 run에 저장한다. stdout 원문은 `.office/runs/<id>.log`에 남긴다.
- **테스트:** spawnImpl을 주입할 수 있어서 실제 CLI 없이 테스트한다.

### dashboard/state.mjs
`buildState({org, events, runs, tasks, now})`는 화면 상태를 반환한다. 순수 함수다.

반환 구조:
```
{ metrics:{active,standby,idle,offline,tasks,reviews,tools,needsReply},
  departments:[{...dept, members, activeCount, idleCount, progress, live:[agentId]}],
  agents:{[id]:{status:'working'|'standby'|'idle'|'offline'|'off-duty', lastEvent, lastTool, lastSummary, runId}},
  unregistered:[agent], tasks:[...], runs:[...], feed:[최근 200개] }
```
- **working:** 진행 중인 run이 있거나, agent.start 후 stop이 없거나, 90초 안에 tool 이벤트가 있음
- **standby:** 오늘 활동이 있고 지금은 쉬는 중
- **idle:** 근무중이지만 오늘 활동 없음
- **off-duty:** active가 false
- **offline:** 사용하지 않는다(호환용)

### HTTP API (dashboard/server.mjs)

| 메서드·경로 | 동작 |
|---|---|
| GET /api/state | buildState 결과 + `{presets}` |
| GET /api/stream | SSE: `event: state`(변경 시 300ms 디바운스로 전체 상태), `event: ping`(15초) |
| POST /api/departments | body는 부서 필드. id가 없으면 자동 생성. 201 + 부서 |
| PUT /api/departments/:id | 부분 수정(id 변경 불가) |
| DELETE /api/departments/:id?cascade=1 | 소속 직원이 있으면 cascade 없이 409 |
| POST /api/agents | body는 직원 필드. `preset`(직무 key)으로 기본값(model 포함)을 채울 수 있음. 응답에 `warnings`가 붙을 수 있음 |
| PUT /api/agents/:id | 부분 수정. `null`·빈 문자열 값은 그 필드를 지운다(부서 PUT도 같음) |
| DELETE /api/agents/:id | 삭제 |
| POST /api/agents/:id/duty | `{active:bool}`로 근무 상태 전환 |
| POST /api/runs | `{agentId?, prompt, model?}` 202 + run |
| POST /api/runs/:id/stop | 실행 중지 |
| POST /api/runs/:id/reply | `{prompt, model?}` 202 + 새 run. 실행 중·대기·세션 없음 409, 원래 직원 삭제·휴무·엔진 변경 400, 데모 409 |
| GET /api/runs/:id/log | 마지막 64KB 텍스트 |
| GET /api/runs/:id/result | 답변 전문 텍스트(토큰 필요). 파일이 없으면 summary. 헤더 `X-Result-Source: file|summary`, 세션이 있으면 `X-Session-Id` |
| POST /api/reviews | `{target, reviewers}`로 codex-review.mjs를 백그라운드 실행. runs에 engine codex로 등록 |

- **오류 응답:** `{error:"사람이 읽을 수 있는 한국어 메시지"}`. 검증 실패는 400, 없음은 404, 충돌은 409.
- **상태 변경 API:** 위 "보안"의 토큰·Origin·Content-Type 검사를 통과해야 한다. body는 1MB 제한이다(회사 구성 가져오기 `POST /api/org/import`만 8MB).
- **정적 파일:** 경로 정규화 후 `dashboard/public` 밖으로 나가는 요청은 거부한다.

## Windows·macOS 공통 동작 (필수 요구사항)

Windows 10 이상(PowerShell·CMD, 네이티브. Git for Windows는 선택)과 macOS 13 이상에서 같은 명령으로 동작해야 한다. Linux는 덤이다.

- **경로:**
  - 항상 `path.join`/`path.resolve`/`fileURLToPath`를 쓴다. `/`를 이어 붙이거나 `new URL(...).pathname`을 그대로 쓰지 않는다. Windows에서 `/C:/...`가 되기 때문이다.
  - 경로 탈출 검사는 `path.relative` 결과가 `..`로 시작하는지, 또는 `path.isAbsolute`인지로 판정한다.
- **원자적 저장:** Windows에서는 rename이 EPERM이나 EBUSY로 실패할 수 있다. 이 경우 짧은 백오프로 최대 5회 재시도한다.
- **CLI 실행:**
  - `claude`·`codex`는 PATH와 PATHEXT를 직접 탐색해서 찾는다.
    - Windows에서 `.exe`면 바로 spawn한다.
    - `.cmd`/`.bat`(npm 전역 설치 shim)이면 Node 20.12 이상이 셸 없이 실행하기를 거부한다. 이때는 `shell: true`로 실행한다.
  - 이를 위해 **프롬프트는 명령 인자가 아니라 stdin으로 전달한다.**
    - claude: `claude -p ...옵션`에 stdin으로 프롬프트를 넣는다.
    - codex: `codex exec ...옵션 -`에 stdin으로 프롬프트를 넣는다.
    - 명령 인자에는 검증된 토큰만 넣는다: 직원 id 정규식, 정본에서 온 도구 이름(`^[A-Za-z0-9_*().:-]+$`), 고정 옵션.
  - 환경변수 대체: `CLAUDE_BIN`/`CODEX_BIN` 값이 `.js`/`.mjs`로 끝나면 `process.execPath`로 그 스크립트를 실행한다. 테스트용 가짜 바이너리를 두 OS에서 같은 방식으로 쓰기 위해서다.
- **프로세스 종료:**
  - POSIX는 detached 프로세스 그룹에 `-pid`로 SIGTERM을 보내고, 5초 뒤 SIGKILL을 보낸다.
  - Windows는 `taskkill /PID <pid> /T /F`를 쓴다. 이때 spawn은 `windowsHide: true`로 한다.
- **훅 명령:**
  - `.claude/settings.json`은 셸을 거치지 않는 exec 형식으로 둔다: `{"type":"command","command":"node","args":["${CLAUDE_PROJECT_DIR}/hooks/office-event.mjs"]}`.
    - 이유(공식 문서 확인, 2026-10-29): Windows 네이티브에서 셸 형식 훅은 Git Bash가 있으면 Git Bash, 없으면 PowerShell로 실행된다. PowerShell에서 `$CLAUDE_PROJECT_DIR`은 펼쳐지지 않는다. `${CLAUDE_PROJECT_DIR}` 자리표시자는 Claude Code가 직접 치환하므로 exec 형식이 두 OS에서 같게 동작한다. macOS(Claude Code 2.1.312)에서 실제 발화를 확인했다.
  - 훅 스크립트는 `process.env.CLAUDE_PROJECT_DIR`(그 아래 hooks/office-event.mjs가 있을 때), 없으면 자기 파일 위치로 레포 루트를 찾는다. 공용 모듈은 동적 import해서 로드 실패도 종료 코드 0으로 끝낸다.
- **기타 동작:**
  - 파일 감시는 `fs.watch`가 실패하거나 누락돼도 1초 폴링 백업으로 동작한다.
  - 줄바꿈은 `.gitattributes`에서 `* text=auto eol=lf`로 통일한다. 테스트에서 CRLF가 섞인 JSONL도 파싱돼야 한다.
- **npm 스크립트:** `npm run office`/`demo`/`check`가 PowerShell·CMD에서도 같게 동작해야 한다. 그래서 셸 문법(`&&` 연결, 환경변수 인라인 지정, `rm`)을 쓰지 않는다. `check`는 `node scripts/check.mjs`(test/*.test.mjs를 파일 목록으로 `node --test`)다. 작업 공간 분리 뒤로는 사용자 작업 공간을 읽지 않도록 sync --check를 하지 않는다(작업 공간 점검은 `npm run sync -- --check`).
  - Node 22 이상은 `node --test test/`의 폴더 인자를 펼치지 않고 모듈 경로로 해석한다. 호환을 위해 `test/package.json`의 `main`을 `test/run-all.mjs`로 두고, 폴더로 실행됐을 때만 각 테스트 파일을 별도 프로세스로 돌린다.
- **CI:** `.github/workflows/ci.yml`을 둔다.
  - 행렬: `macos-latest`, `windows-latest`, `ubuntu-latest` × Node 20·22
  - 실행: `npm run check`
  - 실제 claude/codex는 실행하지 않고 가짜 바이너리만 쓴다.
- **문서:** README에 OS별 준비(Node 설치, claude·codex 설치와 로그인 명령, Windows의 Git for Windows 선택 사항)를 적는다.

## 직원 기본 모델 정책 (사용자 확정)

모델은 별칭(`haiku`/`sonnet`/`opus`/`inherit`)으로 지정한다. 현재 별칭은 각각 Haiku 5.5, Sonnet 5.5, Opus 5.5로 해석된다.

| 업무 유형 | 기본 모델 | 적용 |
|---|---|---|
| 웹페이지 조사(페이지 읽고 핵심 추출, 분류) | haiku | 해당 직무 프리셋(예: web-scraper, page-classifier) |
| 자료조사(여러 출처 검색·정리) | sonnet | 부서와 대부분 직무의 기본값 |
| 시장조사(경쟁사 비교, 시장 규모, 시사점) | 수집은 sonnet, 최종 분석은 opus | 역할을 둘로 나눈다. 수집 직무(sonnet)와 분석·결론 직무 또는 팀장(opus) |
| 서류작업(보고서, 제안서, 양식 채우기) | sonnet, 중요 문서는 opus | 문서 직무는 sonnet. 외부 제출용이나 논리가 복잡한 문서는 작업 단위로 opus로 올린다 |

- **presets.json:** 각 role에 `model`을 명시한다. 부서 `model`은 그 부서 role의 기본값이다.
- **우선순위:** 직원 `model` > 부서 `model` > `sonnet`. 팀장은 기본 `opus`다. 다만 단순 취합만 하는 부서의 팀장은 sonnet이어도 된다.
- **작업 단위 상향:**
  - AGENTS.md(비서실장 수칙): 외부 제출 문서, 최종 시장 분석, 복잡한 논리 문서는 서브에이전트를 부를 때 model을 opus로 지정한다.
  - 대량 페이지 수집은 haiku 직원에게 나눠 맡긴다.
- **대시보드:**
  - 작업 지시 폼에 모델 선택(기본/haiku/sonnet/opus)을 둔다. 고르면 runner가 `--model <별칭>`을 추가한다. 별칭은 허용 목록으로 검증한다.
  - 직원 추가·수정 폼의 모델 select도 같은 값을 쓴다. 직무 프리셋을 고르면 그 role의 model이 기본으로 선택된다.
- **Codex 검증실:** 이 정책의 대상이 아니다. Codex 모델 설정을 따른다.

## Codex 모델 (사용자 확정)

- **비서실장 기본(2026-10-30 최신 요청):** 제공자 `codex`, 모델 `gpt-6.1-sol`, effort `max`. 인계서의 Sonnet 기본값 제안을 대체한다. 상단의 제공자·모델·effort 선택은 `org/company.json`의 `chief:{engine,model,effort}`에 저장한다. 파일이 없으면 기본값을 쓰고, 사용자가 저장한 값은 보존한다. Claude로 바꾸면 선택한 모델과 `--effort`를 명시한다.
- 모델 선택 목록은 공개 CLI 캐시(`CODEX_HOME/models_cache.json`)의 표시 대상·지원 effort를 읽으며 캐시가 없으면 기본 목록을 사용한다. 기존 사용자 지정 모델은 현재 설정 항목으로 보존한다. 인증 파일은 읽지 않는다.
- 직원 `codexModel`/`codexEffort` > 부서 설정 > 공통 기본값 순으로 적용한다. 일회성 `OFFICE_CODEX_*` 덮어쓰기는 기존대로 적용하고 실행 기록에는 실제 적용값을 남긴다. 회사 구성 백업은 설정이 있는 경우 `settings`도 포함하고 이전 형식 가져오기는 기존 실행 설정을 보존한다.
- `PUT /api/settings`는 기존 상태 변경 API 인증·Origin 검사를 거쳐 설정을 검증·저장한다. `/api/state`는 settings·models·mode를 제공한다. CLI가 보고한 usage만 기록하며 보고되지 않은 금액을 0으로 만들지 않는다.

- **기본값:** 검증실과 codex 엔진 실행은 모델 `gpt-6.1-sol`, 추론 강도 `max`다. 전역 `~/.codex/config.toml`에 의존하지 않고 항상 명시한다.
  - 인자: `-m gpt-6.1-sol -c model_reasoning_effort="max"`
  - 인자 배열로 전달하므로 따옴표 처리는 TOML 값 문자열 `"max"`를 그대로 넣는다.
- **변경 방법:** codex 엔진 부서의 필드 `codexModel`/`codexEffort`로 바꿀 수 있다. 화면의 부서 설정에 노출한다.
  - 허용 effort: low|medium|high|xhigh|max|ultra
  - 모델 slug는 `^[a-z0-9][a-z0-9.-]{1,63}$`로 검증한다.
  - 일회성 덮어쓰기는 환경변수 `OFFICE_CODEX_MODEL`/`OFFICE_CODEX_EFFORT`로 한다.
- **비용 절감:** 테스트와 통합 검증에서만 `--effort low` 같은 덮어쓰기를 쓴다. 기본값은 바꾸지 않는다.

## 행동 지침 계층 (사용자 요구 보완)

직원 지침 파일은 다음 순서로 조립한다. 각 단계는 화면에서 편집할 수 있어야 한다.

1. **공통 머리말(자동):** 이름·직급·부서, 산출물 경로, 보고 형식, 팀장 규칙.
2. **회사 공통 규칙:** `org/company.md`. 화면의 "회사 설정"에서 편집한다. 비어 있으면 생략한다.
3. **부서 공통 지침:** 부서 필드 `instructions`(최대 4000자). 부서 생성·수정 모달에서 편집한다.
   - 값이 없으면 `org/templates/<id>.md`로 대체한다(하위 호환).
   - presets.json의 모든 부서에 기본 `instructions`를 넣는다.
4. **역할 지침:** 직원 필드 `instructions`.

API 추가:

| 메서드·경로 | 동작 |
|---|---|
| GET/PUT /api/company | `{rules}`. 최대 8000자. 저장 후 sync |
| GET /api/agents/:id/preview | 생성될 지침 파일 전문(텍스트). 휴무 직원도 미리보기 가능 |

화면 추가:
- 직원 프로필의 "최종 지침 미리보기"(읽기 전용, 고정폭)
- 상단의 "회사 설정"(회사 공통 규칙 편집)
- 부서 모달의 "부서 공통 지침" textarea

검증 경고: 직원의 description·specialty가 모두 비어 있으면, 저장은 허용하되 "비서실장이 배정 기준으로 쓸 설명이 없습니다" 경고를 응답과 화면에 표시한다.

## 통합 결정 기록 (2026-10-29)

통합 검증 중 계약을 바꾸거나 구체화한 항목과 이유다.

- **프롬프트 전달:** "모듈 인터페이스"의 "prompt는 마지막 인자, 앞에 `--`"를 stdin 전달로 바꿨다. "Windows·macOS 공통 동작"(필수 요구사항)과 충돌했고, `--allowedTools`가 가변 인자라 뒤의 위치 인자를 삼킬 위험도 있었다.
- **Codex `.toml` 대상:** verify 부서 id가 아니라 engine=codex 부서 전체로 정했다. 사용자가 직접 입력으로 codex 부서를 만들어도 동작해야 하고, 프리셋 기준 결과는 같다.
- **팀장 모델:** 생성 규칙의 `inherit`를 사용자 확정 정책(팀장 기본 opus)으로 맞췄다.
- **프리셋 부서 id:** API로 `{preset:"verify"}`만 보내면 영문 표기에서 `verification`이 만들어져 `org/templates/verify.md`·검증실 규칙과 어긋났다. 프리셋 id를 먼저 쓰게 고쳤다.
- **훅 명령:** 셸 형식에서 exec 형식으로 바꿨다(위 "훅 명령").
- **codex-review 종료 코드 1(ERROR):** SPEC에 없던 값을 구현대로 명시했다.
- **프리셋 직무 추가:** 모델 정책 예시(web-scraper, page-classifier, haiku)에 맞춰 리서치부에 두 직무를 추가했다(직무 72개).

### 리뷰 반영 (2026-10-29)

- **직원 `role` 필드:** 직무 프리셋으로 만든 직원에 직무 key(예: `fact-checker`)를 `role`로 남긴다. `codex-review.mjs --reviewers`는 직원 id와 `role`을 모두 받는다. 화면에서 만든 검증실 직원 id(`verify-1`)와 AGENTS.md의 직무 key 절차가 어긋났기 때문이다.
- **id 유일성:** 부서·직원 id를 한 집합으로 검사하고, `chief`는 직원 id로 쓰지 않는다(메인 세션 agent 값과 충돌).
- **codex 엔진 직원 작업 지시:** 대시보드 요청에는 산출물 폴더(`--target`)가 없어서 `codex-review.mjs`를 거치지 않고 `codex exec`를 직접 실행한다. 대신 codex-review의 `buildPrompt`(공통 검토 기준·VERDICT 형식)를 그대로 쓰고, 이벤트도 `review.start`/`review.end`(verdict 포함, instance `run-<id>`)로 남겨 REVIEWS 지표에 잡히게 했다. `reviews/<id>.md` 저장은 `POST /api/reviews`(산출물 검증)에서만 한다.
- **runner 이벤트 집계:** state는 instance가 `run-<id>`인 시작/종료 이벤트를 진행·완료 수에서 빼고 run만 센다(이중 집계 방지). 대기열 run이 있는 직원은 `agents[id].queued: true`다.
- **sync 충돌 경고:** 조직 변경 응답에 sync가 덮어쓰지 못한 파일(표식 없는 사용자 파일)을 `warnings`로 붙인다. 부서 응답에도 붙을 수 있다.
- **비밀값 가림:** JSON 키(`"password":"x"`), 따옴표로 감싼 값 전체, `Cookie:` 헤더 전체, `--key 값`, `key is 값`을 가린다. 공백으로만 이어진 단어(`password policy`)는 가리지 않는다.
- **종료와 중지:** 서버 종료 시 실행 중인 그룹을 SIGTERM → 5초 뒤 SIGKILL로 끝내고 대기열은 취소한다. 중지 후 리더만 끝나고 그룹이 남아 있으면 SIGKILL 타이머를 유지한다.
- **원격 바인딩 인증:** 루프백이 아닌 `--host`에서는 토큰을 index.html에 그냥 주입하지 않고, 시작 때 출력하는 `?key=` 주소로 HttpOnly·SameSite=Strict 쿠키를 받은 브라우저만 허용한다(나머지 401). 루프백 동작은 그대로다.
- **읽기 API 토큰:** `GET /api/runs/:id/log`, `GET /api/agents/:id/preview`, `GET /api/company`도 `X-Office-Token`을 요구한다. 실행 로그는 0600, `.office/runs`는 0700으로 만든다.
- **검토 대상 경로:** `POST /api/reviews`와 `codex-review.mjs --target`은 실제 경로(realpath) 기준으로 `outputs/` 안만 받는다.
- **실행 결과 보기:** 전체 답변은 로그(stream-json)에서 화면이 assistant 텍스트·최종 result만 추려 보여준다('원문 보기'로 전환). (2026-10-29 "이어서 답하기"에서 답변 전문 파일 `.office/runs/<id>.result.md`와 `GET /api/runs/:id/result`를 추가했다.)
- **결정됨(2026-10-29, 요약 유지 — 아래 "요청 요약 저장" 참조):** request 이벤트·runs의 요청 요약(앞 200자/120자, 비밀값 가림)이 "원문 프롬프트는 저장하지 않는다"에 해당하는지. 요약을 없앨지, "앞 N자 요약 저장"으로 정본을 고칠지 정해야 한다.

## 이어서 답하기 (2026-10-29)

대시보드 지시는 `claude -p`로 한 번 실행되고 끝나서, 비서실장이 확인 질문으로 답을 끝내면 대표가 답할 곳이 없었다. 같은 세션을 이어서 실행해 답장할 수 있게 한다.

- **세션 id:** claude는 stream-json의 system(init)·result 줄의 `session_id`, codex는 `thread.started`의 `thread_id`를 `run.sessionId`에 저장한다(runs.json). UUID 형식(`SESSION_PATTERN`)만 받는다. `/api/state`·API 응답의 run에는 값 대신 `canReply`(세션 있음, review 아님)만 싣는다.
- **run 필드 추가:** `sessionId`, `parentId`(답장 대상), `rootId`(대화 묶음 최상위, 첫 실행은 자기 id), `model`(작업 지정 모델 또는 null), `needsReply`. 이 필드가 없는 예전 run은 `canReply:false`, `rootId:id`, `parentId:null`, `needsReply:false`로 본다.
- **답변 전문:** 마지막 result 텍스트(없으면 마지막 assistant 텍스트, codex는 마지막 agent_message)를 `.office/runs/<id>.result.md`(0600)에 저장한다. `run.summary`는 기존처럼 200자 요약이다. 검증(`startReview`) run은 저장하지 않는다.
- **답변 필요(needsReply) 휴리스틱:** done이고 세션이 있으며 답변이 질문으로 끝나면 true. 마지막 단락에 `?`가 있거나, 마지막 단락에 "확인하겠습니다·알려 주세요·알려 주시면·선택해 주세요·말씀해 주세요·답하셔도·기본값으로 진행" 등이 있거나, 번호 목록 질문이 2개 이상(또는 마지막 세 단락 안에 1개 이상)이면 true. "필요하시면 말씀해 주세요" 같은 맺음 인사만 있으면 false. true면 `reply.wait` 이벤트(agent, run, 마지막 단락 요약)를 남긴다. 답장하면 원래 run의 needsReply는 false가 된다. `metrics.needsReply`는 실행 중이 아닌 needsReply run 수다.
- **reply 검사 순서:** 프롬프트·모델 검증(400) → run 없음 404 → 원 run 또는 같은 대화의 run이 running/queued면 409("이전 실행이 끝난 뒤 답할 수 있습니다.") → 세션 없음·형식 불일치·review면 409 → 원래 직원 삭제·휴무·부서 운영 중지면 400 → 부서 엔진이 원래 run과 다르면 400.
- **명령:** claude는 `start`와 같은 인자(현재 부서 설정의 권한·도구, `--agent`, 모델은 답장 지정 > 원래 run 모델) 뒤에 `--resume <sessionId>`를 붙이고 답장은 stdin으로 넣는다. codex는 `codex exec -s read-only -C <root> resume --json -m <모델> -c model_reasoning_effort="<강도>" <thread_id> -`이고 stdin에는 답장만 넣는다(검토 지침은 이전 대화에 있다). 새 run은 target·agentId가 같고 parentId·rootId를 가지며 큐·중지·로그·이벤트 처리는 일반 실행과 같다. 새 run의 sessionId는 원 세션으로 시작하고, 출력에 새 세션 id가 오면 그것으로 바꾼다.
- **화면:** 실행 목록·직원 프로필 최근 실행에 '답변 필요' 배지와 '대화' 버튼, 상단 지표 '답변 필요 N'(0이면 숨김, 누르면 가장 최근 대화), 피드의 "○○님이 답변을 기다립니다". 대화 창은 같은 rootId의 run을 시간순으로 [요청 요약 → 답변 전문] 표시하고, 답변 마크다운은 제목·목록·굵게·코드만 해석해 DOM `textContent`로 그린다(innerHTML에 원문을 넣지 않는다). 하단 답장 입력·모델 선택·보내기는 실행 중·세션 없음·데모 모드에서 비활성이다. 세션 id는 토큰이 필요한 result 응답 헤더로 받아 "저장소 폴더의 터미널에서 이어가기: `claude --resume <id>`(직원 실행은 `--agent <직원 id>` 추가, codex는 `codex exec resume <id>`)"로 보여준다(세션은 실행 폴더 기준으로 저장된다).
- **수칙:** AGENTS.md·office-task 스킬·직원 공통 머리말에 "헤드리스 실행 가능, 낮은 위험은 `가정:`으로 진행, 큰 결정만 번호 목록 질문 + 권장 기본값, '답장 또는 '기본값으로 진행'이라고 답하면 됩니다.'로 끝냄"을 둔다.

## 배포 방식 (사용자 확정: 각자 자기 컴퓨터에서 로컬 실행)

사용자마다 레포를 받아서 자기 컴퓨터와 자기 claude·codex 로그인으로 실행한다. 대시보드를 공유하거나 원격으로 접속하지 않는다.

- **개인 데이터는 Git에서 제외한다:** 부서·직원·회사 규칙은 사용자마다 다르기 때문이다.
  - 대상: `org/departments.json`, `org/roster.json`, `org/company.md`, 생성 파일 `.claude/agents/*.md`·`.codex/agents/*.toml`
  - `.gitignore`에 넣는다. 레포에는 프로그램, `org/presets.json`, `org/templates/`만 둔다.
  - 파일이 없으면 빈 회사로 시작한다. loadOrg가 없는 파일을 `[]`로 처리한다.
  - 기존에 추적 중이던 빈 `org/departments.json`·`roster.json`은 레포에서 제거한다.
  - 사용자가 직접 만든 표식 없는 에이전트 파일은 보존 규칙을 유지한다.
- **백업과 이전:** 화면의 "회사 설정"에 두 기능을 둔다.
  - "회사 구성 내보내기": `{version, company, departments, roster}` JSON 다운로드
  - "가져오기": 업로드 → 검증 → 덮어쓰기 확인 → 저장·sync
  - 같은 기능을 CLI로도 제공한다: `node scripts/office.mjs org export|import <file>`
- **`npm run doctor`** (`scripts/doctor.mjs`, 두 OS 공통):
  - 점검 항목: Node 버전(20 이상), `claude` 설치·버전, `claude auth status`의 loggedIn·authMethod, `codex` 설치·버전, `codex login status`, Windows의 Git for Windows 유무(선택 사항으로 안내), 포트 4777 사용 가능 여부
  - 실패한 항목에는 OS별 설치·로그인 명령을 안내한다.
  - API 키 환경변수(`ANTHROPIC_API_KEY` 등)가 있으면 "구독 대신 API 과금으로 실행될 수 있음"을 경고한다. 값은 출력하지 않는다.
  - 인증 정보와 이메일은 출력하지 않고, 로그인 여부만 표시한다.
- **서버 시작 시:** doctor의 빠른 점검(설치 여부만)을 실행한다. 빠진 도구는 화면 상단에 배너로 알린다. 예: "codex가 설치되지 않아 검증실을 실행할 수 없습니다".
- **README:** "처음 받는 사람" 절을 둔다. 순서는 받기 → Node 설치 → claude·codex 설치와 로그인 → `npm run doctor` → `npm run office`다. 한 사람의 구독을 여러 사람이 함께 쓰지 말고 각자 계정으로 실행하라는 안내를 넣는다.

### 배포 방식 구현 계약 (2026-10-29)

- **내보내기 형식:** `{version:1, company, departments, roster}`. `lib/org.mjs`의 `exportOrg(root)`, `checkOrgImport(data)`(형식 + `validateOrg`, 저장 안 함), `importOrg(root, data, {mode:'replace'})`(검증 실패 시 아무것도 쓰지 않고 `err.errors`를 붙여 던짐. 통과하면 company.md·정본을 쓰고 sync 1회. 조직 변경과 같은 큐)를 쓴다.
- **API:**

| 메서드·경로 | 동작 |
|---|---|
| GET /api/org/export | `X-Office-Token` 필요. 첨부 파일(`Content-Disposition: attachment; filename="ai-office-org-<KST 날짜>.json"`) |
| POST /api/org/import | `{data, mode:'replace'}`. 본문 한도 8MB(내보내기에 크기 제한이 없어 다른 API의 1MB보다 크게 둔다). 검증 실패 400(저장 안 함), 데모 모드 409. 200 `{ok, departments, roster, company, warnings?}` |

- **화면:** "회사 설정" 모달에 "회사 구성 내보내기"(다운로드)와 "가져오기"(파일 선택 → 부서 N·직원 M 요약 → 덮어쓰기 확인 → 저장 → 성공·경고 토스트).
- **CLI:** `node scripts/office.mjs org export <파일> [--yes]`(이미 있는 파일은 --yes가 있어야 덮어씀), `org import <파일> [--yes]`(요약을 보여주고 대화형 터미널에서만 확인을 묻는다. 확인이나 --yes가 없으면 덮어쓰지 않고 종료 코드 1).
- **doctor:** 공용 로직은 `lib/doctor.mjs`, 진입점은 `scripts/doctor.mjs [--json] [--port N]`. 명령은 `lib/cli.mjs`의 탐색·spawn 규칙(CLAUDE_BIN/CODEX_BIN, Windows `.cmd`)으로 띄우고 각 5초 타임아웃. `claude auth status`는 JSON의 `loggedIn`·`authMethod`만, `codex login status`는 로그인 여부만 쓴다. API 키 환경변수는 `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `CODEX_API_KEY`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`의 이름만 경고한다. Windows는 Git Bash(`CLAUDE_CODE_GIT_BASH_PATH` 또는 Git 설치 위치의 bash.exe, System32 제외)를 선택 항목으로 보여준다. 종료 코드는 필수 항목(Node 20 이상, claude 설치·로그인) 실패 시 1, 그 밖에는 0, 잘못된 옵션은 64다. `claude auth status`를 읽지 못하거나 시간 초과면 실패로 단정하지 않고 경고(⚠)로 둔다.
- **서버 빠른 점검:** listen 뒤 `setImmediate`로 `quickToolCheck`(프로세스를 띄우지 않고 실행 파일 존재만 확인)를 실행하고, `/api/state`에 `tools:{claude:{installed}, codex:{installed}}`를 싣는다. 점검 전에는 `installed: null`이다. 화면은 `false`인 도구만 상단 배너로 알리고(데모 모드 제외), 닫을 수 있다.

## 요청 요약 저장 (사용자 확정 2026-10-29)

- **정책:** 요청 요약을 유지한다.
  - request 이벤트의 summary와 runs.json의 request에 요청 문장 앞부분을 저장한다(각 200자·120자). 저장 전에 redact로 비밀값을 가린다.
  - 저장 위치는 각자 컴퓨터의 `.office/`뿐이고 Git에서 제외된다.
- **효력:** 위 "개인정보·비밀값"의 "원문 프롬프트는 저장하지 않는다"는 원문 전체를 저장하지 않는다는 뜻으로 해석한다. 리뷰 반영의 해당 미결 항목은 이 결정으로 닫는다.

## 업무 흐름·실시간 피드 (사용자 확정 2026-10-29)

### 표준 업무 흐름(단계)

```
요청(사용자→비서실장) → 내용 확인(비서실장) → [회의(필요 시)] → 업무 하달(비서실장→부서)
→ 업무 전달받음(부서) → 진행 중(부서: 무슨 작업인지) → 작업 완료(부서)
→ 업무 협조 요청(부서A→부서B, 비서실장 경유) → 업무 확인(부서B) → 진행 중 → 산출물 작성 완료(부서B)
→ 검토 요청(부서→비서실장) → 검토 통과 → 사용자 확인 대기 → 사용자 승인 → 완료
                         └ 검토 반려 → 상황에 따라 해당 부서(B 또는 A)로 반려 → 다시 진행
사용자 반려(피드백) → 비서실장이 재배정
```

- **lib/flow.mjs의 `deriveFlow(events, org)`**(순수 함수)는 이벤트를 위 단계의 업무 언어 항목으로 바꾼다.
  - 항목 형식: `{task, ts, stage, from, to, actor, dept, text, detail?, files?}`
  - `stage`: `request|intake|meeting|assign|accept|progress|done|cooperate|review_request|review_pass|review_reject|deliver|user_approve|user_reject|codex_review|reply_wait` (`reply_wait`는 리뷰 반영으로 추가)
- **자동 도출 규칙**(훅 이벤트만으로, 비서실장이 CLI를 잊어도 동작):

| 원천 이벤트 | 단계 | 피드 문구 |
|---|---|---|
| 메인 세션 request | request | "사용자 → 비서실장: 업무 요청 '…'" |
| 그 직후 비서실장의 첫 활동, task.start | intake | "비서실장: 요청 내용 확인", "업무 등록 '제목'" |
| 비서실장 Agent 호출(subagent_type=X, X는 부서 D 소속), 같은 task에서 다른 부서 E의 직원이 앞서 완료됨 | cooperate | "E → D: 업무 협조 요청(비서실장 전달) — description" |
| 위 조건이 아닌 Agent 호출 | assign | "비서실장 → D: 업무 하달 — description" |
| description이 `[회의]`로 시작하는 Agent 호출 | meeting | — |
| description이 `[반려]`로 시작하는 Agent 호출 | review_reject | — |
| SubagentStart | accept | "D 김팀장: 업무 전달받음" |
| 서브에이전트 tool 이벤트 | progress | 직원별로 마지막 1줄만 유지(아래 도구 번역 참조) |
| SubagentStop | done | "D 김팀장: 작업 완료 — 결과 첫 문장". 그 직원의 Write/Edit 파일 basename을 files로 |
| 비서실장 review.start/review.end, Codex 검토 | codex_review | "검증실: 검토 중 / 판정 PASS·FIX·BLOCK" |

- **도구 번역**(명령어 원문은 숨김):

| 도구 | 문구 |
|---|---|
| WebSearch | "자료 검색 '검색어'" |
| WebFetch | "웹페이지 확인 '도메인'" |
| Read/Glob/Grep | "자료 확인 '파일명'" |
| Write/Edit | "문서 작성 '파일명'" |
| Bash | "데이터 처리 중" (python이면 "분석 스크립트 실행", curl이면 "웹 자료 수집") |
| Agent | (위 하달·협조 규칙) |
| Skill | "양식 사용 '스킬명'" |

- **명시 이벤트**(비서실장이 CLI로 기록, 자동 도출보다 우선):
  - `node scripts/office.mjs flow <task> review-request --from <부서>`
  - `node scripts/office.mjs flow <task> review --verdict pass|reject --to <부서> --reason "…"`
  - `node scripts/office.mjs flow <task> deliver`: 사용자 확인 대기. task status는 `review`다.
  - `node scripts/office.mjs flow <task> cooperate --from A --to B --note "…"`
  - `node scripts/office.mjs meeting <task> start --attendees a,b --agenda "…"` / `meeting <task> end --summary "…"`
  - 이벤트 kind는 `flow.*`와 `meeting.*`이고 기존 이벤트 형식을 따른다.
- **사용자 확인:**
  - task가 `review` 상태면 화면에 "사용자 확인 대기" 카드를 띄운다. 버튼은 [산출물 보기] [승인] [반려(피드백 입력)].
  - 승인: `POST /api/tasks/:id/approve`로 status를 done으로 바꾸고 user_approve를 기록한다.
  - 반려: `POST /api/tasks/:id/reject {feedback}`로 user_reject를 기록하고, 그 업무의 비서실장 run에 이어서 답하기로 피드백을 전달해 재배정한다. 세션이 없으면 새 비서실장 run을 띄운다.

### 실시간 피드 화면
- **기본은 업무 언어 피드다.** deriveFlow 항목을 업무(task)별로 묶어 시간순으로 보여준다. 항목마다 부서색 칩과 from→to 화살표를 단다. progress는 직원별 한 줄로 갱신한다(누적하지 않음).
- **"상세 보기" 토글(기본 꺼짐):** 켜면 기존 도구 이벤트를 보여준다. 명령은 가린 요약이다.
- **업무 카드의 단계 표시줄:** 요청 → 확인 → 하달 → 진행 → 협조 → 검토 → 사용자 확인 → 완료. 반려가 있으면 되돌아간 화살표와 횟수를 표시한다.

### 비서실장 수칙(강화)
- **직접 실무 금지:** 업무 중(task 연결된 세션)인 비서실장은 웹 수집·스크립트 실행·산출물 작성을 직접 하지 않는다.
  - 허용: Read/Glob/Grep, Agent, `node scripts/office.mjs …`, `node scripts/codex-review.mjs …`, 그리고 outputs/<task>/의 brief.md·meeting.md·plan.json·report.md·review-notes.md 작성(아래 "강제 장치 구현 결정").
- **강제 장치:** `hooks/chief-guard.mjs`(PreToolUse)를 둔다.
  - 판정 대상: agent_type이 없는 메인 세션이 sessions.json에 task가 연결된 상태에서 허용 목록 밖의 도구를 쓰려는 경우다.
  - 동작: 그 호출을 거부하고 "비서실장은 직접 실무를 하지 않습니다. 담당 직원에게 Agent로 배정하세요"를 사유로 돌려준다(Claude Code PreToolUse의 deny JSON). 그 밖의 경우는 무출력·종료 코드 0이다.
  - 고정할 형식: `.claude/settings.json`에 exec 형식으로 등록한다. 공식 문서의 hookSpecificOutput.permissionDecision 형식을 확인해서 쓴다.
- **지시문에 담당이 적혀 있으면 그대로 따른다:** 예: "마케팅이 조사하고 최대리가 HTML 작성, 비서실장이 검토". 이름·부서·직무로 직원을 매칭하고, 매칭이 안 되면 회의로 대체한다.
- **담당이 없으면 회의:**
  - 모호하거나 범위가 넓은 요청은 관련 부서 팀장·담당 2~4명을 `[회의]` Agent 호출로 병렬 소집한다. 각자 범위·산출물·분담을 제안하게 한다.
  - 판정 기준(통합 검증으로 구체화): 지시문에 담당(부서·이름·직무)이 하나도 없고 관련될 수 있는 근무중 부서가 둘 이상이면, 요청이 짧아도 회의를 연다. 근무중 부서가 하나뿐이면 생략한다.
  - 비서실장이 취합해 `outputs/<task>/meeting.md`(참석자·안건·결정·가정·분담)를 쓴다. 이견이 크면 취합안으로 2차 회의를 연다.
  - 사용자에게는 비용 발생·외부 발송·법적 판단·되돌리기 어려운 결정만 묻는다.
- **단계 간 근거 전달:** 협조 요청 때 brief.md 배정표의 "입력(앞 단계 산출물 경로)·출력(이번 산출물 경로)·완료 기준"을 Agent 프롬프트에 그대로 넣는다.
- **검토 기록:** 검토 결과는 반드시 `flow review`로 기록한다.
  - 통과하면 report.md를 쓰고 `flow deliver`를 실행한다.
  - 반려하면 `[반려]` Agent 호출로 해당 부서에 사유와 수정 기준을 전달한다. 원인이 앞 단계면 앞 단계 부서로 보낸다.
  - 반려는 최대 2회까지다. 그 뒤에도 해결되지 않으면 사용자 확인으로 넘긴다.

### 강제 장치 구현 결정 (2026-10-29)

- **판정 모듈:** 판정은 `lib/chief-guard.mjs`의 `decideChiefGuard(input, {root, sessions, getOrg})`(null = 허용, `{reason}` = 거부)에 두고, 훅은 입력·파일 읽기와 출력만 한다. 정본은 Agent 호출일 때만 읽는다.
- **출력 형식(공식 문서 확인, 2026-10-29):** 거부 때만 stdout에 `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}` 하나를 쓰고 종료 코드 0이다. deny 사유는 Claude에게 전달된다. 허용·대상 아님·잘못된 입력·모듈 로드 실패·깨진 정본은 모두 무출력·종료 코드 0(허용)으로 안전하게 끝낸다. 2초 제한은 office-event와 같다(stdin 1.5초, 강제 종료 1.9초).
- **판정 대상 아님:** `agent_type`이 있는 입력. 서브에이전트뿐 아니라 `--agent <id>`로 실행한 직원 직접 지시 run도 공식 문서상 `agent_type`이 붙으므로 제한하지 않는다.
- **허용 목록 보강:**
  - `plan.json` 쓰기: "조직 적응형 오케스트레이션"에서 비서실장이 배정 전에 쓰도록 정해서 허용 파일에 넣었다.
  - 업무 조율 도구(Skill, ToolSearch, AskUserQuestion, SendMessage, TodoWrite, Task 목록 도구, 계획 모드): 산출물을 만들지 않고 office-task 스킬 사용·진행 관리에 필요하다. 예전 이름 `Task`의 서브에이전트 호출은 Agent와 같게 판정한다.
- **셸 명령:** Bash·PowerShell은 `node scripts/office.mjs …`/`node scripts/codex-review.mjs …` 단독 실행만 허용한다. 따옴표만 해석하는 토큰 분리 후 따옴표 밖의 `;` `&` `|` `<` `>` `(` `)` `$`·백틱과 줄바꿈, 큰따옴표 안의 `$`·백틱이 있으면 거부한다(`cd …&&`, 리다이렉션, 명령 치환으로 우회하지 못하게). 작은따옴표 밖의 백슬래시 뒤에 영문·숫자·`_` `.` `-`가 아닌 문자가 오거나 줄 끝이면 거부한다(bash는 `\'`를 글자 따옴표로 읽어 이 분리기가 따옴표 안으로 본 `;`가 실제 연산자가 된다). PowerShell이 따옴표로 읽는 유니코드 따옴표(‘ ’ “ ” 등)도 거부한다. office.mjs는 하위 명령 허용 목록(task start·list·files, task status <id> blocked|active, flow, meeting, plan validate)만 허용하고 org export·import와 task status done·review는 거부한다. 스크립트 경로는 실제 경로(realpath) 기준으로 레포의 두 파일인지 본다. 거부 사유에 "단독으로, 특수문자 값은 작은따옴표"를 안내한다.
- **파일 쓰기:** Write/Edit/MultiEdit의 `file_path`가 `outputs/<task>/` 바로 아래 허용 파일 이름일 때만 허용한다(실제 경로 기준, Windows는 대소문자 무시). 부서 하위 폴더 산출물은 직원의 일이라 거부한다.
- **Agent:** `subagent_type`이 근무중 직원(직원·부서가 휴무가 아니고, 부서 engine이 codex가 아님)이 아니면 거부한다. 내장 에이전트(`general-purpose`, `Explore`)와 subagent_type 생략도 거부한다. 사유에 `id(이름 직급 · 부서 · 담당)` 목록을 1500자 안으로 넣고 gaps 안내를 붙인다.

### 조직도 주입 훅 (2026-10-29)

- **파일:** `hooks/session-context.mjs`(SessionStart). office-event 훅은 stdout 무출력 원칙이라 따로 두고, `.claude/settings.json`의 SessionStart에 exec 형식으로 함께 등록한다.
- **출력(공식 문서 확인, 2026-10-29):** `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}`. additionalContext가 10,000자를 넘으면 Claude Code가 파일로 돌리고 앞 2,000자만 보여 주므로 9,500자에서 자르고 정본 위치를 안내한다.
- **내용:** 비서실장 수칙 요약 3줄 + `buildOrgMap(org, {presets})`. orgmap 모듈을 불러오지 못하면 근무중 직원만 담은 최소 조직도로 대신한다. startup·resume·clear·compact 모두 주입한다(compact 뒤에도 조직도가 남게).
- **생략:** `agent_type`이 있는 세션(직원), 잘못된 입력, 오류는 무출력·종료 코드 0. 대시보드 비서실장 run은 runner가 `--append-system-prompt`로 같은 내용을 넣으므로, runner가 환경변수 `OFFICE_ORGMAP_INJECTED=1`을 주면 중복 주입하지 않는다.

### 개인 데이터 회귀 테스트 기준 (2026-10-29)

- "저장소에 개인 데이터 파일이 없다"·"초기 정본은 빈 회사" 테스트는 파일 존재가 아니라 `git ls-files`(추적 안 함)와 `git check-ignore`(.gitignore 제외)로 검사한다. 사용자가 실제로 쓰는 레포에는 자기 org 파일이 있어도 전체 테스트가 통과해야 하기 때문이다. git 저장소가 아니면 추적 검사만 건너뛴다.

### 사무실·조직·산출물 화면
- **사무실:**
  - 비서실(대표실 옆)에 비서실장 자리를 둔다. agent `chief` 상태를 반영한다.
  - 회의 중(meeting.start~end, 또는 `[회의]` 호출 진행 중)인 참석자는 회의실로 이동한다.
  - 협조 요청이 오면 두 부서 사이에 서류 전달 연출을 짧게 보여준다.
- **뷰 탭은 관제 | 사무실 | 조직 | 산출물이다.**
  - 조직: 언제든 부서 프리셋 그리드, 부서·직원 목록(추가·수정·삭제·근무 전환), 일괄 추가, 회사 설정.
  - 산출물: 업무별 목록(날짜·제목·상태·검토 판정·참여 부서)과 상세(report·meeting·부서별 파일·reviews·대화 스레드).
    - 텍스트류(md/txt/csv/json/html 소스)는 미리보기, 그 밖의 파일은 다운로드한다.
    - html은 sandbox iframe(스크립트 비허용)으로 미리본다. blob 문서 맨 앞(doctype 뒤)에 CSP meta(`default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'`)를 넣는다(리뷰 반영).
    - "폴더 열기"는 macOS `open`, Windows `explorer`, Linux `xdg-open`을 인자 배열로 실행한다.
    - 검색·필터를 둔다.
  - API: `GET /api/outputs`, `GET /api/outputs/:taskId/files`, `GET /api/outputs/file?path=`(outputs 내부만, realpath 검사, 토큰 필요), `POST /api/outputs/:taskId/open`.
- **직원 직접 지시 run의 저장 위치:** runner가 `outputs/<날짜>/run-<id>/`를 만들고 task로 등록한다. 프롬프트 끝에 "산출물은 이 폴더에 저장"을 덧붙인다.

## 조직 적응형 오케스트레이션 (사용자 확정 2026-10-29: "내가 만든 부서에 따라 협조가 잘 이뤄져야 한다")

부서명을 하드코딩하지 않는다. 비서실장은 사용자가 만든 현재 조직을 읽고 분담·협조 순서를 계획한다. 이를 구조로 보장한다.

- **조직도 주입:**
  - `lib/orgmap.mjs`의 `buildOrgMap(org)`가 Markdown을 만든다. 내용은 부서별 summary·capabilities·handoffs, 근무중 직원의 id·이름·직급·직무·담당·모델, 휴무 표시다.
  - 주입 경로:
    - 대시보드 비서실장 run: runner가 `--append-system-prompt`로 전달한다. Windows 인자 길이를 고려해, 길면 `--append-system-prompt-file`을 쓰고 지원 여부를 확인한다.
    - 레포에서 직접 연 `claude` 세션: SessionStart 훅의 additionalContext로 전달한다. 훅 출력 형식은 공식 문서를 확인한다.
  - 조직이 바뀌면 다음 실행부터 자동으로 반영된다.
- **부서 역량 필드:**
  - `capabilities`: 문자열 배열, 예 ["자료조사","HTML·웹 문서","엑셀","검토"]
  - `handoffs`: 부서 id 배열, 주로 결과를 넘기는 부서
  - presets에 기본값을 넣는다. 조직 탭과 부서 모달에서 편집한다(태그 입력). validateOrg가 handoffs의 대상 존재를 검사한다. 대상이 없으면 경고만 한다.
- **작업 계획표:**
  - 비서실장은 배정 전에 `outputs/<task>/plan.json`을 쓴다.
    - 형식: `{version:1, task, goal, stages:[{id, title, dept, agent, inputs:[경로|stage id], output, done, dependsOn:[stage id], parallelGroup?}], review:{by:'chief'|'codex'|..., criteria}, gaps:[{need, suggestion}]}`
  - `node scripts/office.mjs plan validate <task>`가 검사한다.
    - 검사 항목: 근무중 직원 존재, agent와 dept 일치, 순환 없음, output이 outputs/<task>/ 안인지, 각 inputs가 앞 단계 output이나 존재하는 파일인지.
    - 통과하면 plan.set 이벤트를 남긴다. 실패하면 사유를 출력하고 종료 코드 1을 반환한다. 비서실장은 고쳐서 다시 실행한다.
  - deriveFlow와 화면은 plan이 있으면 단계를 plan 기준으로 표시한다.
    - 단계 상태: 대기, 진행, 완료, 반려
    - Agent 호출의 subagent_type을 stage.agent와 매칭한다.
  - 계획에 없는 직원 호출은 경고 이벤트(`flow.offplan`)로 남긴다.
- **역량 공백:** 필요한 역량을 가진 근무중 부서가 없으면 다음과 같이 처리한다.
  - plan.gaps에 기록하고 화면에 "역량 공백" 카드를 띄운다. 예: "HTML 작성 가능한 부서 없음 → 개발부 추가 권장". 카드에는 조직 탭으로 가는 링크를 단다.
  - 비서실장이 그 일을 대신하지 않는다. 가능한 단계만 진행하고, 공백은 보고서에 명시한다.
- **강제 장치(chief-guard 확장):** Agent 호출의 subagent_type이 근무중 직원이 아니면 거부한다. 사유에 사용 가능한 직원 목록 요약을 넣는다.
- **검증 요구:**
  - 단위 테스트: 서로 다른 조직 구성 5가지 이상(마케팅+개발, 리서치+문서+재무, 단일 부서, 휴무 직원 포함, codex 검증실 포함)에서 orgmap, plan validate, deriveFlow가 맞는지 확인한다.
  - 실제 claude 확인 2건(짧은 주제, 비용 최소화):
    - ① 마케팅부+개발부: "조사 → 개발부 최대리 HTML → 비서실장 검토 → 사용자 확인 대기"
    - ② 리서치부+문서부+재무부처럼 다른 구성
  - 판정 기준: 이벤트 기록에서 계획대로 분담·협조됐는지, 비서실장이 직접 실무를 하지 않았는지, 피드 단계가 올바른지.

## 사용자 의견 필요 아이콘 (사용자 확정 2026-10-29)

- **상태에 추가하는 필드:** `attention:[{kind:'reply'|'approve'|'gap', agent:'chief'|<직원id>, runId?, task?, since, text}]`
  - 정렬은 since 오름차순이다.
  - reply: needsReply인 마지막 run의 대상 직원. 비서실장 run이면 chief다.
  - approve: task가 review 상태(사용자 확인 대기)면 chief.
  - gap: plan.gaps가 있으면 chief.
- **사무실 캔버스:**
  - 해당 캐릭터 머리 위에 아이콘을 띄운다. reply는 💬 말풍선, approve는 📋 결재 서류, gap은 ⚠️다. 이모지 대신 픽셀로 그려 두 테마에서 대비를 확보한다.
  - 아이콘은 위아래로 튀는 애니메이션과 은은한 발광을 낸다. 배율이 낮아도 읽히도록 크기를 1/z로 보정한다.
  - 클릭 hit-test는 캐릭터보다 아이콘을 우선한다.
  - 자동 순찰이 켜져 있으면 attention이 있는 직원의 방으로 먼저 이동한다.
- **클릭 동작:**
  - reply: 대화 보기 모달을 연다(스레드와 답장 입력).
  - approve: 사용자 확인 모달을 연다. report와 산출물 미리보기, [승인]·[반려(피드백)] 버튼이 있다.
  - gap: 공백 내용과 [조직 탭으로] 버튼을 보여준다.
- **관제 뷰·목록:** 부서 카드, 직원 행, 프로필에 같은 아이콘을 붙인다. 상단의 "답변 필요 N" 칩은 attention 수를 보여주고, 누르면 가장 오래된 항목부터 연다.
- **페이지 밖 알림:**
  - attention이 있으면 `document.title` 앞에 `(N) 답변 필요`를 붙인다.
  - 브라우저 알림은 기본 꺼짐이다. 설정에서 켜면 Notification API 권한을 요청하고, 새 attention마다 1회 알린다. 선택은 localStorage에 try/catch로 저장한다.
- **데모 모드:** 시뮬레이터가 가끔 reply·approve attention을 만들어 연출을 보여준다. 데모에서는 답장·승인을 보낼 수 없다.

### 업무 흐름·오케스트레이션 구현 계약 (2026-10-29)

위 세 절(업무 흐름·조직 적응형 오케스트레이션·사용자 의견 필요)을 구현하며 구체화하거나 바꾼 계약과 이유다.

- **Agent 이벤트 구조화 필드:** `normalizeClaudeHook`이 tool이 Agent(Task)인 tool.start/end에 `target`(subagent_type, 형식 검사 통과 시)과 `desc`(description 120자 요약, 비밀값 가림)를 붙인다. summary(`대상: 설명`)는 그대로 둔다(하위 호환). deriveFlow가 문자열 파싱에 의존하지 않게 하려는 것이고, 필드가 없는 예전 이벤트는 summary로 보충한다.
- **모듈:**
  - `lib/flow.mjs`: `deriveFlow(events, org, {plans?, tasks?})`는 항목 배열(SPEC 계약 그대로), `deriveTaskFlows(...)`는 `{items, tasks:{[업무]:{steps:[{key,label,state:'done'|'current'|'todo'|'skip'}], current, rejects, userRejects, depts, plan:[단계+status·rejects]|null, goal, gaps}}}`. 항목에 선택 필드 `mode`(meeting|reject), `offplan`, `target`, `files`, `verdict`, `attendees`, `tool`이 붙을 수 있다. `translateTool(tool, summary)`, `isOffplanCall(ev, plan)`도 내보낸다.
  - `lib/orgmap.mjs`: `buildOrgMap(org, {presets?})`. capabilities·handoffs가 없는 예전 부서는 같은 id의 프리셋 기본값으로 보충하고 "(프리셋 기본값)"을 표시한다. 사용자 입력은 한 줄로 정리하고 120자로 자른다(Markdown 주입 방지).
  - `lib/plan.mjs`: `validatePlan(plan, {org, taskId, root, fileExists})` → `{ok, errors, warnings, plan(요약)}`, `compactPlan`, `isTaskId`(`YYYY-MM-DD/<slug>`, `..` 금지). `lib/tasks.mjs`: tasks.json 읽기·원자적 저장(office.mjs·서버·runner 공용).
- **업무 묶기:** 요청 이벤트는 OFFICE_TASK보다 먼저 나오고, 등록 전 이벤트에는 이전 업무가 붙어 있을 수 있다. 그래서 같은 세션의 대화 턴(요청 → 다음 요청) 안에서 마지막으로 보인 업무를 턴 전체의 업무로 본다. session이 `office-`로 시작하는 이벤트(office-cli·office-server·office-runner)는 대화 세션이 아니다.
- **자동 도출 세부:**
  - 협조는 대상 부서가 조직에 있을 때만 판정한다. 회의 의견 제출(`[회의]` 호출의 완료)은 '앞선 완료'로 세지 않는다.
  - SubagentStart는 같은 업무·대상의 가장 최근 Agent 호출과 짝짓는다. chief-guard가 거부한 호출은 SubagentStart가 없어 10분 지나면 버린다.
  - progress는 실행 인스턴스마다 한 줄이고, 작업 완료(agent.stop)·판정(review.end) 때 지운다. 직원 직접 지시 실행은 turn.end를 작업 완료로 본다.
  - 명시 이벤트가 먼저 오면 다음 자동 항목(같은 업무·대상 부서)을 건너뛰고, 나중에 오면 최근 20개·10분 안의 자동 항목을 지운다.
  - plan.json만 있고 plan.set 이벤트가 없으면 단계 상태만 표시하고 계획 밖 경고는 달지 않는다(검사를 통과한 계획만 기준으로 삼는다).
- **이벤트 kind와 필드:** `flow.review_request{from}`, `flow.review{verdict:'pass'|'reject', to?}`, `flow.deliver`, `flow.cooperate{from,to}`, `flow.user_approve`, `flow.user_reject`, `flow.offplan{target, ref}`, `meeting.start{attendees}`, `meeting.end`, `plan.set{plan(요약)}`. 사유·메모·안건·회의 요약은 summary(200자, redact)다. CLI의 `--from/--to`는 부서 id 또는 직원 id(소속 부서로 바꿈)를 받고, 없는 부서는 종료 코드 1로 있는 부서 목록을 보여준다. 사용자 행동(승인·반려)과 서버 경고 이벤트는 session `office-server`이고 agent를 붙이지 않는다(직원으로 세지 않게).
- **task status `review`:** review는 `flow deliver`로만 바뀐다. `task status <id> review`는 대표가 터미널에서 `--by-user`를 붙일 때만 받는다(리뷰 반영).
- **plan validate 세부:** 경로는 레포 기준(`outputs/…`)이나 업무 폴더 기준 상대경로를 받는다. 단계 id는 영문·숫자·`_-` 40자, 최대 30단계. 입력이 뒤 단계 산출물이면 dependsOn 추가를 안내한다. 레포 밖 입력은 거부한다. codex 부서 직원 단계는 output이 `reviews/` 안(검토 단계)이면 경고("codex-review.mjs로 실행")만 하고, 그 밖(생산 단계)이면 오류다(리뷰 반영: 읽기 전용이라 output을 만들 수 없어 단계가 끝나지 않는다). BOM이 있는 파일도 읽는다.
- **validateOrg:** 반환에 `warnings`를 추가했다(`{ok, errors, warnings}`). capabilities는 40자 이하 문자열 20개 이하, handoffs는 부서 id 20개 이하이고, 없는 대상·자기 부서는 경고만 한다. 부서 API는 body에 handoffs를 보냈을 때만 없는 대상 경고를 응답 `warnings`에 붙인다(프리셋으로 첫 부서를 만들 때 경고가 쏟아지지 않게).
- **상태(buildState):** 입력에 `plans`(업무 → plan.json 요약)를 추가했다. 출력에 `flow`(최근 300개), `attention`, `metrics.attention`을 더하고, tasks에 `steps`·`stage`·`rejects`·`userRejects`·`depts`·`plan:{goal, stages:[…+status(pending|active|done|rejected)·rejects], gaps}`·`goal`·`gaps`를 붙인다. `metrics.tasks`는 active와 review를 센다. attention.gap은 완료되지 않은 업무만이다.
- **runner:**
  - 비서실장 run(답장 포함)에 조직도를 `--append-system-prompt <md>`로 넣고(인자 맨 뒤), 6000자를 넘거나 Windows `.cmd` shim(cmd.exe 경유: 줄바꿈·8191자 제한)이면 `.office/orgmap.md`(0600)에 쓰고 `--append-system-prompt-file <경로>`를 쓴다(claude 2.1.312에서 두 플래그 확인). 이때 환경변수 `OFFICE_ORGMAP_INJECTED=1`을 준다.
  - 직원 직접 지시(claude 엔진)는 `outputs/<날짜>/run-<id>/`를 만들고 `{id:'<날짜>/run-<id>', title, status:'active', created, run, agent}`로 등록한 뒤 task.start(session `office-runner`, agent 직원)를 남긴다. codex 엔진 직원은 읽기 전용 실행이라 폴더를 만들지 않는다.
  - run에 `task` 필드를 둔다. 세션 id가 오면 `.office/sessions.json`에 세션 → 업무를 기록해 훅 이벤트에 task가 붙게 한다. `start({..., task?})`, `reply(id, {..., task?})`, `latestForTask(task, sessions)`를 추가했다.
- **승인·반려 API:** 둘 다 status가 review인 업무만 받는다(아니면 409). 업무 id는 `/api/tasks/<날짜>/<slug>/approve`와 `%2F` 인코딩 모두 받는다. 반려는 그 업무의 가장 최근 실행(run.task 또는 sessions.json으로 연결된 세션)이 이어서 답할 수 있으면 reply, 실행 중이면 409, 세션이 없으면 새 비서실장 run(task 연결)이다. 응답 202 `{ok, task, run, mode:'reply'|'new'}`. 반려 프롬프트는 피드백 원문과 재배정·`flow deliver` 안내이고, 이벤트에는 redact한 요약만 남긴다. 데모 모드는 409.
- **산출물 API(모두 X-Office-Token 필요):**
  - `GET /api/outputs`: `{outputs:[{id, date, slug, title, status, hasReport, hasMeeting, hasPlan, verdicts, depts, fileCount, updated, run, agent}]}`(판정은 reviews/*.md 첫 300바이트의 VERDICT).
  - `GET /api/outputs/:taskId/files`: `{task, dir, files:[{path(outputs 기준), name, dir, group(report|meeting|plan|brief|review-notes|reviews|<부서 폴더>|other), size, mtime, kind(text|html|binary)}], truncated}`. 깊이 6, 2000개까지. 숨김 파일과 outputs 밖을 가리키는 심볼릭 링크는 뺀다.
  - `GET /api/outputs/file?path=<outputs 기준 경로>[&download=1][&as=text]`: 글자 경로와 realpath 모두 outputs 안이어야 한다(아니면 400). 텍스트류(json 포함)는 `text/plain`, html은 `text/html` + `Content-Security-Policy: sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'`(as=text면 소스 text/plain), 그 밖과 download=1은 `application/octet-stream` + `Content-Disposition: attachment; filename="<ASCII>"; filename*=UTF-8''<인코딩>`. 미리보기는 5MB까지(넘으면 413), 다운로드는 스트림. iframe은 토큰 헤더를 보낼 수 없으므로 화면은 html을 토큰으로 fetch해서 UTF-8 blob URL을 `sandbox=""` iframe(스크립트·같은 출처 비허용, `referrerpolicy=no-referrer`)에 띄운다. srcdoc은 쓰지 않는다(원문을 DOM 속성에 넣지 않는 화면 규칙). X-Frame-Options DENY는 유지한다.
  - `POST /api/outputs/:taskId/open`: 상태 변경 API 검사 + realpath 폴더를 `open`/`explorer`/`xdg-open`에 인자 배열로 넘긴다(detached, windowsHide, 셸 없음). 테스트는 `startServer({openFolder})`로 바꿔 넣는다.
  - `GET /api/orgmap`: 비서실장에게 주입되는 조직도 Markdown(text/plain). /api/state와 같은 정보라 토큰은 요구하지 않는다.
- **flow.offplan 기록 주체:** 서버가 이벤트를 읽다가 plan.set 이후의 Agent 호출(회의·반려 제외)이 계획 단계의 agent가 아니면 `flow.offplan`을 한 번 남긴다(원 이벤트 ts·instance·대상으로 중복 방지, 데모 제외). 훅은 2초 제한과 무출력 원칙 때문에 계획표를 읽지 않는다.
- **후속 구현:** "Codex 전용 모드"의 비서실장 실행·직원 역할·모델 선택은 2026-10-30 구현 상태를 따른다. "회의실 연출: 하달 킥오프"는 아래 "킥오프·입력창 승인 구현 계약"에서 반영했다.

### 통합 검증 결정 (2026-10-29)

실제 claude 오케스트레이션 2건(직원 haiku, 비서실장 sonnet, 임시 root)으로 확인하며 바꾼 계약과 이유다.

- **서브에이전트 보고서 이름 차단:** Claude Code(2.1.312)의 Write 도구는 서브에이전트가 이름이 `^(REPORT|SUMMARY|FINDINGS|ANALYSIS).*\.md$`(대소문자 무시)인 파일을 쓰면 "Subagents should return findings as text, not write report files."로 거부한다. 시나리오 ②에서 크리에이티브부 단계 산출물 `creative/summary.md`가 두 번 거부돼 단계가 실패했다. 그래서:
  - `validatePlan`이 단계 output의 파일 이름이 이 형식이면 오류로 거부하고 `<직원id>-<이름>`을 안내한다(`SUBAGENT_BLOCKED_MD`).
  - 팀장 부서 보고서 이름을 `<부서id>/summary.md`에서 `<부서id>/dept-report.md`로 바꿨다(공통 머리말·AGENTS.md·office-task·brief 배정표·presets 지침).
  - 직원 공통 머리말에 "`.md` 이름을 report·summary·findings·analysis로 시작하지 않는다. 지시·지침에 그런 이름이 있으면 `<직원id>-` 접두사를 붙여 쓰고 보고에 실제 경로를 적는다"를 넣었다. 사용자가 이미 만든 직원 지침에 `summary.md`가 남아 있어도 동작하게 하려는 것이다.
  - 비서실장(메인 세션)의 `report.md`는 대상이 아니다.
- **회의 판정 기준:** 시나리오 ②(담당 없는 짧은 요청)에서 비서실장이 "아주 짧게"를 근거로 회의 없이 혼자 분담했다. "담당이 없으면 회의"를 위 판정 기준으로 구체화해 AGENTS.md·office-task·조직도 머리말(`buildOrgMap`, 대시보드·터미널 공통)에 넣었다.
- **협조 기록 시점:** `flow cooperate`는 앞 단계가 끝난 뒤 받는 부서에 배정하기 직전에 기록한다. 시나리오 ②에서 앞 단계 배정 전에 기록해 피드 순서가 어긋났다.
- **비서실장 CLI 권한:** `.claude/settings.json`의 `permissions.allow`에 office.mjs의 `task`·`flow`·`meeting`·`plan` 하위 명령과 `codex-review.mjs`만 Bash·PowerShell 두 형식으로 둔다(예: `Bash(node scripts/office.mjs task *)`, `PowerShell(node scripts/office.mjs flow *)`). 리뷰 반영 전에는 `Bash(node scripts/office.mjs:*)`라 `org import --yes`(조직 정본 덮어쓰기)·`org export <임의 경로> --yes`도 승인 없이 통과했다. PowerShell 규칙 형식은 공식 문서(permissions: PowerShell 규칙은 Bash 규칙과 같은 모양)를 확인했다. 대시보드 비서실장 run은 `--permission-mode acceptEdits`라 Bash 허용 규칙이 없는 컴퓨터에서는 `task start`·`plan validate`·`flow` 명령이 승인 대기 없이 거부된다. chief-guard가 단독 실행만 허용하므로 허용 범위는 이 두 스크립트로 한정된다.
- **html 미리보기:** 서버 미리보기 URL 대신 blob URL + `sandbox=""` iframe으로 정했다(위 산출물 API 항목).
- **비서실장 run의 업무 연결:** 비서실장이 실행 중에 `task start`로 만든 업무는 훅이 `.office/sessions.json`에만 기록해 run에 `task`가 없었고, 산출물 탭의 "대화 스레드"가 비었다. runner가 run을 끝낼 때 `task`가 없고 세션이 sessions.json에 연결돼 있으면 그 업무 id를 `run.task`에 남긴다.
- **같은 slug 재등록:** `task start --slug`가 이미 있는 업무면 오류로 끝나는데, 예전 안내("기존 업무를 쓰거나")를 따라 비서실장이 OFFICE_TASK 없이 기존 업무에 이어 쓰면 세션이 업무에 연결되지 않아 가드·피드 연결이 빠진다(시나리오 ② 재실행에서 확인). 안내를 "`--slug <slug>-N`처럼 다른 slug로 다시 등록, 기존 폴더에 이어 쓰지 말 것"으로 바꿨다.
- **확인된 동작:** claude 2.1.312 헤드리스(-p)에서 Agent 호출은 비동기로 돌아 비서실장 턴이 먼저 끝나지만(`turn.end`), 프로세스는 직원 완료 알림을 받아 다음 단계를 이어간다. 두 시나리오 모두 deliver까지 한 run 안에서 끝났다.

### 리뷰 반영: 업무 흐름·오케스트레이션 (2026-10-29)

orchestration·security·ux 검토 지적을 재현해 고치며 바꾸거나 구체화한 계약과 이유다.

- **가드가 세션을 영구히 잠그지 않게:** 위 "업무와 세션 연결"의 연결 조건에 더해, chief-guard는 연결된 업무가 tasks.json에 없거나 `done`이면 제한하지 않는다(`decideChiefGuard(..., {getTasks})`). 해제 명령은 따로 두지 않았다. 승인으로 done이 되면 자연히 풀리고, 잘못 연결된 id는 tasks.json에 없어서 풀린다.
- **대시보드 비서실장 실행의 등록 전 단계:** runner가 비서실장 실행(답장 포함)에 환경변수 `OFFICE_CHIEF_RUN=1`을 주고, 훅은 claude 프로세스의 환경을 물려받는다. 이 값이 있으면 업무 연결 전에도 조회·조율 도구와 허용된 office.mjs 명령만 허용하고, 나머지(Write·Edit·WebSearch·WebFetch·일반 셸·Agent)는 "먼저 `task start`로 등록"을 사유로 거부한다. 터미널에서 연 세션은 지금처럼 연결 전에는 제한하지 않는다(개발 세션을 막지 않게).
- **task status 전이 규칙(office.mjs):** `--by-user` 없이(비서실장 포함)는 active↔blocked만 바꾼다. done은 대표가 대시보드에서 승인할 때(서버), review는 `flow deliver`로만 바뀌고, review·done 업무를 다른 상태로 바꾸는 것도 대표 몫이다(대시보드 반려 또는 `--by-user`). `--by-user`는 대시보드 없이 터미널만 쓰는 대표를 위한 것이고 `OFFICE_CHIEF_RUN=1`이면 거부한다. `flow deliver`는 active·blocked에서만 되고 review(중복 요청)·done(되돌리기)이면 종료 코드 1이다.
- **반려 최대 2회 강제:** `countReviewRejects(events, task)`(lib/flow.mjs)가 마지막 `flow.deliver`·`flow.user_reject` 이후의 `flow.review` 반려 수(flows)와 `[반려]` Agent 호출 수(calls)를 센다. 반려 한 번은 보통 기록과 재지시 두 이벤트라 회차는 두 값 중 큰 쪽이다. `flow review --verdict reject`는 `max(flows+1, calls) > 2`면 기록하지 않고 종료 코드 1로 "report.md 확인 필요에 적고 flow deliver"를 안내한다. chief-guard는 `[반려]` Agent 호출일 때만 events.jsonl 끝 4MB를 읽어 `max(flows, calls+1) > 2`면 거부한다. 사용자 반려 뒤에는 다시 센다(재배정을 막지 않게).
- **org 내보내기·가져오기:** 가드가 거부하고, office.mjs도 `OFFICE_CHIEF_RUN=1`이면 거부한다(이중 방어). 권한 허용 규칙에서도 뺐으므로 일반 세션에서는 Claude Code가 승인을 묻는다.
- **남는 위험(비서실장 CLI 권한):** 허용된 하위 명령 안에서는 비서실장이 사실과 다른 흐름 기록(예: 검토하지 않고 `flow review --verdict pass`)을 남길 수 있다. 상태 전이·반려 한도·org만 구조로 막고, 기록 내용의 진실성은 이벤트 기록과 사용자 확인(승인·반려)으로 확인한다. codex-review.mjs는 인자를 가리지 않고 허용한다(읽기 전용 검토, 결과는 `outputs/` 안의 reviews/만 쓴다).
- **명시 반려 단계 지정:** `flow review --verdict reject --to <부서|직원> [--stage <단계 id>]`. `--to`에 직원 id를 주면 이벤트 `to`는 소속 부서, `target`은 그 직원이다. 반려 단계 표시는 stage > target(그 직원의 진행·완료 단계) > 부서(그 부서의 진행·완료 단계가 하나뿐일 때) 순이고, 특정하지 못하면 단계 상태를 바꾸지 않고 이어지는 `[반려]` 호출의 대상 직원 단계에 맡긴다(한 부서에 단계가 여럿일 때 엉뚱한 단계가 반려되고 횟수가 두 배로 세지던 문제).
- **협조 판정 우선순위(자동 도출 표 보충):** Agent 호출이 계획표(plan.set 또는 plan.json) 단계에 걸리면, 그 단계의 앞 단계(dependsOn 전이)에 다른 부서 단계가 있을 때만 협조이고 요청 부서는 그 앞 단계 부서(가장 최근에 완료한 쪽)다. 계획 단계에 걸리지 않거나 계획이 없으면 기존 규칙(같은 업무에서 다른 부서가 앞서 완료)을 쓴다.
- **명시 협조 기록과 자동 항목:** `flow cooperate`가 지우는 자동 하달·협조 항목은 그 업무의 마지막 '앞선 완료' 이후의 것만이다. 그보다 앞선 항목(병렬 단계나 반려 전 작업으로 같은 부서에 간 정당한 하달)은 남기고 다음 Agent 호출 항목을 대신한다.
- **Codex 검증실과 계획:** orgmap의 역량 색인과 '배정 가능' 판정은 claude 부서만 센다. 근무중인 Codex 부서는 "(검토 전용)"으로 따로 적고, 그 부서뿐이면 "배정 가능한 부서가 없습니다"를 안내한다. 계획에 Codex 직원 검토 단계(output `reviews/…`)가 있으면 그 직원의 review.start/review.end가 단계 진행·완료로 반영된다. 검증실 판정(codex-review.mjs `loadReviewers`)은 부서 id가 아니라 `engine === 'codex'`로만 한다(claude 엔진으로 id `verify` 부서를 만들면 Agent 대상이면서 codex 검토자로도 실행되던 문제).
- **단계 표시줄과 반려:** 마지막 사용자 반려가 마지막 deliver보다 뒤이고 업무가 review·done이 아니면, 하달까지의 지난 도달 기록과 반려 이후 도달한 단계만 남겨 하달(또는 이후 다시 도달한 단계)을 현재로 둔다. 마지막 검토 반려가 마지막 통과·deliver·사용자 반려보다 뒤이면 같은 방식으로 진행을 현재로 둔다. 반려 횟수(rejects·userRejects)는 그대로 센다. 계획 단계 카드 상태는 되돌리지 않는다(재배정되면 그 단계가 진행으로 바뀐다).
- **작업 완료 문구:** done 항목의 결과 첫 문장은 Markdown 기호·표·코드 표시를 걷어내고 `outputs/…` 경로를 파일 이름만 남기며 앞의 '결과:'를 뗀다(`cleanResultText`). 결과에 끝내지 못했다는 표현("하지 못했", "실패했", "막혔" 등)이 있으면 "작업 종료(확인 필요)"로 쓰고 항목에 `warn: true`를 붙인다. stage는 그대로 done이다.
- **답변 대기 줄(이어서 답하기 보충):** deriveFlow는 `reply.wait`를 업무 피드 항목 `stage:'reply_wait'`(FLOW_STAGES에 추가, 단계 표시줄에는 넣지 않음, `run` 필드)로 낸다. runner의 reply.wait 이벤트에 run의 `task`를 붙인다. 화면은 아직 답하지 않은 실행이면 [대화 보기] 버튼을 단다.
- **attention.reply:** 대화(rootId)마다 needsReply인 마지막 run 하나만 올리고, 연결된 업무가 review(approve가 대신 보여준다)·done이면 뺀다. 승인 API는 그 업무에 연결된 run(run.task 또는 sessions.json 세션)의 needsReply를 끈다(`runner.clearNeedsReply(task, sessions)`).
- **사용자 반려 실행의 표시:** 반려 API가 만드는 run의 `request`는 `사용자 반려: <피드백>`(redact, 120자)이고, 실제 프롬프트는 stdin으로만 보낸다(`start/reply({..., display})`). 예전 run의 `[사용자 반려]` 요청은 화면이 "사용자 반려(피드백 전달)"로 보여준다.
- **데모 연출:** 시뮬레이터가 업무를 끝낼 때 `flow.review_request → flow.review(pass) → flow.deliver → task.update(review)`를 남기고(처음 열 때 1건), 확인 대기가 둘 이상이면 가장 오래된 것을 승인 이벤트(session `office-server`, agent 없음)로 끝낸다. 가끔 `reply.wait`(run `demo-…`)도 남기고, `buildState({demo:true})`는 최근 3분의 reply.wait를 직원별 reply attention(runId 없음 → 직원 프로필을 연다)으로 만든다. 데모에서 승인·반려·답장은 여전히 보낼 수 없다.
- **대시보드 CSP:** 정적 html 응답에 `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src blob:; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`을 붙인다(style 속성의 부서색 변수 때문에 style-src만 'unsafe-inline'). html 미리보기 blob 문서에는 맨 앞에 CSP meta를 넣는다. 서버 미리보기 CSP가 blob 문서에 닿지 않아 외부 이미지·CSS 비콘이 나가고, blob URL을 최상위 창으로 열면 sandbox가 풀려 스크립트가 대시보드 출처로 돌던 문제다.
- **실시간 피드 접기:** 업무 묶음마다 최근 6줄만 보여주고 "이전 N건 보기"로 30줄까지 펼친다(긴 업무의 최신 줄이 상자 아래로 밀려 보이지 않던 문제). 묶음 순서(최근 활동 업무가 위)와 묶음 안 시간순은 그대로다.
- **프리셋 부서 추가:** 화면은 프리셋 부서를 만들 때 handoffs를 보내지 않는다(서버가 프리셋 기본값으로 채우고, 직접 보낸 handoffs가 아니라 경고를 내지 않는다). 조직에 없는 결과 전달 부서는 id 대신 같은 id의 프리셋 이름과 "(조직에 없음)"으로 보여준다.

## 헤드리스 실행에서 백그라운드 위임 금지 (실사용 버그, 2026-10-29)

- **증상:**
  - 대시보드 비서실장 run이 마케팅 직원을 백그라운드(Agent `run_in_background: true`)로 띄웠다.
  - 비서실장은 "분석은 진행 중"이라고 답하고 종료했다.
  - 직원은 작업을 끝냈지만 다음 단계(개발부 HTML, 비서실장 검토)를 이어갈 주체가 없어 파이프라인이 멈췄다.
- **규칙:** task가 연결된 세션의 비서실장은 Agent를 백그라운드로 호출하지 않는다. 병렬이 필요하면 한 응답에서 여러 Agent를 동시에 호출하고, 모두 끝날 때까지 기다린다.
- **강제(chief-guard):** task 연결 세션에서 Agent 호출의 `tool_input.run_in_background`가 true면 거부한다. 거부 사유는 "대시보드 업무에서는 직원 작업이 끝날 때까지 기다려야 다음 단계로 넘길 수 있습니다. run_in_background 없이 호출하세요"다.
- **수칙:** AGENTS.md와 SKILL.md에 명시한다. 비서실장은 plan의 모든 단계, 검토, deliver가 끝나기 전에 최종 답변으로 종료하지 않는다.
- **검증:** chief-guard 단위 테스트에 백그라운드 거부 케이스를 둔다. 실제 실행에서는 run이 끝났을 때 모든 plan 단계가 완료됐는지 확인한다.

## Codex 전용 모드 (사용자 확정 2026-10-29: "터미널 로그인이 Codex뿐이어도 직원 구성·작업이 가능해야 한다")

### 2026-10-30 구현 상태

- `dashboard/orchestrator.mjs`와 runner가 계획(검사 실패 시 1회 수정) → 선택적 회의 → 의존 단계 실행(누락 산출물 1회 재시도) → 검증실·비서실장 검토 → 반려 최대 2회 → deliver를 진행한다. 비서실장 계획·검토는 읽기 전용이며, Codex 실행 직원은 workspace-write, 검증 직원은 read-only다. Claude 비서실장에 Codex 실행 부서가 있는 경우도 동일한 실행기를 사용한다.
- 원본 plan의 실제 산출물 경로·해시를 체크포인트에 보존한다. 재개 시 파일 변화와 변경 단계의 후속 의존성을 반영한다. 중지는 모든 내부 자식을 정리하고, 서버 종료 시 로그인 점검 프로세스도 취소한다. 승인한 업무의 기존 산출물은 재개로 덮어쓰지 않는다.
- 기존 Codex 부서에 역할 필드가 없으면 검토 역할을 유지한다(자동 쓰기 권한 확대 금지). 새 부서는 verify 프리셋이면 review, 나머지 Codex 부서는 exec를 명시적으로 저장한다.
- 로그인 상태를 비동기로 조회해 mode와 tools를 제공하고, doctor는 Claude 또는 Codex 중 하나가 로그인돼 있으면 통과한다. 화면에서 비서실장의 제공자를 직접 선택할 수 있다. 회사 모드의 별도 수동 선택 UI와 기존 부서 엔진 일괄 전환 버튼은 아래 설계의 잔여이며 이번 모델 설정 변경에는 포함하지 않는다.
- 실제 Codex 검증에서는 TXT→HTML 생성 후 로컬 브라우저 정책 때문에 최초 검토가 보류됐다. 호스트 Playwright에서 동일 파일을 렌더링·캡처하고 해시·관찰을 review-notes에 제공한 뒤 검토부터 재개해 사용자 확인 대기까지 확인했다. 이 결과를 무인 브라우저 검증 성공으로 해석하지 않는다.

### 모드 결정
- **판정 기준:** doctor 빠른 점검을 확장해 claude와 codex 각각의 설치·로그인 여부(`claude auth status`, `codex login status`)를 서버 시작 때 비동기로 판정한다.
  - claude만 있으면 `claude` 모드다.
  - codex만 있으면 `codex` 모드다.
  - 둘 다 있으면 `mixed` 모드다(현재 동작: Claude 실행 조직 + Codex 검증실).
  - 둘 다 없으면 `none` 모드다. 배너로 안내하고 실행 버튼을 끈다.
- **상태:** `/api/state.mode`와 `tools.{claude,codex}.{installed,loggedIn}`. 사용자는 회사 설정에서 모드를 수동으로 고를 수 있다(`auto` 기본). 저장 위치는 `org/company.json`이고 Git에서 제외한다.
- **부서 엔진:**
  - 새 부서의 기본 엔진은 모드를 따른다. codex 모드면 codex다.
  - codex 모드에서는 claude 엔진 부서를 경고와 함께 실행 불가로 표시하고, 엔진 일괄 전환 버튼을 둔다.
- **codex 부서 역할 필드:** `codexRole: 'exec'|'review'`. 기본값은 verify 프리셋이면 review, 그 밖은 exec다.
  - exec: `codex exec -s workspace-write -C <root>`
  - review: `-s read-only`

### runner 주도 오케스트레이션 (codex 모드 비서실장 run)
비서실장 Codex는 계획과 검토만 한다. 단계 진행은 runner가 결정론적으로 한다. 별도 모듈은 `dashboard/orchestrator.mjs`다.

1. **계획:**
   - 비서실장 codex exec(read-only) 프롬프트: orgmap + 요청 + 계획 규칙(SPEC "작업 계획표" 형식).
   - 최종 응답에서 plan JSON을 추출한다. `codex exec --output-schema` 지원 여부를 `--help`로 확인하고, 되면 쓰고 안 되면 코드 블록 JSON을 파싱한다.
   - runner가 `outputs/<task>/plan.json`을 쓰고 `plan validate`와 같은 검사를 한다. 실패하면 사유를 붙여 1회 재요청한다.
   - task 등록은 runner가 직접 한다(office.mjs 로직 재사용).
2. **회의(선택):**
   - 계획 단계에서 `needsMeeting:true`이면, 관련 팀장 2~4명에게 "범위·산출물·분담 제안"을 codex exec(read-only)로 병렬 실행한다.
   - 제안들을 비서실장 계획 프롬프트에 넣어 meeting.md와 plan을 받는다. 이벤트는 meeting.start/end다.
3. **실행:**
   - dependsOn 위상 순서로 진행한다. 독립 단계는 runner 동시 실행 한도(기본 4) 안에서 병렬로 돈다.
   - 단계마다 담당 직원의 지침(sync가 만든 developer_instructions와 같은 조립 결과)에 단계 입력·출력·완료 기준을 붙여 `codex exec --json -s workspace-write`를 실행한다. 프롬프트는 stdin으로 넣는다.
   - 이벤트는 runner가 직접 남긴다: flow assign/cooperate, accept, progress(--json item), done(마지막 메시지 첫 문장과 출력 파일).
   - 출력 파일이 없으면 그 단계는 실패로 기록하고 1회 재시도한다.
4. **검토:**
   - 비서실장 codex exec(read-only)가 산출물을 검토해 `{verdict:'pass'|'reject', stage?, reason}` JSON을 낸다.
   - reject면 해당 단계(또는 원인 단계)를 사유와 함께 재실행한다. 최대 2회다.
   - pass면 report.md를 쓰고(runner가 비서실장 요약으로 작성) deliver한다. task status는 review이고, attention은 approve다.
   - 검증실(review 역할) 직원이 있으면 codex-review도 함께 돌려 판정에 반영한다.
5. **중지·답장:**
   - 중지는 오케스트레이션 전체와 진행 중인 모든 자식 프로세스를 끝낸다.
   - 사용자 반려(피드백)가 오면 계획을 갱신하고 영향받는 단계만 재실행한다.
   - needsReply(비서실장이 질문으로 끝난 경우)는 이어서 답하기와 같은 UI로 처리한다.
6. **동시성·상태:**
   - 오케스트레이션 하나는 run 하나(target chief)이고, 그 아래 단계 run들이 parentId로 묶인다.
   - 서버를 재시작하면 진행 중이던 오케스트레이션은 failed로 표시하고 "이어서 재개"를 제공한다. 완료된 단계는 건너뛴다.

### 화면·모델·생성
- **화면:** 모드 배지(Claude / Codex / Mixed)를 단다. 조직 탭의 부서 모달에 엔진과 codexRole, Codex 모델·추론 강도를 둔다. Claude 전용 필드(tools, Claude 모델)는 codex 부서에서 숨긴다. 피드·단계 표시줄·attention은 엔진과 관계없이 같다.
- **모델:** codex 기본은 `gpt-6.1-sol`이고 effort는 `max`다(사용자 확정). 부서별로 effort를 조정할 수 있고, 프리셋 제안값은 수집·분류 직무는 medium, 분석·작성은 high, 팀장·검토는 max다. 화면에 "max는 느리고 사용량이 큼" 안내를 둔다.
- **생성:** codex 엔진 부서의 직원은 모두 `.codex/agents/<id>.toml`을 만든다(exec·review 공통). runner는 이 파일과 같은 조립 함수로 지침을 쓴다.
- **doctor:** codex만 있으면 종료 코드 0으로 "Codex 전용 모드로 실행됩니다"를 안내한다. 필수 조건을 "claude 또는 codex 중 하나 로그인"으로 바꾼다.

### 검증 요구
- 단위 테스트: 가짜 CODEX_BIN(.js)으로 계획→회의→다단계 실행→반려 1회→통과→deliver, 중지, 재개, 출력 누락 재시도를 확인한다.
- 실제 codex 1건(짧은 주제, 비용 최소화를 위해 `--effort low` 덮어쓰기 허용): 마케팅부(codex)+개발부(codex) 조직으로 "조사 → HTML → 검토 → 사용자 확인 대기"를 끝까지 돌린다.
- claude가 없는 환경 흉내: `CLAUDE_BIN`을 없는 경로로 두고 mode=codex, UI와 doctor 동작을 확인한다.

## 회의실 연출: 하달 킥오프 (사용자 확정 2026-10-29)

- **킥오프:** 업무가 하달되면 해당 인원이 회의실에 모인다.
  - 트리거는 plan.set이다. plan이 없으면 그 task의 첫 assign/cooperate가 트리거다.
  - 참석자는 plan의 모든 stage.agent와 비서실장(chief)이다. plan이 없으면 그 시점까지 배정된 직원이다.
  - 상태: deriveFlow가 `kickoff` 항목을 만들고, state에 `meetings:[{task, kind:'kickoff'|'meeting', attendees, since, until?}]`를 둔다.
    - kickoff의 until은 since + 8초다(화면 연출 시간).
    - 진행 중인 실제 회의(meeting.start~end, 또는 `[회의]` Agent 호출 진행 중)는 until이 없다.
- **사무실 캔버스:**
  - 참석자가 자기 자리에서 회의실로 걸어간다. 회의실 테이블 주위 좌석에 앉는다. 인원이 좌석보다 많으면 회의실이 커지거나 서 있는 자리를 둔다.
  - 비서실장은 상석에 앉고, 말풍선에 업무 제목을 표시한다.
  - kickoff가 끝나면 각자 자리로 돌아가 작업 애니메이션을 시작한다. 실제 회의는 meeting.end까지 머문다.
  - 회의실이 사용 중이면 다음 회의는 대기했다가 순서대로 연다(큐). 대기 중인 업무는 피드에 "회의실 대기"로 표시한다.
- **협조 연출:** cooperate가 일어나면 두 부서 담당자가 회의실(또는 두 방 사이 복도)에서 만나 서류를 넘기는 3초 연출을 보여준다.
- **피드:** kickoff 항목 문구는 "비서실장: ○○ 업무 킥오프 — 참석 김팀장, 최대리"다.
- **테스트:** deriveFlow의 kickoff·meetings 도출(plan 있음/없음, 동시 업무 큐), office.js의 좌석 배치 순수 함수(참석자 수별)를 테스트한다.

## 비서실장 입력창의 승인·반려 인식 (실사용 피드백, 2026-10-29)

- **증상:** 사용자 확인 대기 업무가 있을 때 사용자가 상단 비서실장 입력창에 "승인"이라고 썼다. 이 입력이 새 비서실장 run으로 전달됐고, 비서실장은 완료 처리 권한이 없어 처리하지 못했다.
- **규칙:** 화면이 입력을 run으로 보내기 전에 다음과 같이 판정한다.
  - 입력이 승인 의도면 승인 API로 처리한다. 예: `승인`, `승인해`, `승인합니다`, `통과`, `OK`, `좋아 승인`.
  - 입력이 반려 의도면 피드백과 함께 반려 API로 처리한다. 예: `반려 …`, `다시 해 …`, `수정해 …`.
  - review 상태 업무가 1건이면 확인 대화상자("'…' 업무를 승인할까요?")를 거쳐 `POST /api/tasks/:id/approve|reject`로 처리한다. 2건 이상이면 대상 업무를 고르게 한다.
  - review 업무가 없거나 판정이 애매하면 기존대로 run으로 보낸다.
  - 판정 함수는 순수 함수로 두고 테스트한다.
- **비서실장 수칙:** run 안에서 사용자가 승인·반려 의사를 밝히면 다음과 같이 처리한다.
  - "대시보드의 [승인]·[반려] 버튼이나 입력창에서 처리됩니다"라고 한 줄로 안내한다.
  - 반려 피드백이면 그 내용을 반영해 재배정한다.
  - 완료 처리는 하지 않는다(기존 원칙 유지).

### 킥오프·입력창 승인 구현 계약 (2026-10-29)

위 두 절과 PR #1 리뷰 잔여 2건을 구현하며 구체화한 계약이다.

- **kickoff 항목:** `FLOW_STAGES`에 `kickoff`를 넣고 단계 표시줄에서는 '하달'로 센다. 업무마다 한 번이다(계획표를 다시 검사해도 다시 열지 않는다). 계획표 파일(plan.json)만 있고 plan.set이 없으면 첫 하달·협조 때 계획의 담당으로 연다. 계획표가 없을 때 첫 배정 뒤 3초 안의 배정(한 응답의 병렬 호출)은 참석자로 더한다. 회의·반려 호출은 트리거가 아니다. 참석자 이름은 직원 이름만 쓰고 6명이 넘으면 "외 N명"이다.
- **meetings:** `deriveTaskFlows`가 회의실 기록(`meetings`: 킥오프, meeting.start~end, `[회의]` 호출~참석자 전원 의견 제출)을 내고, 순수 함수 `scheduleMeetings(meetings, now)`가 대기열을 적용한다. 킥오프는 요청 순서대로 8초씩 열고, 미뤄지면 `requested`(원래 요청 시각), 아직 안 열렸으면 `waiting: true`다. 끝 기록이 없는 실제 회의 뒤의 킥오프는 여는 시각을 몰라 since가 요청 시각이고 until이 없다. 실제 회의는 미루지 않고, 끝 기록이 없어도 30분 뒤 끝난 것으로 본다. 끝난 회의는 state에서 뺀다. meeting.start의 부서 id 참석자는 그 부서 팀장으로 바꾼다.
- **화면 시계:** 사무실 캔버스는 state.meetings의 since·until을 화면 시계로 다시 판정한다(서버 상태 주기 5초를 기다리지 않고 8초에 맞춰 해산·다음 킥오프). 좌석은 `meetingSeats(n, room)`(상석 1 + 테이블 11 + 방 안 선 자리 + 문 밖 복도, 넘치면 비켜 겹침)이고 회의실 크기는 바꾸지 않는다. 걷는 중에 목적지가 바뀌면 지금 위치(방 안 또는 복도)에서 경로를 다시 짠다.
- **협조 연출:** 보낸 부서에서 그 업무를 마지막으로 끝낸 직원(없으면 그 부서의 쉬는 직원)과 협조 대상 직원이 받는 부서 문 안쪽에서 만나 3초간 서류를 넘긴다. 둘 중 하나라도 휴무·회의·검토 중이면 예전처럼 서류만 날아간다. 25초 안에 만나지 못하면 접는다.
- **입력창 판정:** `classifyChiefInput`은 입력 전체가 승인 표현(앞의 '좋아'·'네' 허용)일 때만 승인, '반려'·'다시 해'·'수정해'로 시작하면 반려(뒤 문장이 피드백)다. ?로 끝나는 질문, '승인하지 마' 같은 부정, 승인·반려(ok·오케이 포함)가 섞인 입력은 애매로 본다. 반려 표현 뒤의 말이 부정·취소('하지', '안 해', '말고', '마', '취소', '철회', '보류', '아니', 'ㄴㄴ' 등)로 시작하거나 물음표 없이 물음 어미('볼까', '줄래' 등)로 끝나도 애매다(리뷰 반영: 띄어 쓴 '반려 안 해'가 피드백 '안 해'의 반려로 잡혔다). 피드백 없는 반려는 사용자 확인 창을 열어 피드백을 받는다. 확인 대화상자에서 취소하면 아무것도 보내지 않고 입력을 남긴다.
- **산출물 없는 완료(PR #1 리뷰 잔여):** 서버가 상태를 만들 때 계획표 단계 output 존재를 확인해(`planOutputStatus`, 업무 폴더 안·실제 경로 기준, 완료된 업무와 데모는 생략) `buildState({outputs})` → `deriveTaskFlows({outputs})`로 넣는다. 완료 단계인데 파일이 없으면 단계 상태가 `done_missing_output`(화면 '완료(산출물 없음)')이고, tasks[].missingOutputs와 그 업무의 검토 요청 줄(`warn`)에 표시한다. deriveFlow는 파일을 읽지 않는다. 확인은 `plan.json` 원본 경로로 한다(validatePlan과 같은 해석). compactPlan 요약은 공백을 줄이고 160자로 자르고 비밀값 모양을 가려 실제 경로와 다를 수 있어서다(리뷰 반영). 화면 계획표(plan.set 이벤트)와 원본의 단계 output이 다르면 그 단계는 확인하지 않는다. output이 폴더면 안에 숨김이 아닌 파일이 하나라도 있을 때 있음이다. task files도 같은 원본 경로로 확인한다.
- **task files(PR #1 리뷰 잔여):** `node scripts/office.mjs task files <업무> [--json]`은 업무 폴더 파일 목록·크기와 계획 단계 산출물 있음/없음을 출력하는 읽기 전용 명령이다(깊이 6, 2000개, 숨김 파일·outputs 밖 심볼릭 링크 제외 — 산출물 API와 같은 `lib/outputs.mjs`). chief-guard 허용 하위 명령에 넣었고, `.claude/settings.json`의 `task *` 허용 규칙에 이미 포함된다.
- **데모:** 시뮬레이터가 업무마다 비서실장 세션을 따로 두고, 계획표가 있는 업무에 plan.set(서로 다른 부서 2~3단계, 둘째 단계는 첫 단계를 이어받음)을 남겨 킥오프·회의실 대기·협조 연출을 보여 준다. 계획 밖 직원 작업은 업무에 묶지 않는다(계획 밖 경고·협조 요청이 쌓이지 않게).

## 작업 공간 분리 (사용자 확정 2026-10-29, 별도 PR)

- **문제:**
  - AI 직원의 작업 폴더(cwd)가 대시보드 프로그램 레포와 같아서, 직원이 프로그램 코드를 고칠 수 있었다. 실사용에서 비서실장이 대시보드 승인 API 수정 업무를 등록했다.
  - 개인 데이터가 레포 안에 있어 업데이트(git pull)와 충돌하거나 섞일 위험이 있다.
- **구조:**
  - **프로그램 레포:** 코드, presets, templates, 훅 스크립트, 수칙 템플릿.
  - **작업 공간(workspace):** 회사 데이터와 AI 실행 위치. 기본 경로는 `~/AIOffice`(Windows는 `%USERPROFILE%\AIOffice`)다. 바꾸려면 `AI_OFFICE_WORKSPACE` 환경변수나 `npm run office -- --workspace <경로>`를 쓰고, 선택은 프로그램 레포의 Git 제외 파일 `.office-local.json`에 기억한다.
  - 작업 공간에 두는 것:
    - 데이터: `org/`(departments.json, roster.json, company.md, company.json), `outputs/`, `.office/`
    - 생성물: `.claude/agents/`, `.claude/settings.json`, `.codex/agents/`, `CLAUDE.md`, `AGENTS.md`
- **생성물 처리:**
  - sync가 작업 공간의 수칙과 설정을 프로그램 레포의 템플릿에서 생성한다.
  - 훅 명령은 프로그램 레포 훅의 절대경로를 exec 형식 args로 넣는다. 경로에 공백이 있거나 Windows 경로여도 안전해야 한다.
  - 생성 표식이 있는 파일만 갱신하고, 사용자가 직접 만든 파일은 보존한다.
- **실행:**
  - runner, codex-review, office CLI, 오케스트레이터는 모두 cwd를 작업 공간으로 두고 실행한다. codex는 `-C <workspace>`, `-s workspace-write`면 작업 공간 안에서만 쓴다.
  - 서버는 시작할 때 작업 공간이 없으면 만들고 초기화한다(빈 회사).
  - doctor와 화면의 회사 설정에 작업 공간 경로를 표시한다. "폴더 열기"도 제공한다.
- **보호:**
  - chief-guard를 확장해, 모든 에이전트(직원 포함)의 Write/Edit/MultiEdit가 프로그램 레포 경로를 대상으로 하면 거부한다.
  - Bash 명령 문자열에 프로그램 레포 절대경로를 쓰는 쓰기 패턴(`>`, `tee`, `rm`, `mv`, `cp` 대상)도 최선 노력으로 거부한다. 이 한계는 README에 밝힌다.
- **마이그레이션:**
  - 새 버전 첫 실행에서 프로그램 레포 안에 기존 데이터가 있으면 화면 배너와 `npm run migrate`로 이전을 제안한다. 대상: `org/departments.json`·`roster.json`·`company.md`, `outputs/`, `.office/`, `.claude/agents/`, `.codex/agents/`.
  - 이전 방식: 복사 → 검증(파일 수·크기) → 원본은 `.office-migrated-<날짜>/`로 옮긴다. 자동 삭제하지 않는다.
  - 사용자가 확인하기 전에는 이전하지 않는다. 이전하지 않으면 기존 위치를 계속 쓰는 호환 모드로 동작하고, 배너를 계속 띄운다.
- **테스트:**
  - 임시 workspace로 전 경로를 확인한다(서버, runner cwd, sync 생성 위치, 훅 절대경로 args, guard 거부, migrate 복사·검증·보존).
  - Windows 경로는 platform 주입으로 확인한다.
  - 레포에서 `git status`가 깨끗하게 유지되는지 확인한다.
- **PR 순서:** ① 현재 묶음 → ②(회의실 킥오프)와 ④(작업 공간 분리)는 파일이 거의 겹치지 않아 병렬로 진행 → ③(Codex 전용 모드)은 ④ 위에서 진행한다. 새 runner·오케스트레이터가 처음부터 작업 공간 기준으로 동작하게 하기 위해서다.

### 작업 공간 분리 구현 계약 (2026-10-29)

- **경로 결정(`lib/paths.mjs` `resolveWorkspace`):** `AI_OFFICE_WORKSPACE` > `--workspace` > 프로그램 레포의 `.office-local.json`(`{workspace}`) > 호환 모드 > 기본값(`~/AIOffice`, Windows `%USERPROFILE%\AIOffice`). 예전 테스트·내부용 `AI_OFFICE_ROOT`는 사용자 셸의 `AI_OFFICE_WORKSPACE`가 테스트 임시 작업 공간을 덮지 않도록 가장 앞 순위로 받는다. 작업 공간이 프로그램 레포와 같거나 그 안·상위면 `WorkspaceError`(대소문자 무시 비교는 win32). 반환 `{path, source:'env'|'arg'|'local'|'compat'|'default', compat, legacy}`.
- **호환 모드:** 사용자가 작업 공간을 고르지 않았고(위 앞 세 단계 없음) 기본 작업 공간에 표식(`.ai-office-workspace`)이 없으며 레포 안에 예전 회사 데이터(`org/departments.json`·`roster.json`·`company.md`·`company.json`, 비어 있지 않은 `outputs/`·`.claude/agents/`·`.codex/agents/`)가 있으면 레포를 데이터 위치로 쓴다. `.office/`만 있는 경우(레포에서 연 개발 세션의 훅 이벤트)는 세지 않는다. 기본 작업 공간이 이미 준비돼 있으면 레포에 예전 항목이 다시 생겨도 기본 작업 공간을 쓰고 `legacy`로만 알린다(이전한 회사 데이터가 화면에서 사라지지 않게). 호환 모드에서는 작업 공간 생성물을 만들지 않고 레포의 CLAUDE.md·AGENTS.md·`.claude/settings.json`(`${CLAUDE_PROJECT_DIR}` 훅)·스킬을 그대로 쓴다. 이 파일들이 작업 공간 생성물의 원본이다(정본 하나).
- **생성물(`lib/workspace.mjs` `syncWorkspace`/`ensureWorkspace`):** `.ai-office-workspace`(표식), `CLAUDE.md`, `AGENTS.md`(레포 AGENTS.md + 프로그램 경로 머리말), `.claude/skills/office-task/SKILL.md`, `.claude/settings.json`(레포 설정의 `${CLAUDE_PROJECT_DIR}/hooks/X`를 프로그램 레포 훅 절대경로로 바꾼 exec 형식), `scripts/office.mjs`·`scripts/codex-review.mjs`(연결 스크립트: 자기 위치의 상위 폴더를 `AI_OFFICE_WORKSPACE`로 두고 프로그램 스크립트를 실행). 그래서 수칙·허용 명령·chief-guard의 `node scripts/office.mjs …` 단독 실행·세션 연결 검사가 작업 공간에서도 그대로다. 텍스트 생성물은 `ai-office:generated` 표식(스킬은 frontmatter 다음 줄), JSON 설정은 `.claude/ai-office-generated.json`에 기록한 해시와 같을 때만 생성물로 보고 갱신한다. 서버 시작(데모 제외)·`npm run sync`·migrate가 `ensureWorkspace`(폴더 생성 + 생성물 + `syncAgents`)를 부른다. `sync --check`는 표식이 있는 작업 공간만 생성물을 검사한다.
- **프리셋·템플릿:** `loadPresets(root)`와 부서 템플릿은 작업 공간에 같은 파일이 있으면 그것을, 없으면 프로그램 레포의 것을 쓴다.
- **실행:** runner의 모든 spawn은 cwd가 작업 공간이다. `startReview`는 프로그램 레포의 `scripts/codex-review.mjs`를 `AI_OFFICE_WORKSPACE=<작업 공간>`으로 실행한다(호환 모드는 환경변수 없음). codex는 `-C <작업 공간>`.
- **훅:** 데이터 위치는 `CLAUDE_PROJECT_DIR`가 표식이 있는 작업 공간이거나 예전 방식 레포(`hooks/<자기 파일>` 있음)면 그곳, 아니면 훅 파일 위치(프로그램 레포)다.
- **보호(`lib/chief-guard.mjs` `decideRepoGuard`):** chief-guard 훅은 데이터 위치가 프로그램 레포와 다르면 직원 판정보다 먼저 모든 에이전트에 적용한다. Write·Edit·MultiEdit·NotebookEdit 대상(cwd 기준 상대경로·`~` 포함, 실제 경로로 비교)이 레포 안이면 거부한다. Bash·PowerShell은 `shellWriteTarget`이 따옴표를 묶어 구간을 나눈 뒤 리다이렉션 대상, rm·mv·touch·tee·sed -i·Set-Content·Remove-Item 등의 인자, cp·Copy-Item·ln 등의 대상(마지막 인자·`-t`·`-Destination`), `cd`로 옮긴 폴더나 `git -C`에서의 git 쓰기 명령, 파일 쓰기 API 이름과 레포 경로 문자열이 함께 보이는 인라인 스크립트를 거부한다(최선 노력, README "한계").
- **migrate(`lib/migrate.mjs`, `scripts/migrate.mjs`, `npm run migrate [-- --workspace <경로>] [--yes] [--dry-run] [--force]`):** 대상은 위 예전 데이터와 `.office/`(`.office/server.lock` 제외). 작업 공간에 같은 이름의 다른 파일·링크가 있으면 아무것도 바꾸지 않고 종료 코드 1. 같은 종류·크기·내용(링크는 같은 대상)의 복사본은 끊긴 이전의 결과로 보고 건너뛴다(재실행으로 이어서 하기, 되돌릴 때도 지우지 않음). 프로그램 레포나 대상 작업 공간의 `.office/server.lock`(서버가 listen 뒤 `{pid, port, host, id}`를 남기고 close 때 자기 id면 지움) pid가 살아 있으면 거부(`--force`로 무시). 복사(덮어쓰기 금지, 심볼릭 링크는 따라가지 않고 링크로 복사) → 항목별 파일 수·전체 크기·파일별 크기 검증(실패하면 이번에 복사한 것만 되돌림) → 대상 작업 공간을 `.office-local.json`에 기억(기본 경로 포함, 원본 이동 전) → 원본을 레포의 `.office-migrated-<KST 날짜>[-N]/`로 rename(실패해도 지우지 않음). 대화형 확인이나 `--yes`가 없으면 바꾸지 않는다. CLI는 이전 중 받은 SIGINT·SIGTERM·SIGHUP(Windows SIGBREAK)을 끝난 뒤로 미룬다. 끝나면 `ensureWorkspace`.
- **표시:** `/api/state.workspace = {compat, legacyPending}`(경로 없음), `GET /api/company`에 `workspace:{path, source, label, compat, legacyPending}`(토큰 필요), `POST /api/workspace/open`(상태 변경 API 검사, 셸 없는 open/explorer/xdg-open). 화면은 호환 모드·예전 데이터 남음이면 닫기 없는 배너로 `npm run migrate`를 안내한다. doctor는 `workspace` 항목(필수 아님)에 경로·출처를 보이고, 호환 모드·예전 데이터면 ⚠와 `npm run migrate`를 안내한다.
- **Git:** `.office-local.json`, `.office-migrated-*/`를 `.gitignore`에 넣는다.


## 2026-10-30 의도 감사 후 업무 실행 계약

이 절은 위 과거 구현 기록 중 비서실장·부서 분담·기본 전문 검토에 관한 이전 제한을 대체한다. 아래의 경로·엔진 보완 계약은 이 절의 동일 항목보다 우선한다.

- 대시보드 chief 실행은 Claude·Codex 모두 제어 실행기를 거친다. 최종 검토자는 기본 chief이며 검토 전용 부서 유무와 관계없이 대표 보고를 맡는다. `plan.review.by`가 명시적으로 codex/검토 직원 id일 때만 추가 검토를 실행한다.
- 체크포인트 v2는 최초 요청과 질문·답변 이력을 가림 처리해 비공개(디렉터리 0700/파일 0600)로 보존한다. 공개 상태·이벤트는 요약만 제공한다. 계획 전 질문도 먼저 저장한다. 결정 답변은 같은 계획의 대기 단계부터 재개하고, 검토 중 질문은 완료 단계를 반복하지 않는다. 옛 체크포인트에 없는 요청 전문은 복원 대상이 아니다.
- stage 응답은 `done/needs_decision/reroute/delegate`. 질문·분담·이관을 파일 누락 재시도로 처리하지 않는다. 가능한 독립 단계는 진행하며 의존 단계만 기다린다. 팀장은 같은 부서의 다른 근무중 실행 직원 1~6명에게 한 번 분담할 수 있다. 하위 단계 완료 후 원래 팀장 단계가 취합한다. 계획은 최대 30단계·순환 금지, 실제 CLI는 전역 최대 4개다.
- `handoffPolicy`는 suggested(기존 기본)/required다. 필수 부서는 실제 후속 의존 경로로 연결되어야 한다. 필수 대상의 누락·자기 참조·순환 설정은 거부한다. 오전달은 chief의 route JSON과 근무 상태/역할/계획 검사로 재배정하며 원인 단계와 의존 단계만 무효화한다. 재배정 2회 또는 충돌은 대표 결정으로 올린다.
- 파일은 비어 있지 않아야 한다. HTML은 문서/title/body/viewport/최소 본문을 검사하고 비개발자 보고서 품질 기준을 작성·검토에 주입한다. 사실 검증·시각 품질은 최종 chief 판단과 실제 검증 근거가 필요하다.
- UI select는 폼 값 정본을 유지하는 DOM combobox/listbox다. 목록은 선택 상자에 붙여 viewport 안에 배치하고, 모달의 목록은 그 모달에 속하게 해 inert 클릭 차단을 피한다. 키보드·모바일·테마·저장과 실제 펼침 상태를 Playwright로 검증한다. 개발 검증 스크립트는 임시 조직과 가짜 CLI 상태 점검만 사용하며 실제 AI·회사 데이터에 작업을 지시하지 않는다.
- 이 감사 시점에는 감시·외부 발송 연결을 제외했으며, 이후 사용자 요청에 따른 구현 계약은 다음 절을 따른다.

## 2026-10-30 지속 감시·계정 연결·최종산출물 계약

- 시간 미지정 감시는 사용자 중지까지 유지한다. 숫자 기간 또는 한국 시간의 명시 종료 시각은 최초 시작 때 절대 시각으로 저장한다. 기본 조회 간격은 5분, 명시 간격은 10초~24시간이다. 실행기는 한 차례 조회하는 직원 CLI를 주기적으로 호출하며 AI 프로세스 자체에 무한 반복을 맡기지 않는다. 기술 오류는 지연 재시도하며, 실제 대표 결정은 알림으로 대기한다.
- `.office/continuous/<rootId>.json`에 원래 요청·결정·커서·자료 키·후속 업무·종료 시각을 비공개로 보존한다. 같은 자료 키는 다시 전달하지 않는다. 새 자료별 후속 유한 업무는 감시와 독립적으로 실행하며 정상 수집 중 두 묶음까지 보고한다. 나머지는 보존하고 수집 종료 때 전역 CLI 대기열로 넘긴다. 모든 실제 CLI의 합계는 4개 이하다. 후속 보고의 사용자 결정은 해당 카드에서 이어진다.
- 서버 종료는 복구 가능한 일시 중단, 사용자 중지는 영구 중지다. 서버 시작 시 원래 기한·기록으로 재개하고 대표 결정 대기는 자동 재개하지 않는다. 결정 대기 중 기한이 지나면 추가 AI 호출 없이 마감한다. macOS 감시 중에는 소유자 수로 관리하는 caffeinate로 자동 유휴 잠자기를 억제한다. 서버·네트워크 중단, 수동 잠자기나 다른 OS 전원 관리까지 가용성을 보장하지 않는다.
- 계정 연결은 NAVER WORKS, NAVER, Kakao 제공자별 전용 Playwright persistent Chromium 프로필을 사용한다. 프로필과 IndexedDB·localStorage·session cookie 보완 상태를 다음 프로세스에서 재사용한다. 최초 로그인·추가 인증은 사용자가 전용 창에서 완료하고 연결 확인을 누른다. 선택한 아이디·비밀번호만 로컬 AES-256-GCM으로 저장하며 키도 같은 로컬 OS 계정 소유 파일이다. 완전한 별도 보안 금고는 아니다. 인증 파일은 작업 공간 밖 `~/.config/ai-office/private/<정규 작업공간 경로 해시>/`에 두고 0700/0600·Git 제외를 적용한다. 사이트가 인증을 무효화하면 재연결이 필요하다.
- 지원 외부 작업은 네이버웍스 메일, 네이버 블로그·카페, 다음 카페, 티스토리·브런치의 해당 게시글·댓글이다. SMS는 제외한다. 대표가 지시한 동작만 publications 계획에 넣고 검토된 원문을 발행한다. 조사 후 결정되는 업체별 메일은 검토 산출물의 `messages:[{recipients,subject,body}], skipped:[사유]`를 확장하며 수신자별 개별 발송한다. 원문 형식 오류는 내부 반려 과정으로 수정한다.
- 실행별 `office_browser` MCP는 계정·대상·검토된 원문에 한정한 화면 조회·이동·입력·등록 도구만 제공한다. 비밀번호·쿠키·임의 JS 실행 도구는 제공하지 않는다. 로그인 자동 입력은 제공자 인증 호스트에만 한정한다. 임시 권한 파일은 업무 종료 시 삭제한다. 실제 발행 확인 증표를 `.office/publications/`에 저장하고 확인된 재실행은 건너뛴다. 결과가 불명확하면 재전송하지 않으며 사용자 확인 후 이어간다. 재연결만 필요할 때는 승인된 검토·완료 단계를 재실행하지 않는다.
- Playwright는 운영 의존성이다. npm ci가 필요하며 설치된 Chrome을 우선 사용하고 없으면 설치한 Playwright Chromium으로 실행한다. 검증은 실제 계정·AI 호출 없는 가상 로그인과 로컬 사이트에서 한다. 실제 서비스별 권한·화면·추가 인증은 사용자 최초 연결 후 별도 확인 대상이다.
- 최종 전달 위치는 기본 `작업 공간/최종산출물/날짜/업무명--업무slug/`다. 회사 설정의 저장 상위 폴더로 변경할 수 있다. `.office/final-outputs/settings.json`과 index.json이 위치·등록 파일·해시를 보존하며 이 절대 경로는 공개 상태에 싣지 않는다. 변경은 다음 전달부터 적용하고 기존 파일을 이동·삭제하지 않는다.
- `plan.deliverables`는 대표에게 전달할 단계 id 또는 해당 산출물 경로다. 명시한 빈 배열은 첨부 없음, 필드가 없는 옛 계획은 후속 의존이 없는 단계 산출물을 사용한다. 계획 밖 파일·업무 밖 symlink는 거부한다. 최종 보고와 선택한 파일, HTML/CSS의 업무 내부 참조 자산만 복사한다. 사용자가 전달 파일을 수정했으면 그대로 보존하고 개선본은 해시를 붙인 이름으로 따로 저장한다. 중간 원본은 outputs에 보존한다.
- 대시보드·터미널의 검토 후 전달 시 모으며, 옛 review/done 업무는 산출물 목록 조회 시 보고서와 완성 파일이 있는 것만 정리한다. 산출물 화면은 최종산출물을 먼저 보여 주고 ‘전체 업무 자료’로 중간 업무를 확인한다. 상세 화면의 중간 계획·대화·자료는 접어서 제공하고, 폴더 열기는 등록된 최종 폴더를 연다. 파일 조회 API는 등록 파일 목록·실제 경로·인증을 검사한다.

## 2026-10-30 재개: 원본 경로·실무와 검토·직원 첫 로그인

- 계획의 output 계약은 기존 업무 폴더 상대·`outputs/…`·업무 내부 절대 경로를 유지한다. inputs는 단계 id를 우선하고, 업무 상대 파일·예정 산출물 경로가 있으면 기존 해석을 유지한다. 그렇지 않으면 작업 공간 상대 원본을 찾는다. 직원 실행 전 파일 입력을 절대 경로로 정규화해 저장·재개·분담·재배정에서 같은 파일을 쓴다. 작업 공간 밖 입력은 거부하고 누락 진단에는 실제 검사 경로를 적는다. 계획 프롬프트에도 작업 공간 cwd와 원본 확인·내부 수정 원칙을 전달한다.
- 회사 `chief` 저장값과 상단 선택은 최종 검토 설정이다. 기본 Codex 모델·effort와 기존 저장값을 보존한다. Claude가 설치·로그인돼 있으면 계획·조율은 Claude Opus/high다. Claude 미사용 또는 명시 Codex 모드에서는 Codex로 계획한다. 직원 엔진·모델은 정본을 따르며 새 실무 부서는 사용 가능한 Claude가 기본이다. 검토 설정만을 이유로 실무 부서를 Codex로 만들지 않는다. CLI 상태 미확인 상태를 Claude 불가로 단정하지 않는다.
- 직원 외부 작업은 저장된 인증이 있는 disconnected 계정도 첫 로그인을 시도할 수 있다. 업무 브라우저는 기본 화면 표시이며 전용 프로필·계정 직렬 실행은 유지한다. NAVER WORKS의 `#user_id` → 다음 → 비밀번호 단계에 대응하고 단계마다 공식 HTTPS 인증 호스트를 확인한다. CAPTCHA·추가 인증은 사용자 결정으로 남긴다. 실제 서비스의 인증·발송 성공은 로컬 가상 화면 검증과 별도 증거가 있어야 한다.
- 서비스 화면 이후 늦은 인증 이동도 같은 직원 브라우저에서 처리한다. 이미 인증 화면이면 먼저 자동 로그인을 마치며, 전송 시도 뒤에는 자동으로 이동·재로그인하지 않는다. 추가 인증이 남으면 직원 창을 유지해 사용자가 연결 완료로 이어갈 수 있게 한다.
- Claude 외부 작업은 정본에서 조립한 동일 직원 지침·모델을 CLI 실행별 agent 정의로 사용한다. `--allowedTools`만으로는 직원 파일의 도구 목록 밖 MCP가 노출되지 않으므로 Read/Glob/Grep와 해당 실행의 `office_browser` 도구 이름을 명시한다. 전역 신뢰·훅·저장된 직원 파일을 바꾸지 않는다. 화면 query는 여러 단어와 연결 label을 검색하고 일치하지 않으면 전체 ref 목록으로 되돌린다. 입력에는 현재 snapshot의 r숫자 ref만 사용한다.
- 과거 미발송 상태·재발송 금지를 최초 발송 철회로 해석하지 않는다. 외부 발송이 없다는 열거형 지시는 발송 요청으로 만들지 않으며, 실제 금지·미발송 확인·재발송 지시는 각각 적용한다. 검토를 통과한 뒤의 연결 오류는 publish 대기로 저장한다. 명시 재개 시 옛 plan 분류의 오류도 기존 계획을 재검사하고 파일 해시·현재 권한·검토 서명이 유효한 결과를 재사용한다.

## 2026-10-30 사용자 확정: 승인 없는 완료·결과 모달·내역 정리

이 절은 과거 사용자 승인 단계·완료 조건과 해당 UI 계약을 대체한다.

- 비서실장 검토·최종 산출물 저장이 끝나면 done/completedAt으로 자동 완료한다. CLI의 flow deliver도 검토 통과와 보고서를 요구하고 같은 상태로 끝난다. 기존 review 중 보고서·등록된 최종 파일이 확인되는 업무는 완료로 전환한다. 외부 작업의 사용자 지시·실제 결과 증표 요건은 유지한다.
- complete 알림은 비서실장 문서 아이콘과 결과 모달을 연다. 새 완료는 다른 대화상자가 없을 때 자동 표시하고 대화상자 사용 중에는 대기한다. 완료 보고·최종 파일만 보여 주며 단계표·계획·중간 자료·승인/반려 입력은 제외한다. 닫기는 POST /api/tasks/:id/seen으로 읽음만 기록한다. 과거 승인 API는 이전 클라이언트 호환용이며 새 완료 흐름에는 사용하지 않는다.

- HTML 새 탭은 부모에서 인증해 읽은 전체 원문을 CSP가 적용된 Blob으로 연다. opener와 스크립트·외부 리소스 접근을 제한하고 인증 값을 URL로 전달하지 않는다. 팝업 실패·파일 조회 실패는 사용자에게 알린다.
- DELETE /api/history는 인증·Origin·데모 제한을 적용한다. 종료 대화/로그와 끝난 체크포인트를 정리하고 완료 업무는 historyArchivedAt으로 목록에서 제외한다. 진행·결정 대기·재개 예정 감시와 연결된 후속 대화는 보존한다. 최종 산출물·원본·계정·발송 증표와 산출물 조회용 업무 메타데이터는 보존한다. 공유 이벤트는 실행 중 append와 충돌하지 않게 cutoff 표시 기준으로 정리한다. 초기화는 사용자가 버튼을 누를 때 수행한다.
- 지시 폼은 설명문과 별도 영역을 두고 설명은 항상 폼 아래에 배치한다. 1366·1024·390px에서 입력 너비·버튼 접근·페이지 넘침을 확인한다.

## 매일 반복 예약·영상 게시 이력

- 회사 설정의 ‘반복 업무 예약 → 반복 예약 설정’에서 관리한다. 상단 반복 예약은 같은 화면의 바로가기다. 예약을 저장하면 바로 적용하며 뒤의 회사 규칙 저장과 독립적이다. 회사 설정에서 예약을 열고 닫아도 입력 중인 공통 규칙을 보존한다.
- `lib/schedules.mjs`는 Asia/Seoul 시각의 매일 예약을 `.office/schedules.json`에 원자적으로 저장한다. 예약당 시각·지시·검토 AI·다음 시각·마지막 날짜별 실행을 보관한다. `POST /api/runs`의 비서실장 지시가 “매일 오전 11시에 …” 형태면 `{scheduled:true,schedule}`를 반환하고 즉시 AI를 실행하지 않는다. 모호한 시각은 400이다. `schedule:false`는 명시적인 1회 실행에 사용한다.
- 토큰을 요구하는 `GET /api/schedules`, 기존 토큰/Origin 보호가 적용되는 `POST /api/schedules`·`PUT /api/schedules/:id`·`DELETE /api/schedules/:id`로 관리한다. 본문은 `prompt,time(HH:mm),chief?`이며 수정에서 `enabled`를 받을 수 있다. 공개 상태에는 짧게 가린 지시·시각·상태만 포함한다.
- 서버가 1초마다 시각을 확인한다. 시작 전에 날짜별 시도를 기록해 재시작 후 같은 회차를 자동 재실행하지 않는다. 부팅 시 지난 시각과 1분을 넘긴 지연은 건너뛰며 누적 실행하지 않는다. 이전 예약의 running/queued/needsReply 실행이 있으면 다음 회차를 겹치지 않는다. 수정·재개는 다음 미래 시각부터 적용하고 중지/삭제는 실행 중 업무를 취소하지 않는다.
- 실행·답장에 `schedule:{id,slot,uniqueYoutube?,minPosts?,maxPosts?}`를 보존한다. 유튜브 카페/블로그 예약은 기본 하루 2~3개(지시에서 1~20개 범위 조정)이며 제외 ID 스냅샷을 업무 폴더의 `video-exclusions.json`으로 전달한다. 후보 부족·0개는 사유와 실제 개수로 보고한다.
- 게시 문안의 JSON `{posts:[{subject,body}],skipped:[사유]}`를 `preparePublications`가 글별 작업으로 확장한다. 기존 메일 `messages`와 단일 문안도 유지한다. post 증표 키에는 publication id를 포함해 같은 회차의 같은 게시판에 서로 다른 글을 전달할 수 있다. 기존 증표 파일이 있으면 그 파일의 재발송 보호를 유지한다.
- `lib/video-history.mjs`가 shorts/watch/공유/임베드 URL의 영상 ID를 추출한다. 게시한 영상·게시 결과 불명 영상은 작업 공간 공통으로 재사용하지 않는다. 검토 전 후보 중복을 제외하며, `browser_submit` 직전에 동기적으로 ID·예약/날짜별 한도를 기록해 계정 간 경쟁도 한 번의 게시로 제한한다. 실패가 실제 클릭 전이면 ID를 소비하지 않고, 클릭을 시도한 뒤에는 확정 전에도 보류한다. 명시적 미게시 확인·재시도는 기존 증표 정책을 따른다.
- 영구 파일 `.office/video-publications.json`은 영상별 committing/confirmed, 소유 증표, 결과 주소, 예약 날짜별 시도 수를 보관한다. 내역 초기화·예약 삭제·앱 재시작으로 삭제하지 않는다. 다른 ID로 재업로드한 영상의 내용 유사도 판별은 지원 범위 밖이다. 실제 외부 게시 권한·계정 연결·검토 원문 제한은 유지한다.
