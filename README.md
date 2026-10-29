# AI Office

사무 업무를 역할별 AI 직원에게 나눠 맡기고, 진행 상황을 로컬 대시보드에서 실시간으로 보는 도구입니다.

- **Claude Code = 실행 조직.** 메인 세션이 비서실장이고, 대시보드에서 만든 직원은 Claude 서브에이전트(작업 공간의 `.claude/agents/<id>.md`)가 됩니다.
- **프로그램과 작업 공간을 나눕니다.** 이 레포는 대시보드 프로그램이고, 회사 데이터와 AI 직원의 실행 위치는 레포 밖의 **작업 공간**(기본 `~/AIOffice`, Windows `%USERPROFILE%\AIOffice`)입니다. AI 직원은 프로그램 코드를 고칠 수 없고, `git pull`로 업데이트해도 회사 데이터와 섞이지 않습니다(아래 "작업 공간").
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

   브라우저에서 http://127.0.0.1:4777 을 엽니다. 처음 실행하면 작업 공간(기본 `~/AIOffice`)을 만들고 빈 회사로 시작합니다. 다른 위치를 쓰려면 `npm run office -- --workspace <경로>`(다음 실행부터 기억) 또는 `AI_OFFICE_WORKSPACE` 환경변수를 씁니다. claude나 codex가 없으면 화면 상단에 배너로 알려 줍니다.

   예전 버전을 쓰던 사람(회사 데이터가 레포 안에 있음)은 아래 "작업 공간 · 예전 데이터 옮기기"를 보세요.

**각자 계정으로 실행하세요.** 한 사람의 Claude·ChatGPT 구독을 여러 사람이 함께 쓰지 마세요. 모든 작업은 실행한 사람의 계정 사용량 한도를 씁니다. `ANTHROPIC_API_KEY`·`OPENAI_API_KEY` 같은 API 키 환경변수가 있으면 구독 대신 API 과금으로 실행될 수 있으니, `npm run doctor`의 경고를 확인하세요.

**개인 데이터와 백업:** 부서·직원·회사 규칙(`org/departments.json`, `org/roster.json`, `org/company.md`)과 생성된 에이전트 파일(`.claude/agents/`, `.codex/agents/`)은 작업 공간에만 있고 레포(Git)에 들어가지 않습니다. 백업하거나 다른 컴퓨터로 옮기려면 화면의 **회사 설정 → 회사 구성 내보내기**로 JSON 파일을 받아 두고, 새 컴퓨터에서 **가져오기**로 불러옵니다. CLI로도 됩니다.

```bash
node scripts/office.mjs org export backup/ai-office-org.json   # 이미 있는 파일은 --yes가 있어야 덮어씀
node scripts/office.mjs org import backup/ai-office-org.json   # 요약을 보여주고 덮어쓸지 확인(--yes로 확인 생략)
```

## 작업 공간

| 위치 | 들어 있는 것 |
|---|---|
| **프로그램 레포**(이 폴더) | 대시보드·스크립트·훅 코드, 부서·직무 프리셋(`org/presets.json`, `org/templates/`), 수칙 원본(`AGENTS.md`, `.claude/skills/office-task/SKILL.md`, `.claude/settings.json`) |
| **작업 공간**(기본 `~/AIOffice`) | 데이터: `org/`(departments.json·roster.json·company.md), `outputs/`, `.office/` · 생성물: `CLAUDE.md`, `AGENTS.md`, `.claude/settings.json`, `.claude/skills/office-task/`, `.claude/agents/`, `.codex/agents/`, `scripts/office.mjs`·`scripts/codex-review.mjs`(프로그램 스크립트로 연결), `.ai-office-workspace`(표식) |

