# Aside 업데이트 옮기기 (AI용 안내)

이 문서는 AI Office를 많이 고쳐 써서 **업데이트를 통째로 받으면(git pull·merge) 충돌이 나는 사용자**의 AI가 Aside 기능만 자기 코드에 옮길 때 읽는다. 원본은 [PR #63](https://github.com/JISANGHYEOK-0901/ai-office/pull/63)(Aside 직원 엔진)이다. 코드 차이(diff)를 그대로 붙이지 말고, 아래 **동작과 지켜야 할 규칙**을 사용자 코드의 같은 역할을 하는 자리에 다시 구현한다.

## 0. 시작 전에

- 사용자 코드는 건드리기 전에 커밋하거나 별도 브랜치에서 작업한다. 사용자가 고친 기능은 유지한다.
- 원본은 별도 폴더에 읽기 전용으로 받는다. 사용자 저장소에 원격으로 추가해 merge·rebase하지 않는다.
  ```bash
  git clone https://github.com/JISANGHYEOK-0901/ai-office.git ../ai-office-upstream
  ```
- 원본에서 볼 것: PR #63의 변경 파일, `docs/SPEC.md`의 "Aside 직원" 절, `docs/DECISIONS.md`의 "Aside 직원" 결정, `GUIDE.html`의 Aside 장.
- 사용자 코드에 같은 이름의 파일·함수가 없으면 **같은 일을 하는 곳**을 찾아 넣는다(예: 직원 실행 명령을 만드는 곳, 외부 작업을 실행하는 곳).

## 1. 옮길 순서 (앞 단계가 뒤 단계의 바탕)

| 순서 | 원본 위치 | 하는 일 | 옮길 때 핵심 |
|---|---|---|---|
| 1 | `lib/aside.mjs` (새 파일) | Aside CLI 찾기(`ASIDE_BIN` > PATH > `~/.local/bin/aside`), 상태 확인, 숨은 탭으로 화면 글자·링크 읽기(`aside repl --json --file -`), 로그인 확인, 보이는 창에 로그인 화면 열기, 남은 세션 멈추기, 첨부 파일 임시 복사, 직원 엔진 판정(`agentEngine`), 권장 안내(`asideAdvice`), 외부 작업 지시문(`asidePublishPrompt`) | 거의 그대로 복사한다. 의존: `lib/cli.mjs`의 `findExecutable`·`resolveCommand`·`spawnCli`·`killTree` |
| 2 | `lib/org.mjs`, `dashboard/server.mjs`의 `AGENT_FIELDS` | 부서 `engine`에 `aside` 허용, 직원 `engine`(비우거나 `aside`) 허용·저장 | 직원 단위 엔진이 핵심이다(같은 부서의 문서 작성 직원은 그대로) |
| 3 | `lib/sync.mjs` | Aside 직원 전용 근무 규칙(`asideRules`), `agentInstructions(…, engine)` | Aside 직원에게 "업무 폴더에 파일 쓰기·office_browser" 같은 Claude 직원 규칙을 주지 않는다 |
| 4 | `dashboard/runner.mjs` | `buildSpec`: Aside 직원이면 `aside exec --json --timeout 60m <지시문>`(지시문은 인자), Aside가 없으면 부서 엔진으로. 출력 마지막 JSON 줄의 `answer`가 결과. 실패·중지 뒤 `stopSessions`. 업무 진행부에 `engineOf` 전달 | 조율 실행(`execute`)에서 Aside 직원에게는 브라우저 도구·`--json-schema`를 붙이지 않는다 |
| 5 | `dashboard/orchestrator.mjs` | `engineFor`·`asideStaff`, 계획 안내(Aside 직원·`connection:"aside"`), Aside 로그인 확인·대기(`asideLogin`·`asideLoginProblem`), 단계 실행(Aside 직원이면 입력 파일 내용을 지시문에 붙이고 응답 `content`를 출력 파일로 저장, 공개 웹·파일 산출물은 replan), 빠른 조회의 Aside 직원 직접 배정, 외부 작업에 `engine` 전달·`asidePublishPrompt`·`ASIDE_LOGIN` 재시작 | 기존 Claude·Codex·Playwright 경로는 바꾸지 않는다. Aside 분기는 "직원이 실제로 Aside 엔진일 때"만 탄다 |
| 6 | `lib/browser-work.mjs` | `deliver({engine:"aside"})`·`deliverAside`·`deliverWebAside`, `asideCheckLogin`·`asideRequestLogin`, 결과 대조 공통 함수(`resultSeen`), `sentMailReceipt`의 보낸사람 미상 처리 | 아래 "지켜야 할 규칙"을 모두 지킨다 |
| 7 | `dashboard/server.mjs` | `createAside()`를 만들어 외부 작업·실행기에 넘김, 상태에 `asideAdvice` | 화면 갱신마다 이력을 읽지 않게 잠시 재사용 |
| 8 | `lib/doctor.mjs` | `aside` 점검 항목(선택)과 설치·로그인·직원 전환 안내 | 앱이 꺼져 있으면 띄우지 않고 설치 여부만 본다 |
| 9 | `dashboard/public/*` | 직원 편집 "엔진: Aside", 부서 엔진 Aside, 권장 배너(바꿀 직원이 있을 때만), 피드·실행 목록의 aside 표시 | 사용자 화면 구조에 맞게 같은 자리에 넣는다 |
| 10 | `lib/orgmap.mjs`, `AGENTS.md`, `GUIDE.html`, `README.md`, `docs/SPEC.md` | 비서실장 조직도의 Aside 표시, 서버 켤 때 Aside 안내, 사용 설명 | 사용자 문서 형식에 맞춘다 |

## 2. 지켜야 할 규칙 (빠뜨리면 안전장치가 깨진다)

- 비밀번호·쿠키를 다루지 않는다. 로그인은 대표가 Aside 브라우저에서 직접 한다. 비밀번호를 Aside 코드(`repl`)에 넣지 않는다(Aside 로컬 기록에 남을 수 있다).
- 외부 작업은 **직원 실행 전에** 기록을 `committing`으로 남긴다. 실행 뒤 숨은 탭으로 결과 화면을 다시 읽어 원문을 대조한다: 댓글은 같은 문구 수가 늘었는지, 글은 직원이 보고한 게시 주소(서비스 주소만)의 제목·본문, 메일은 보낸메일함에서 새로 생긴 메일 상세의 본문·받는사람.
- 결과가 안 보이면 다시 시도하지 않는다. 직원이 "버튼을 누르지 않았다"(`submitted:false`)고 보고한 경우만 다시 할 수 있게 두고, 나머지는 `uncertain`으로 멈춘다.
- 공개 웹 조사는 Aside 직원에게 맡기지 않는다(로그인 없는 임시 브라우저와 사내 주소 차단을 유지).
- Aside 에이전트는 기본 권한에서 자기 작업 폴더(`~/.aside/u/0`) 밖 파일을 못 읽는다. 첨부는 그 안의 임시 폴더에 복사하고 끝나면 지운다.
- CLI를 끝내도 Aside 세션은 계속 돈다. 중지·실패·시간 초과 뒤에는 이 실행이 시작한 세션을 멈춘다.
- Aside가 없으면 기존 엔진으로 돌아간다(필수 의존으로 만들지 않는다).

## 3. 검증

- 원본의 `test/aside.test.mjs`·`test/aside-orchestration.test.mjs`를 가져와 사용자 코드의 함수 이름·경로에 맞게 고친 뒤 통과시킨다. 사용자 저장소의 전체 검사(예: `npm run check`)도 통과해야 한다.
- Aside가 설치돼 있으면 `scripts/aside-fixture-checks.mjs`(`npm run verify:aside`)로 실제 Aside를 가짜 로컬 사이트(외부 발송 없음)에 돌려 댓글·글·첨부 메일·웹사이트 작업 4종을 확인한다. 연결한 구독 사용량이 든다.
- 끝나면 사용자에게 옮긴 것, 옮기지 않은 것(사용자 코드에 해당 기능이 없어 뺀 것), 검증 결과를 짧게 보고한다.
