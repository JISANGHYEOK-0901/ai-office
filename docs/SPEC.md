# AI Office 설계 기준

사무 업무를 역할별 AI 에이전트에게 나눠 맡기고, 진행 상황을 로컬 대시보드로 실시간 관제한다.

- **Claude Code:** 실행 조직이다. 메인 세션은 비서실장이고, 약 50명의 역할 서브에이전트를 둔다.
- **Codex:** 검증실이다. 결과물의 사실·숫자·문서·코드를 읽기 전용으로 검토한다.
- **런타임:** 모두 로컬에서 돈다. Node 20 이상의 표준 라이브러리만 쓰고 npm 의존성은 없다. 서버 호스팅은 필요 없다.

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
  - 서버는 실행 목록(`runs`)을 메모리와 `.office/runs.json`에 둔다. 필드는 `id`, 대상, 요청 요약, pid, 상태(running/done/failed/stopped), 시작·종료 시각, 마지막 출력 요약이다.
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
lib/                      공용 모듈(이벤트 스키마, 정본 로더, 경로)
dashboard/server.mjs      HTTP + SSE 서버 (기본 127.0.0.1:4777)
dashboard/state.mjs       이벤트 → 화면 상태 리듀서(순수 함수)
dashboard/public/         index.html, app.js, styles.css, office.js(픽셀 사무실 캔버스)
test/                     node:test 테스트
.office/                  런타임 데이터(Git 제외): events.jsonl, demo-events.jsonl, tasks.json, sessions.json
outputs/YYYY-MM-DD/<slug>/  업무 산출물(Git 제외)
```

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
- 훅이 PostToolUse(Bash)의 응답 stdout에서 `OFFICE_TASK=<id>`를 발견하면 `.office/sessions.json`에 `{session: id}`를 기록한다. 이후 그 세션에서 나오는 모든 이벤트(서브에이전트 포함)에 `task`가 붙는다.
- `office.mjs task status <id> done|blocked|active`로 상태를 바꾼다. 화면에서는 산출물 폴더에 `report.md`와 `reviews/*.md`가 있는지도 함께 보여준다.

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
`repoRoot()`(환경변수 `AI_OFFICE_ROOT`가 있으면 그 값), `officeDir(root)`(`.office`가 없으면 만든다), `outputsDir(root)`, `kstDate(d = new Date())`는 `YYYY-MM-DD`를 반환한다. `renameWithRetry(from, to)`는 Windows rename 실패(EPERM/EBUSY/EACCES)를 짧은 백오프로 최대 5회 재시도한다.

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
- **명령 인자:** 배열로 전달하고 셸을 쓰지 않는다(Windows `.cmd` shim만 예외). prompt는 명령 인자가 아니라 stdin으로 넣는다. 오류는 `err.status`(400/404/409)와 한국어 메시지로 던진다.
- **사전 검사:** agentId는 org에 있는지 확인한다. 휴무 상태면 거부한다.
- **출력 처리:** stream-json 출력의 마지막 result 요약을 run에 저장한다. stdout 원문은 `.office/runs/<id>.log`에 남긴다.
- **테스트:** spawnImpl을 주입할 수 있어서 실제 CLI 없이 테스트한다.

### dashboard/state.mjs
`buildState({org, events, runs, tasks, now})`는 화면 상태를 반환한다. 순수 함수다.

반환 구조:
```
{ metrics:{active,standby,idle,offline,tasks,reviews,tools},
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
| GET /api/runs/:id/log | 마지막 64KB 텍스트 |
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
- **npm 스크립트:** `npm run office`/`demo`/`check`가 PowerShell·CMD에서도 같게 동작해야 한다. 그래서 셸 문법(`&&` 연결, 환경변수 인라인 지정, `rm`)을 쓰지 않는다. `check`는 `node scripts/check.mjs`(sync --check 후 test/*.test.mjs를 파일 목록으로 `node --test`)다.
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
- **실행 결과 보기:** 전체 답변은 로그(stream-json)에서 화면이 assistant 텍스트·최종 result만 추려 보여준다('원문 보기'로 전환). 별도 결과 파일·API는 두지 않았다.
- **결정됨(2026-10-29, 요약 유지 — 아래 "요청 요약 저장" 참조):** request 이벤트·runs의 요청 요약(앞 200자/120자, 비밀값 가림)이 "원문 프롬프트는 저장하지 않는다"에 해당하는지. 요약을 없앨지, "앞 N자 요약 저장"으로 정본을 고칠지 정해야 한다.

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