- **위치 결정 순서:** `AI_OFFICE_WORKSPACE` 환경변수 > `npm run office -- --workspace <경로>` > 레포의 `.office-local.json`(앞의 옵션이나 `npm run migrate`로 고른 경로를 기억, Git 제외) > 기본값. 작업 공간은 프로그램 레포 안이나 레포를 품는 상위 폴더일 수 없습니다.
- **실행 위치:** 대시보드가 띄우는 `claude`·`codex`, Codex 검증, office CLI는 모두 작업 공간을 현재 폴더로 실행합니다. Codex는 `codex exec -C <작업 공간>`으로 작업 공간을 기준 폴더로 씁니다.
- **생성물:** 서버가 시작할 때(그리고 `npm run sync`) 프로그램 레포의 원본에서 작업 공간의 수칙·설정·스킬을 다시 만듭니다. 훅은 `{"command": "node", "args": ["<프로그램 레포 절대경로>/hooks/office-event.mjs"]}`처럼 셸을 거치지 않는 형식이라 경로에 공백이 있거나 Windows 경로여도 동작합니다. 생성 표식이 있는 파일(설정 JSON은 생성 기록 `.claude/ai-office-generated.json`의 해시와 같은 파일)만 갱신하고, 직접 만들거나 고친 파일은 덮어쓰지 않고 경고만 남깁니다. 작업 공간에서만 쓸 Claude 설정은 `.claude/settings.local.json`에 두세요.
- **확인:** `npm run doctor`와 화면의 **회사 설정**에 작업 공간 경로가 보이고, 회사 설정의 **폴더 열기**로 Finder·탐색기에서 엽니다. 작업 공간 생성물·에이전트 파일이 정본과 맞는지는 `npm run sync -- --check`로 봅니다.
- **터미널에서 비서실장 쓰기:** 작업 공간 폴더에서 `claude`를 엽니다(`cd ~/AIOffice` 후 `claude`). 작업 공간의 CLAUDE.md·훅이 적용되고 화면에도 반영됩니다. 이어서 답하기(`claude --resume <id>`)도 작업 공간 폴더에서 실행합니다.

**레포에서 직접 개발할 때:** 프로그램을 고치려고 이 레포 폴더에서 `claude`를 열면 개발 세션입니다. 레포의 `CLAUDE.md`는 호환 모드용 비서실장 수칙이기도 하지만 "개발 목적이면 `docs/SPEC.md`를 따른다"고 적혀 있고, 레포 보호 가드는 작업 공간 세션에만 적용되므로 코드를 고칠 수 있습니다. 업무 지시는 대시보드나 작업 공간 폴더에서 연 세션으로 하세요. 레포에서 연 세션의 훅 이벤트는 레포의 `.office/`(Git 제외)에 남고, 이것만으로는 호환 모드로 바뀌지 않습니다.

**프로그램 레포 보호:** 작업 공간에서 실행되는 모든 에이전트(비서실장·직원·직접 지시한 직원 실행)는 `hooks/chief-guard.mjs`(PreToolUse)가 프로그램 레포를 대상으로 하는 Write·Edit·MultiEdit·NotebookEdit를 거부합니다. Bash·PowerShell 명령은 레포 경로(절대경로, `~`·`$HOME`·`%USERPROFILE%` 표기, 작업 공간 기준 상대경로)를 쓰는 리다이렉션(`>`), `tee`, `rm`, `mv`, `cp` 대상, `git` 쓰기 명령, `node -e`의 파일 쓰기 등을 **최선 노력으로** 거부합니다. 셸 명령은 변수·스크립트 파일·다른 프로그램을 거치면 우회할 수 있으므로 완전한 차단이 아닙니다(아래 "한계").

### 예전 데이터 옮기기 (npm run migrate)

예전 버전은 회사 데이터를 레포 안에 두었습니다. 새 버전은 레포 안에 데이터(`org/departments.json`·`roster.json`·`company.md`, `outputs/`, `.claude/agents/`, `.codex/agents/`)가 있고 작업 공간을 따로 고르지 않았으며 기본 작업 공간(`~/AIOffice`)이 아직 준비되지 않았으면(표식 `.ai-office-workspace` 없음) **호환 모드**로 예전 위치를 그대로 쓰고, 화면 상단과 `npm run doctor`에 이전 안내를 계속 띄웁니다. 호환 모드에서는 레포 보호 가드가 동작하지 않습니다.

```bash
# 대시보드 서버를 끈 뒤
npm run migrate                                   # 기본 작업 공간(~/AIOffice)으로. 옮길 항목을 보여 주고 확인(y)을 받음
npm run migrate -- --workspace D:\Office --yes     # 다른 위치로, 확인 생략
npm run migrate -- --dry-run                      # 무엇을 옮길지만 보기
```

