# AI Office

사무 업무를 역할별 AI 직원에게 나눠 맡기고, 진행 상황을 로컬 대시보드에서 실시간으로 보는 도구입니다.

- **Claude Code = 실행 조직.** 메인 세션이 비서실장이고, 대시보드에서 만든 직원은 Claude 서브에이전트(`.claude/agents/<id>.md`)가 됩니다.
- **Codex = 검증실.** 결과물의 사실·숫자·문서·코드를 읽기 전용(`codex exec -s read-only`)으로 검토하고 판정(PASS/FIX/BLOCK)을 남깁니다.
- **모두 로컬에서 동작합니다.** Node 20 이상 표준 라이브러리만 쓰고 `npm install`이 필요 없습니다. 서버 호스팅도 필요 없습니다.

설계 정본은 [`docs/SPEC.md`](docs/SPEC.md)입니다.

## 처음 받는 사람

AI Office는 **각자 자기 컴퓨터에서, 자기 claude·codex 로그인으로** 실행합니다. 대시보드를 다른 사람과 공유하거나 원격으로 접속하는 방식이 아닙니다.

1. **받기**

   ```bash
   git clone https://github.com/JISANGHYEOK-0901/ai-office.git
   cd ai-office
   ```

2. **Node 20 이상 설치**
   - macOS: `brew install node` 또는 [nodejs.org](https://nodejs.org)의 LTS 설치 파일
   - Windows(PowerShell): `winget install OpenJS.NodeJS.LTS` 또는 nodejs.org의 LTS 설치 파일. 설치 후 **새 PowerShell 창**을 엽니다.

3. **claude·codex 설치와 로그인** (두 OS 같은 명령. Windows는 PowerShell 또는 CMD에서 실행)

   ```bash
   npm install -g @anthropic-ai/claude-code   # Claude Code (필수: 직원·비서실장 실행)
   claude auth login                          # 브라우저에서 본인 Claude 구독 계정으로 로그인(claude 실행 중이면 /login)
   npm install -g @openai/codex               # Codex CLI (선택: 검증실)
   codex login                                # 본인 ChatGPT 계정으로 로그인
   ```

   - Windows의 Git for Windows는 **선택 사항**입니다. 없어도 대시보드와 훅이 동작합니다.

4. **환경 점검**

   ```bash
   npm run doctor
   ```

   Node 버전, claude·codex 설치·로그인, API 키 환경변수, 포트 4777을 확인하고 항목마다 ✔/✖/⚠와 OS별 해결 명령을 보여줍니다. 필수 항목(Node, claude 설치·로그인)이 실패하면 종료 코드 1입니다. `npm run doctor -- --json`으로 JSON 출력도 됩니다. 로그인 여부만 표시하고 이메일·인증 정보는 출력하지 않습니다.

5. **실행**

   ```bash
   npm run office
   ```

   브라우저에서 http://127.0.0.1:4777 을 엽니다. 처음에는 빈 회사로 시작합니다. claude나 codex가 없으면 화면 상단에 배너로 알려 줍니다.

**각자 계정으로 실행하세요.** 한 사람의 Claude·ChatGPT 구독을 여러 사람이 함께 쓰지 마세요. 모든 작업은 실행한 사람의 계정 사용량 한도를 씁니다. `ANTHROPIC_API_KEY`·`OPENAI_API_KEY` 같은 API 키 환경변수가 있으면 구독 대신 API 과금으로 실행될 수 있으니, `npm run doctor`의 경고를 확인하세요.

**개인 데이터와 백업:** 부서·직원·회사 규칙(`org/departments.json`, `org/roster.json`, `org/company.md`)과 생성된 에이전트 파일(`.claude/agents/`, `.codex/agents/`)은 내 컴퓨터에만 있고 Git에 올라가지 않습니다(`.gitignore`). 백업하거나 다른 컴퓨터로 옮기려면 화면의 **회사 설정 → 회사 구성 내보내기**로 JSON 파일을 받아 두고, 새 컴퓨터에서 **가져오기**로 불러옵니다. CLI로도 됩니다.

```bash
node scripts/office.mjs org export backup/ai-office-org.json   # 이미 있는 파일은 --yes가 있어야 덮어씀
node scripts/office.mjs org import backup/ai-office-org.json   # 요약을 보여주고 덮어쓸지 확인(--yes로 확인 생략)
```

## 빠른 시작

```bash
npm run doctor     # 실행 환경 점검(claude·codex 설치·로그인 등)
npm run office     # 대시보드 → http://127.0.0.1:4777
npm run demo       # 가짜 이벤트로 화면만 구경 (DEMO 배지, 실제 파일에 쓰지 않음)
npm run check      # 정본·생성 파일 일치 검사 + 전체 테스트
```

- 포트·주소 변경: `node dashboard/server.mjs --port 4800 --host 127.0.0.1`
- 서버를 끄려면 터미널에서 Ctrl+C를 누릅니다(Windows에서는 Ctrl+Break나 콘솔 창 닫기에도 실행 중인 작업 정리를 시도합니다).

## 첫 사용 흐름

1. **부서 만들기:** 처음 열면 화면이 비어 있고 "첫 부서 만들기" 카드가 보입니다. 프리셋(개발·크리에이티브·마케팅·비즈니스·운영·리뷰·리서치·법무·투자·라이프·재무·검증실)에서 고르거나 이름·영문 표기·색·엔진·허용 도구·기본 모델·권한 모드를 직접 입력합니다. 프리셋 카드의 "인원까지 추가"를 누르면 직무 프리셋으로 직원을 한 번에 채용할 수 있습니다.
2. **직원 추가:** 부서 카드나 조직도에서 "+ 직원 추가". 이름(예: 김대리), 직급, 담당 업무, 상세 지침, 팀장 여부, 모델을 정합니다. 직무 프리셋을 고르면 담당 업무·지침·모델이 채워지고 고칠 수 있습니다.
3. **작업 지시:**
   - 특정 직원에게: 직원 프로필 → "작업 지시". 모델(기본/haiku/sonnet/opus)을 작업 단위로 고를 수 있습니다.
   - 비서실장에게: 상단 입력창에 업무를 적고 "지시하기". 비서실장이 `office-task` 절차대로 업무 폴더를 만들고 직원에게 나눠 맡긴 뒤 Codex 검증까지 진행합니다.
   - 실행 중인 작업은 프로필이나 우측 "업무 · 실행" 패널에서 중지할 수 있고, 로그와 마지막 답변도 거기서 봅니다.
4. **언제든:** 부서·직원 수정·삭제(확인 대화상자), 근무/휴무 전환, "회사 설정"(모든 직원 공통 규칙, 회사 구성 내보내기·가져오기), 직원 프로필의 "최종 지침 미리보기".

저장할 때마다 서버가 `org/*.json`을 원자적으로 저장하고 곧바로 `.claude/agents/`, `.codex/agents/`를 다시 생성합니다. 휴무 직원은 파일이 없어서 비서실장이 부를 수 없습니다.

## 준비 (OS별)

| | macOS 13+ | Windows 10+ (PowerShell·CMD) |
|---|---|---|
| Node 20+ | `brew install node` 또는 nodejs.org 설치 파일 | `winget install OpenJS.NodeJS.LTS` 또는 nodejs.org 설치 파일 |
| Claude Code | `npm install -g @anthropic-ai/claude-code` (또는 공식 설치 스크립트) | 같은 명령 |
| Claude 로그인 | `claude auth login` (확인: `claude auth status`) | 같은 명령 |
| Codex CLI | `npm install -g @openai/codex` | 같은 명령 |
| Codex 로그인 | `codex login` (확인: `codex login status`) | 같은 명령 |
| Git for Windows | — | **선택.** 없어도 됩니다(아래 "Claude 연동 · 훅" 참고). 설치: `winget install Git.Git` |
| 점검 | `npm run doctor` | 같은 명령 |

- `claude`·`codex`는 PATH(Windows는 PATHEXT 포함)를 직접 탐색해서 찾습니다. npm 전역 설치로 생긴 `.cmd` shim도 실행합니다.
- 다른 위치의 실행 파일을 쓰려면 `CLAUDE_BIN`/`CODEX_BIN` 환경변수를 지정합니다. 값이 `.js`/`.mjs`면 node로 실행합니다(테스트용 가짜 바이너리).

## 서버 호스팅이 필요한가?

**필요 없습니다.** 대시보드는 내 컴퓨터의 `127.0.0.1`에서만 열리는 로컬 서버이고, 에이전트도 내 컴퓨터의 `claude`·`codex`로 실행됩니다.

- **밖에서 보고 싶을 때:** 서버를 외부에 공개하지 말고 Tailscale 같은 사설 VPN으로 내 컴퓨터에 접속하세요. `--host`로 다른 주소(예: Tailscale IP)에 바인딩하면 서버가 시작할 때 `http://…/?key=…` 접속 주소를 출력합니다. 이 주소로 연 브라우저만 쿠키로 인증되고, 키 없는 요청은 모두 거부됩니다. 키는 비밀번호와 같으니 공유하지 마세요.
- **상시 운영:** 작업은 대시보드를 켠 기기에서 돌아갑니다. 항상 켜 두려면 항상 켜진 기기(데스크톱·미니 PC 등)에서 `npm run office`를 실행해 두면 됩니다.

## Claude 연동

- **훅:** `.claude/settings.json`이 SessionStart·UserPromptSubmit·PreToolUse·PostToolUse·SubagentStart·SubagentStop·Stop 훅으로 `hooks/office-event.mjs`를 부릅니다. 훅은 이벤트를 `.office/events.jsonl`에 한 줄씩 남기고, 어떤 오류에도 종료 코드 0·stdout 무출력으로 끝납니다. 이 레포에서 Claude Code를 쓰면(대시보드 실행이든 직접 실행이든) 화면에 똑같이 반영됩니다.
  - 훅은 셸을 거치지 않는 exec 형식(`"command": "node", "args": ["${CLAUDE_PROJECT_DIR}/hooks/office-event.mjs"]`)입니다.
  - **Windows 확인 결과**(공식 문서 code.claude.com/docs/en/hooks, 2026-10-29): 셸 형식 훅은 Git Bash가 있으면 Git Bash, 없으면 PowerShell로 실행되며, PowerShell에서는 `$CLAUDE_PROJECT_DIR`이 펼쳐지지 않습니다. `${CLAUDE_PROJECT_DIR}` 자리표시자는 Claude Code가 직접 치환하고 환경변수로도 넘기므로, exec 형식이면 Git for Windows 유무와 관계없이 동작합니다. 훅 스크립트는 환경변수가 없어도 자기 파일 위치로 레포 루트를 찾습니다.
- **업무 연결:** 비서실장이 `node scripts/office.mjs task start "<제목>"`을 실행하면 출력의 `OFFICE_TASK=<id>`를 훅이 읽어 그 세션의 이후 이벤트(서브에이전트 포함)에 업무 id를 붙입니다.
- **서브에이전트:** 직원 = `.claude/agents/<id>.md`. 지침은 공통 머리말 → 회사 공통 규칙(`org/company.md`) → 부서 공통 지침 → 역할 지침 순서로 조립됩니다.
- **대시보드 실행:** 직원에게 지시하면 `claude -p --output-format stream-json --verbose --permission-mode <부서 설정> --agent <id> [--allowedTools …] [--model …]`을 레포 루트에서 실행하고 요청 문장은 stdin으로 넣습니다. 비서실장 지시는 `--agent` 없이 실행합니다. 동시 실행은 4개까지이고 넘치면 대기열에 들어갑니다. 중지하면 프로세스 그룹에 SIGTERM, 5초 뒤 SIGKILL(Windows는 `taskkill /T /F`)을 보냅니다.
- **권한 모드:** 기본 `acceptEdits`(파일 편집 자동 승인). `bypassPermissions`는 부서 설정에서 명시해야 하고 화면에 경고가 붙습니다.
- **모델:** 직원 model > 팀장이면 opus > 부서 model > sonnet. 대량 페이지 수집·분류는 haiku 직무(`web-scraper`, `page-classifier`), 외부 제출 문서·최종 시장 분석은 비서실장이 작업 단위로 opus를 지정합니다.

## Codex 연동 (검증실)

```bash
node scripts/codex-review.mjs --target outputs/<날짜>/<slug> [--reviewers fact-checker,number-auditor|all] [--task <id>] [--effort low] [--dry-run]
```

- 검토자마다 `codex exec --json -s read-only -C <레포> -m gpt-6.1-sol -c model_reasoning_effort="max" -`를 별도 프로세스로 띄우고(동시 3개), 프롬프트는 stdin으로 넣습니다.
- 마지막 답변은 `<target>/reviews/<검토자>.md`에 저장됩니다. 첫 줄 `VERDICT: PASS|FIX|BLOCK`을 파싱하고(못 찾으면 FIX), BLOCK이 있으면 종료 코드 2, 실행 실패(ERROR)만 있으면 1입니다.
- JSON 스트림의 명령 실행 등은 `engine: "codex"` 이벤트로 바뀌어 대시보드에 보입니다.
- 모델 변경: 검증실 부서 설정의 Codex 모델·추론 강도, 일회성으로 `OFFICE_CODEX_MODEL`/`OFFICE_CODEX_EFFORT` 환경변수, 또는 `--model`/`--effort`. 비용을 아끼려면 테스트에서만 `--effort low`를 쓰세요.
- **Codex 프로젝트 훅을 쓰지 않는 이유:** Codex의 프로젝트 설정·훅은 사용자가 그 프로젝트를 신뢰 승인하기 전에는 실행되지 않습니다. 그래서 훅에 기대지 않고 `codex exec --json` 출력을 실행기가 직접 이벤트로 바꿉니다.
- **Codex 내부 멀티에이전트 대신 프로세스 병렬:** 검토자마다 독립 프로세스로 띄워야 검토자별 판정·리뷰 파일·이벤트·실패 처리가 분리되고, 대시보드에서 누가 무엇을 하는지 그대로 보입니다.

## 데이터 위치와 Git

| 경로 | 내용 | Git |
|---|---|---|
| `org/departments.json`, `org/roster.json`, `org/company.md` | 조직 정본·회사 규칙(개인 데이터). 없으면 빈 회사로 시작하고 첫 저장 때 만듦 | 제외(.gitignore) |
| `org/presets.json`, `org/templates/` | 부서·직무 프리셋 | 커밋 |
| `.claude/agents/`, `.codex/agents/` | 정본에서 생성(생성 표식 있음). `npm run sync`로 재생성 | 제외(.gitignore) |
| `.office/` | 이벤트·업무·세션·실행 기록·실행 로그 | 제외(.gitignore) |
| `outputs/<날짜>/<slug>/` | 업무 산출물(brief, 부서별 결과, report, reviews) | 제외(.gitignore) |

- `.claude/agents/`·`.codex/agents/` 폴더 전체가 Git에서 제외되므로, 이 폴더에 직접 만든 **개인 에이전트 파일(생성 표식 없음)도 Git에 올라가지 않습니다.** sync는 표식 없는 파일을 지우거나 덮어쓰지 않지만, Git으로 백업되지도 않으니 따로 보관하세요.
- 회사 구성 백업·이전은 위 "처음 받는 사람"의 내보내기·가져오기를 씁니다. 가져오기는 현재 구성을 통째로 바꾸고(검증에 실패하면 아무것도 바꾸지 않음), 이전 구성의 생성 파일은 지우고 새 구성으로 다시 만듭니다.

초기화하려면 대시보드에서 부서를 모두 삭제하고(직원·에이전트 파일도 함께 삭제됨), 서버를 끈 뒤 `.office/`와 `outputs/`를 지우면 됩니다.

## 보안

- 기본 바인딩은 `127.0.0.1`입니다. 외부 노출은 `--host`를 명시할 때만 합니다.
- 상태를 바꾸는 API(POST/PUT/DELETE)는 서버 시작 때 만든 토큰(`X-Office-Token`, index.html에 주입), 서버 자신의 `Origin`, `Content-Type: application/json`을 모두 요구합니다. 다른 웹사이트가 로컬 서버로 에이전트를 실행시키는 CSRF와 DNS 리바인딩을 막기 위해서입니다.
- 실행 로그(`/api/runs/:id/log`), 지침 미리보기, 회사 규칙 조회, 회사 구성 내보내기(`/api/org/export`)도 토큰을 요구합니다. 로그 파일(`.office/runs/`)은 본인만 읽을 수 있게(0700/0600) 만듭니다.
- **원격 바인딩(`--host`가 127.0.0.1이 아닐 때):** 토큰은 index.html에 그대로 넣으면 같은 네트워크의 누구나 얻을 수 있으므로, 이때는 시작 때 출력하는 `?key=` 접속 주소로 연 브라우저에만 HttpOnly·SameSite=Strict 쿠키를 주고 쿠키 없는 요청(페이지·상태·SSE 포함)은 401로 거부합니다. 루프백(기본값)에서는 `/api/state`·`/api/stream`을 같은 기기의 다른 프로세스도 읽을 수 있으니 공용 컴퓨터에서는 주의하세요.
- 이벤트에는 원문 도구 입력·응답을 남기지 않습니다. 요약은 200자 이내로 자르고 비밀값 패턴(password, token, api key, cookie 등)을 가립니다. Bash 명령은 앞 80자만 남깁니다.
- 권한 모드는 기본 `acceptEdits`입니다. `bypassPermissions` 부서는 확인 없이 명령 실행·파일 삭제까지 할 수 있으니 신뢰할 수 있는 작업에만 쓰세요.

## 한계

- **서브에이전트는 1단계입니다.** 직원(팀장 포함)은 다른 직원을 부를 수 없습니다. 배정과 취합 지시는 비서실장만 합니다.
- **사용량 한도:** 모든 실행은 내 Claude·Codex 계정의 사용량 한도를 씁니다. 직원을 많이 동시에 부르거나 opus·높은 추론 강도를 쓰면 한도에 빨리 닿습니다.
- **동시 실행 수:** 대시보드 실행은 4개, Codex 검증은 검토자 3명까지 동시에 돌고 나머지는 기다립니다. Codex 검토자별 시간 제한은 없으니 오래 걸리면 대시보드에서 중지하세요.
- 서버를 Ctrl-C로 끄면 실행 중인 작업의 프로세스 그룹을 SIGTERM → 5초 뒤 SIGKILL로 끝내고 "중지됨"으로 기록합니다. 서버가 비정상 종료돼 정리하지 못한 실행은 다음 시작 때 "실패(추적 끊김)"로 표시됩니다.