- 순서: **복사 → 검증(파일 수·크기) → 원본은 레포의 `.office-migrated-<날짜>/`로 옮겨 보관**합니다. 아무것도 자동으로 지우지 않습니다. 확인한 뒤 보관 폴더를 직접 지우세요(Git에서는 제외됩니다).
- 대상: 위 데이터와 `.office/`(이벤트·업무·실행 기록). 작업 공간에 같은 이름의 파일이 이미 있으면 덮어쓰지 않고 아무것도 바꾸지 않은 채 멈춥니다. 검증에 실패하면 이번에 복사한 파일만 되돌리고 원본은 그대로 둡니다.
- 확인(대화형 터미널의 y 또는 `--yes`)이 없으면 옮기지 않고 호환 모드로 계속 동작합니다.
- **서버 실행 중이면 거부:** 대시보드 서버는 켜져 있는 동안 데이터 위치의 `.office/server.lock`에 pid·포트를 남깁니다. migrate는 프로그램 폴더(호환 모드)나 대상 작업 공간의 서버가 살아 있으면 옮기지 않습니다. 서버가 이미 꺼졌는데(다른 프로세스가 같은 pid를 쓰는 경우 등) 거부되면 `--force`를 붙이세요.
- **경로 기억:** 복사·검증이 끝나면 원본을 옮기기 전에 이전한 작업 공간을 `.office-local.json`에 기억합니다(기본 경로 포함). 그래서 이전 뒤 레포에 예전 항목이 다시 생기거나 원본을 옮기다 끊겨도 호환 모드로 돌아가지 않고 작업 공간을 씁니다(남은 항목은 배너로 알림).
- **이어서 하기:** 강제 종료 등으로 중간에 끊겼으면 같은 명령을 다시 실행하세요. 작업 공간에 내용까지 같은 복사본이 있는 파일은 이미 복사한 것으로 보고 건너뜁니다. 옮기는 동안 누른 Ctrl+C는 이전이 끝난 뒤에 처리합니다.

## 빠른 시작

```bash
npm run doctor     # 실행 환경 점검(claude·codex 설치·로그인 등)
npm run office     # 대시보드 → http://127.0.0.1:4777
npm run demo       # 가짜 이벤트로 화면만 구경 (DEMO 배지, 실제 파일에 쓰지 않음)
npm run check      # 전체 테스트(사용자 작업 공간은 읽지 않음)
npm run sync       # 작업 공간 생성물·에이전트 파일을 정본에서 다시 만들기(--check는 검사만)
npm run migrate    # 레포 안의 예전 데이터를 작업 공간으로 옮기기
```

- 포트·주소 변경: `node dashboard/server.mjs --port 4800 --host 127.0.0.1`
- 작업 공간 변경: `npm run office -- --workspace <경로>`(다음 실행부터 기억) 또는 `AI_OFFICE_WORKSPACE` 환경변수
- 서버를 끄려면 터미널에서 Ctrl+C를 누릅니다(Windows에서는 Ctrl+Break나 콘솔 창 닫기에도 실행 중인 작업 정리를 시도합니다).

## 첫 사용 흐름

1. **부서 만들기:** 처음 열면 화면이 비어 있고 "첫 부서 만들기" 카드가 보입니다. 프리셋(개발·크리에이티브·마케팅·비즈니스·운영·리뷰·리서치·법무·투자·라이프·재무·검증실)에서 고르거나 이름·영문 표기·색·엔진·허용 도구·기본 모델·권한 모드를 직접 입력합니다. 프리셋 카드의 "인원까지 추가"를 누르면 직무 프리셋으로 직원을 한 번에 채용할 수 있습니다.
2. **직원 추가:** 부서 카드나 조직도에서 "+ 직원 추가". 이름(예: 김대리), 직급, 담당 업무, 상세 지침, 팀장 여부, 모델을 정합니다. 직무 프리셋을 고르면 담당 업무·지침·모델이 채워지고 고칠 수 있습니다.
3. **작업 지시:**
   - 특정 직원에게: 직원 프로필 → "작업 지시". 모델(기본/haiku/sonnet/opus)을 작업 단위로 고를 수 있습니다.
   - 비서실장에게: 상단 입력창에 업무를 적고 "지시하기". 비서실장이 `office-task` 절차대로 업무를 등록하고, 담당이 없으면 회의로 분담을 정하고, 작업 계획표를 쓴 뒤 직원에게 나눠 맡기고 검토까지 해서 **사용자 확인 대기**로 넘깁니다(아래 "업무 흐름과 화면").
   - 실행 중인 작업은 프로필이나 우측 "업무 · 실행" 패널에서 중지할 수 있고, 로그와 마지막 답변도 거기서 봅니다.
4. **답변 필요 → 이어서 답하기:** 대시보드 지시는 `claude -p`로 한 번 실행되고 끝납니다. 비서실장이나 직원이 확인 질문으로 답을 끝내면(마지막 단락의 물음표, "확인하겠습니다·알려 주세요·선택해 주세요" 같은 문구, 번호 목록 질문) 그 실행에 **답변 필요** 배지가 붙고, 상단에 "답변 필요 N" 칩과 피드에 "○○님이 답변을 기다립니다"가 뜹니다.
   - 배지·칩·피드의 "대화 보기"를 누르면 대화 창이 열립니다. 같은 대화의 요청 요약과 답변 전문이 시간순으로 보이고, 아래 입력창에 답을 적어 "보내기"(Ctrl/⌘+Enter)를 누르면 같은 세션을 이어서 실행합니다(`claude -p --resume <세션>`). 원래 직원·권한·도구·모델이 유지되고, 모델은 답장마다 바꿀 수 있습니다.
   - 질문마다 권장 기본값이 붙어 있으니 "기본값으로 진행"이라고만 답해도 됩니다. 이전 실행이 끝나기 전에는 보낼 수 없고, 원래 직원이 삭제·휴무면 이어서 답할 수 없습니다.
   - 터미널에서 이어가도 됩니다. 세션은 실행한 폴더 기준으로 저장되므로 **작업 공간 폴더에서**(호환 모드면 이 저장소 폴더에서) 실행합니다. 대화 창 아래에 `claude --resume <세션 id>`(직원 실행은 뒤에 `--agent <직원 id>`, 검증실은 `codex exec resume <id>`)가 표시되고, 세션 id는 `.office/runs.json`의 `sessionId`에도 있습니다. 이 기능 이전에 실행한 기록은 `sessionId`가 없어 대시보드에서는 답할 수 없지만, 로그(`.office/runs/<id>.log`)의 `session_id`로 터미널에서 `claude --resume <session_id>`를 실행하면 이어갈 수 있습니다.
5. **언제든:** 부서·직원 수정·삭제(확인 대화상자), 근무/휴무 전환, "회사 설정"(모든 직원 공통 규칙, 회사 구성 내보내기·가져오기), 직원 프로필의 "최종 지침 미리보기".

## 업무 흐름과 화면

비서실장에게 지시한 업무는 아래 단계를 거칩니다. 화면의 피드·단계 표시줄·아이콘이 이 단계를 따라 움직입니다.

```
요청 → 내용 확인 → [회의] → 업무 하달 → 업무 전달받음 → 진행 중 → 작업 완료
→ 업무 협조 요청(부서A → 부서B, 비서실장 경유) → … → 검토 요청 → 검토 통과/반려
→ 사용자 확인 대기 → 승인(완료) 또는 반려(피드백 → 재배정)
```

- **지시문의 담당을 따릅니다.** "마케팅부가 조사하고 개발부 최대리가 HTML을 만들고 비서실장이 검토해"처럼 쓰면 그 순서대로 배정합니다. 담당을 적지 않았고 관련 부서가 둘 이상이면, 비서실장이 관련 팀장·담당 2~4명을 **회의**로 불러 분담을 정하고 `outputs/<업무>/meeting.md`에 남깁니다.
- **작업 계획표:** 배정 전에 비서실장이 `outputs/<업무>/plan.json`(단계·담당·입력·출력·완료 기준·의존 관계)을 쓰고 `node scripts/office.mjs plan validate <업무>`로 검사합니다. 근무중이 아닌 직원, 부서 불일치, 순환, 업무 폴더 밖 경로는 거부됩니다. 계획에 없는 직원을 부르면 피드의 그 배정에 "(계획에 없는 배정)" 경고가 붙습니다.
- **조직에 맞춘 분담:** 비서실장은 실행할 때마다 지금의 조직도(부서 역량·결과를 넘기는 부서·근무중 직원)를 받습니다(대시보드 실행은 시스템 프롬프트, 터미널에서 연 `claude`는 SessionStart 훅). 부서를 바꾸면 다음 실행부터 반영됩니다. 부서 역량(`capabilities`)과 결과를 넘기는 부서(`handoffs`)는 조직 탭·부서 모달에서 태그로 고칩니다.
- **역량 공백:** 필요한 역량을 가진 근무중 부서가 없으면 비서실장이 대신하지 않고 계획표의 `gaps`에 적습니다. 화면에 "역량 공백" 카드와 [조직 탭으로] 버튼이 뜹니다.
- **비서실장은 직접 실무를 하지 않습니다.** 업무가 등록된 세션에서 비서실장이 웹 수집·스크립트 실행·산출물 작성을 하려 하거나, 휴무·없는 직원·내장 에이전트를 부르거나, 직원을 백그라운드로 부르면 `hooks/chief-guard.mjs`가 거부하고 사유(부를 수 있는 직원 목록 포함)를 돌려줍니다.
- **검토와 반려:** 비서실장이 산출물을 검토해 `flow review`로 기록합니다. 반려하면 `[반려]` 지시로 해당 부서(원인이 앞 단계면 앞 부서)에 되돌리고, 최대 2회까지 반복합니다. 통과하면 `report.md`를 쓰고 사용자 확인 대기(업무 상태 `review`)로 넘깁니다.
- **사용자 확인:** 사용자 확인 대기 카드나 아이콘을 누르면 단계 표시줄·보고서·산출물 미리보기와 [승인]·[반려] 버튼이 있는 창이 열립니다. 승인하면 완료(`done`)로 기록됩니다. 반려에 피드백을 적어 보내면 그 업무의 비서실장 대화에 이어서 전달되어 재배정됩니다(대화를 이을 수 없으면 새 비서실장 실행을 띄웁니다).

**화면 구성**

- **탭:** 관제 | 사무실 | 조직 | 산출물.
  - **관제:** 부서 카드, 사용자 확인 대기·역량 공백 카드.
  - **사무실:** 비서실(대표실 옆)에 비서실장 자리가 있고, 회의 중인 직원은 회의실로 모이며, 협조 요청이 오면 두 부서 사이로 서류가 전달됩니다.
  - **조직:** 부서 프리셋, 부서·직원 추가·수정·삭제·근무 전환, 역량·협조 부서 태그, 비서실장에게 주입되는 조직도 보기, 회사 설정.
  - **산출물:** 업무별 목록(날짜·제목·상태·검토 판정·참여 부서, 검색·필터)과 상세(보고서·회의록·계획표·부서별 파일·검토 결과). md·txt·csv·json은 미리보고, html은 스크립트를 막은 미리보기 창으로 보여 줍니다. 그 밖의 파일은 내려받습니다. "폴더 열기"는 Finder·탐색기로 업무 폴더를 엽니다.
- **실시간 피드:** 기본은 업무 언어("비서실장 → 마케팅부 김팀장: 업무 하달", "마케팅부 → 개발부: 업무 협조 요청")로 업무별로 묶어 보여 주고, 진행 중 문구는 직원마다 한 줄로 갱신됩니다. "상세 보기"를 켜면 도구 호출 이벤트(명령은 가린 요약)를 봅니다.
- **업무 카드 단계 표시줄:** 요청 → 확인 → 하달 → 진행 → 협조 → 검토 → 사용자 확인 → 완료. 반려가 있으면 되돌아간 표시와 횟수가 붙고, 계획표가 있으면 단계별 상태(대기·진행·완료·반려)를 보여 줍니다.
- **답변 아이콘:** 대표의 의견이 필요한 직원 머리 위에 픽셀 아이콘이 뜹니다. 말풍선은 답변 필요(대화 창), 결재 서류는 사용자 확인 대기(승인 창), 경고는 역량 공백(공백 내용)입니다. 부서 카드·직원 목록·프로필에도 같은 아이콘이 붙고, 상단 "답변 필요 N" 칩은 가장 오래된 항목부터 엽니다. 의견이 필요하면 브라우저 탭 제목 앞에 `(N) 답변 필요`가 붙고, 상단 "알림"을 켜면 새 항목마다 브라우저 알림을 한 번 보냅니다(기본 꺼짐).
- **직원에게 직접 지시한 실행**은 `outputs/<날짜>/run-<id>/` 폴더를 업무로 만들어 산출물을 거기에 저장합니다.

저장할 때마다 서버가 작업 공간의 `org/*.json`을 원자적으로 저장하고 곧바로 `.claude/agents/`, `.codex/agents/`를 다시 생성합니다. 휴무 직원은 파일이 없어서 비서실장이 부를 수 없습니다.

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

- **훅:** 작업 공간의 `.claude/settings.json`이 SessionStart·UserPromptSubmit·PreToolUse·PostToolUse·SubagentStart·SubagentStop·Stop 훅으로 프로그램 레포의 `hooks/office-event.mjs`를 절대경로로 부릅니다. 훅은 이벤트를 작업 공간의 `.office/events.jsonl`에 한 줄씩 남기고, 어떤 오류에도 종료 코드 0·stdout 무출력으로 끝납니다. 작업 공간에서 Claude Code를 쓰면(대시보드 실행이든 직접 실행이든) 화면에 똑같이 반영됩니다.
  - 훅은 셸을 거치지 않는 exec 형식(`"command": "node", "args": ["<프로그램 레포>/hooks/office-event.mjs"]`)입니다. 레포의 `.claude/settings.json`(호환 모드용·생성 원본)은 `${CLAUDE_PROJECT_DIR}/hooks/…` 자리표시자를 씁니다.
  - **Windows 확인 결과**(공식 문서 code.claude.com/docs/en/hooks, 2026-10-29): 셸 형식 훅은 Git Bash가 있으면 Git Bash, 없으면 PowerShell로 실행되며, PowerShell에서는 `$CLAUDE_PROJECT_DIR`이 펼쳐지지 않습니다. exec 형식이면 Git for Windows 유무와 관계없이 동작합니다. 훅 스크립트는 `CLAUDE_PROJECT_DIR`가 작업 공간(표식 `.ai-office-workspace`)이면 그곳에, 아니면 자기 파일 위치(레포, 호환 모드)에 기록합니다.
- **비서실장 전용 훅:** `hooks/chief-guard.mjs`(PreToolUse)가 업무 중 비서실장의 직접 실무를 거부하고(작업 공간에서는 모든 에이전트의 프로그램 레포 쓰기도 거부), `hooks/session-context.mjs`(SessionStart)가 터미널에서 연 비서실장 세션에 현재 조직도를 넣습니다. 비서실장 판정(직접 실무 거부)과 조직도 주입은 직원(서브에이전트·`--agent` 실행)에는 적용되지 않지만, 프로그램 레포 쓰기 차단은 작업 공간 세션의 모든 에이전트(직원 포함)에 적용됩니다. 오류가 나면 아무것도 하지 않고 통과시킵니다. `.claude/settings.json`은 비서실장이 `node scripts/office.mjs …`·`node scripts/codex-review.mjs …`를 승인 대기 없이 실행하도록 이 두 명령만 허용합니다.
- **업무 연결:** 비서실장이 `node scripts/office.mjs task start "<제목>"`을 실행하면 출력의 `OFFICE_TASK=<id>`를 훅이 읽어 그 세션의 이후 이벤트(서브에이전트 포함)에 업무 id를 붙입니다.
- **서브에이전트:** 직원 = `.claude/agents/<id>.md`. 지침은 공통 머리말 → 회사 공통 규칙(`org/company.md`) → 부서 공통 지침 → 역할 지침 순서로 조립됩니다.
- **대시보드 실행:** 직원에게 지시하면 `claude -p --output-format stream-json --verbose --permission-mode <부서 설정> --agent <id> [--allowedTools …] [--model …]`을 작업 공간에서 실행하고 요청 문장은 stdin으로 넣습니다. 비서실장 지시는 `--agent` 없이 실행합니다. 동시 실행은 4개까지이고 넘치면 대기열에 들어갑니다. 중지하면 프로세스 그룹에 SIGTERM, 5초 뒤 SIGKILL(Windows는 `taskkill /T /F`)을 보냅니다.
- **권한 모드:** 기본 `acceptEdits`(파일 편집 자동 승인). `bypassPermissions`는 부서 설정에서 명시해야 하고 화면에 경고가 붙습니다.
- **모델:** 직원 model > 팀장이면 opus > 부서 model > sonnet. 대량 페이지 수집·분류는 haiku 직무(`web-scraper`, `page-classifier`), 외부 제출 문서·최종 시장 분석은 비서실장이 작업 단위로 opus를 지정합니다.

## Codex 연동 (검증실)

```bash
# 작업 공간 폴더에서(작업 공간의 scripts/codex-review.mjs가 프로그램 스크립트로 연결된다)
node scripts/codex-review.mjs --target outputs/<날짜>/<slug> [--reviewers fact-checker,number-auditor|all] [--task <id>] [--effort low] [--dry-run]
```

- 검토자마다 `codex exec --json -s read-only -C <작업 공간> -m gpt-6.1-sol -c model_reasoning_effort="max" -`를 별도 프로세스로 띄우고(동시 3개), 프롬프트는 stdin으로 넣습니다.
- 마지막 답변은 `<target>/reviews/<검토자>.md`에 저장됩니다. 첫 줄 `VERDICT: PASS|FIX|BLOCK`을 파싱하고(못 찾으면 FIX), BLOCK이 있으면 종료 코드 2, 실행 실패(ERROR)만 있으면 1입니다.
- JSON 스트림의 명령 실행 등은 `engine: "codex"` 이벤트로 바뀌어 대시보드에 보입니다.
- 모델 변경: 검증실 부서 설정의 Codex 모델·추론 강도, 일회성으로 `OFFICE_CODEX_MODEL`/`OFFICE_CODEX_EFFORT` 환경변수, 또는 `--model`/`--effort`. 비용을 아끼려면 테스트에서만 `--effort low`를 쓰세요.
- **Codex 프로젝트 훅을 쓰지 않는 이유:** Codex의 프로젝트 설정·훅은 사용자가 그 프로젝트를 신뢰 승인하기 전에는 실행되지 않습니다. 그래서 훅에 기대지 않고 `codex exec --json` 출력을 실행기가 직접 이벤트로 바꿉니다.
- **Codex 내부 멀티에이전트 대신 프로세스 병렬:** 검토자마다 독립 프로세스로 띄워야 검토자별 판정·리뷰 파일·이벤트·실패 처리가 분리되고, 대시보드에서 누가 무엇을 하는지 그대로 보입니다.

## 데이터 위치와 Git

경로는 작업 공간 기준입니다(호환 모드면 레포 기준이고, 아래 데이터는 `.gitignore`로 제외됩니다).

| 경로 | 내용 | 위치 |
|---|---|---|
| `org/departments.json`, `org/roster.json`, `org/company.md` | 조직 정본·회사 규칙(개인 데이터). 없으면 빈 회사로 시작하고 첫 저장 때 만듦 | 작업 공간 |
| `org/presets.json`, `org/templates/` | 부서·직무 프리셋(작업 공간에 같은 이름의 파일을 두면 그것을 먼저 씀) | 프로그램 레포(커밋) |
| `.claude/agents/`, `.codex/agents/` | 정본에서 생성(생성 표식 있음). `npm run sync`로 재생성 | 작업 공간 |
| `.office/` | 이벤트·업무·세션·실행 기록(`runs.json`)·실행 로그(`runs/<id>.log`)·답변 전문(`runs/<id>.result.md`) | 작업 공간 |
| `outputs/<날짜>/<slug>/` | 업무 산출물(brief, meeting, plan.json, 부서별 결과, report, reviews). 직원 직접 지시는 `outputs/<날짜>/run-<id>/` | 작업 공간 |
| `.office-local.json`, `.office-migrated-<날짜>/` | 고른 작업 공간 경로, migrate가 보관한 예전 데이터 원본 | 프로그램 레포(Git 제외) |

- `.claude/agents/`·`.codex/agents/` 폴더 전체가 Git에서 제외되므로, 이 폴더에 직접 만든 **개인 에이전트 파일(생성 표식 없음)도 Git에 올라가지 않습니다.** sync는 표식 없는 파일을 지우거나 덮어쓰지 않지만, Git으로 백업되지도 않으니 따로 보관하세요.
- 회사 구성 백업·이전은 위 "처음 받는 사람"의 내보내기·가져오기를 씁니다. 가져오기는 현재 구성을 통째로 바꾸고(검증에 실패하면 아무것도 바꾸지 않음), 이전 구성의 생성 파일은 지우고 새 구성으로 다시 만듭니다.

초기화하려면 대시보드에서 부서를 모두 삭제하고(직원·에이전트 파일도 함께 삭제됨), 서버를 끈 뒤 작업 공간의 `.office/`와 `outputs/`를 지우면 됩니다.

## 보안

- 기본 바인딩은 `127.0.0.1`입니다. 외부 노출은 `--host`를 명시할 때만 합니다.
- 상태를 바꾸는 API(POST/PUT/DELETE)는 서버 시작 때 만든 토큰(`X-Office-Token`, index.html에 주입), 서버 자신의 `Origin`, `Content-Type: application/json`을 모두 요구합니다. 다른 웹사이트가 로컬 서버로 에이전트를 실행시키는 CSRF와 DNS 리바인딩을 막기 위해서입니다.
- 실행 로그(`/api/runs/:id/log`), 답변 전문(`/api/runs/:id/result`), 지침 미리보기, 회사 규칙 조회, 회사 구성 내보내기(`/api/org/export`)도 토큰을 요구합니다. 로그·답변 파일(`.office/runs/`)은 본인만 읽을 수 있게(0700/0600) 만듭니다. 화면 상태(`/api/state`)에는 세션 id 값을 싣지 않고 이어서 답할 수 있는지만 표시합니다.
- **원격 바인딩(`--host`가 127.0.0.1이 아닐 때):** 토큰은 index.html에 그대로 넣으면 같은 네트워크의 누구나 얻을 수 있으므로, 이때는 시작 때 출력하는 `?key=` 접속 주소로 연 브라우저에만 HttpOnly·SameSite=Strict 쿠키를 주고 쿠키 없는 요청(페이지·상태·SSE 포함)은 401로 거부합니다. 루프백(기본값)에서는 `/api/state`·`/api/stream`을 같은 기기의 다른 프로세스도 읽을 수 있으니 공용 컴퓨터에서는 주의하세요.
- 이벤트에는 원문 도구 입력·응답을 남기지 않습니다. 요약은 200자 이내로 자르고 비밀값 패턴(password, token, api key, cookie 등)을 가립니다. Bash 명령은 앞 80자만 남깁니다.
- 권한 모드는 기본 `acceptEdits`입니다. `bypassPermissions` 부서는 확인 없이 명령 실행·파일 삭제까지 할 수 있으니 신뢰할 수 있는 작업에만 쓰세요.

## 한계

- **프로그램 레포 보호는 완전하지 않습니다.** 파일 도구(Write·Edit 등)는 확실히 막지만, 셸 명령은 문자열을 보고 판단하는 최선 노력 검사라 변수·스크립트 파일·다른 프로그램을 거친 쓰기는 놓칠 수 있습니다. 호환 모드와 레포에서 직접 연 세션에는 적용되지 않습니다. `bypassPermissions` 부서는 특히 주의하세요.
- **서브에이전트는 1단계입니다.** 직원(팀장 포함)은 다른 직원을 부를 수 없습니다. 배정과 취합 지시는 비서실장만 합니다.
- **직원 파일 이름 제한:** Claude Code는 서브에이전트가 이름이 report·summary·findings·analysis로 시작하는 `.md` 파일을 쓰지 못하게 막습니다. 그래서 단계 산출물은 `<직원id>-<내용>.md`로 정하고(계획표 검사가 거부), 팀장 부서 보고서는 `<부서id>/dept-report.md`입니다.
- **사용량 한도:** 모든 실행은 내 Claude·Codex 계정의 사용량 한도를 씁니다. 직원을 많이 동시에 부르거나 opus·높은 추론 강도를 쓰면 한도에 빨리 닿습니다.
- **동시 실행 수:** 대시보드 실행은 4개, Codex 검증은 검토자 3명까지 동시에 돌고 나머지는 기다립니다. Codex 검토자별 시간 제한은 없으니 오래 걸리면 대시보드에서 중지하세요.
- 서버를 Ctrl-C로 끄면 실행 중인 작업의 프로세스 그룹을 SIGTERM → 5초 뒤 SIGKILL로 끝내고 "중지됨"으로 기록합니다. 서버가 비정상 종료돼 정리하지 못한 실행은 다음 시작 때 "실패(추적 끊김)"로 표시됩니다.
