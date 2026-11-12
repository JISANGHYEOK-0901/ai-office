# Aside 기능 옮기기 (AI용 안내)

이 문서는 AI Office에서 출발했지만 지금은 **구조와 화면(UI/UX)이 크게 달라진 플랫폼**에 Aside 기능만 옮길 때 그 플랫폼의 AI가 읽는다. 원본은 [PR #63](https://github.com/JISANGHYEOK-0901/ai-office/pull/63)(Aside 직원 엔진)과 [PR #64](https://github.com/JISANGHYEOK-0901/ai-office/pull/64)(글 결과 확인 오류 수정·결과 확인 재시도·카페 공식 API 우선)다. **두 PR을 함께 옮긴다.** #63만 옮기면 Aside가 올린 글이 결과 확인에서 실패해 "불확실"로 멈춘다.

코드 차이(diff)를 그대로 붙이지 않는다. 파일 이름이 아니라 **기능별 계약**(무엇을 받고, 무엇을 내고, 어떤 순서로 하는지)을 그 플랫폼에서 같은 역할을 하는 자리에 구현한다. ai-office의 파일 위치는 5장에 참고로만 둔다.

## 0. 시작 전에

- **옮기기 전에 사용자 코드의 지금 상태를 커밋한다**(문제가 생기면 되돌릴 수 있게). 작업은 별도 브랜치에서 하고, 사용자가 만든 기능은 유지한다.
- 원본은 별도 폴더에 읽기 전용으로 받는다. 사용자 저장소에 원격으로 추가해 merge·rebase하지 않는다.
  ```bash
  git clone https://github.com/JISANGHYEOK-0901/ai-office.git ../ai-office-upstream
  ```
- 원본에서 함께 볼 것: `docs/SPEC.md`의 "Aside 직원" 절, `docs/DECISIONS.md`의 "Aside 직원"·"Aside 결과 확인 재시도와 카페 API 우선" 결정, `GUIDE.html`의 Aside 탭.
- 그 플랫폼에 없는 기능(예: 메일 발송, 카페 공식 API, 지속 감시)에 기대는 부분은 빼고, 무엇을 뺐는지 끝에 보고한다.

## 1. 그대로 복사하는 것: `lib/aside.mjs`

Aside CLI를 다루는 모듈이다. Node 표준 모듈 외에는 명령 실행 보조 함수 4개(`findExecutable`·`resolveCommand`·`spawnCli`·`killTree`, 원본 `lib/cli.mjs`)에만 기댄다. 이 4개를 함께 가져가거나 그 플랫폼의 같은 기능으로 바꾸면 그대로 동작한다.

| 제공 기능 | 하는 일 |
|---|---|
| `resolveAside()`·`asideInstalled()` | CLI 찾기: `ASIDE_BIN` > PATH > `~/.local/bin/aside` |
| `createAside().status()` | 설치·실행·로그인 상태(이메일은 싣지 않음, 앱이 꺼져 있으면 띄우지 않음) |
| `readPage(url, {hosts, waitFor, settleMs})` | 숨은 탭으로 화면 글자 읽기 → `{url, text, needsLogin, protected}` |
| `links(url, {match, ready})` | 숨은 탭에서 글자에 match가 든 링크 목록 → `{links:[{text, href}]}` |
| `checkLogin(url)` | `{status: 'ok' \| 'needs_login' \| 'protected'}` |
| `openVisible(url)` | 대표가 보는 Aside 창의 현재 탭에 주소 열기(맥은 창을 앞으로) |
| `stopSessions(sinceIso)` | 이 실행 뒤 CLI가 시작해 아직 도는 세션 멈추기 |
| `stageFiles(files)` | 첨부를 Aside 작업 폴더(`~/.aside/u/0/ai-office/<임의>`)에 복사 → `{files, cleanup}` |
| `asideExecArgs`·`parseExecOutput` | `aside exec --json` 인자 만들기·마지막 JSON 줄 읽기 |
| `asidePublishPrompt` | 외부 작업 지시문(2-6) |
| `agentEngine`·`asideAdvice` 등 | ai-office 조직 구조 전용. 그 플랫폼 구조에 맞게 고치거나 뺀다 |

**실측한 Aside 동작(2026-11-12, CLI 1.26.1111):**
- `aside repl` 탭은 화면에 안 보이고 CLI가 끝나면 닫힌다. 같은 프로필의 로그인은 그대로 쓴다. 보이는 탭을 앞으로 바꾸는 기능은 없어서, 보여 주려면 `attachActiveBrowserTab()`으로 현재 탭을 쓴다.
- `aside exec`은 지시문을 **인자**로 받는다(표준 입력 아님). `--json` 출력의 마지막 줄은 `{session, outcome, answer, error}`다.
- CLI를 끝내도 Aside 세션은 계속 돈다. 그래서 따로 멈춰야 한다.
- 에이전트는 기본 권한에서 `~/.aside/u/0` 밖의 파일을 못 읽는다.
- REPL은 Playwright와 비슷하지만 `allTextContents`·`page.mainFrame`·`ariaSnapshot`·`evaluateHandle`·`page.route`가 없다. `setInputFiles`는 세션 폴더 밖 경로를 거부하고, `[{name, mimeType, buffer}]` 배열은 받는다.

## 2. 기능별로 다시 만드는 것

### 2-1. Aside를 AI 실행 방식 하나로 추가

- **언제:** 그 작업 단위(직원·에이전트 등)를 Aside로 지정했고 Aside CLI가 있을 때. CLI가 없으면 원래 실행 방식으로 돌린다(필수 의존으로 만들지 않는다).
- **실행:** `aside exec --json --timeout 60m <지시문>`. 지시문은 Aside 전용 규칙(2-6) + 작업 지시다. Windows는 명령줄이 32,767자까지라 여유를 두고 막는다.
- **결과:** 출력 마지막 JSON 줄의 `answer`. `outcome`이 `completed`가 아니면 실패다.
- **끝난 뒤:** 중지·실패·시간 초과면 `stopSessions(실행 시작 시각)`.
- **파일:** Aside에는 파일을 읽고 쓰게 하지 않는다. 입력 파일은 내용을 지시문에 붙이고(파일당 2만 자, 합계 6만 자, 비밀번호·계정 파일 위치는 넣지 않음), 답 JSON의 `content`를 플랫폼이 출력 파일로 저장한다. 엑셀·문서·이미지 같은 파일 산출물은 맡기지 않는다.
- **맡기지 않는 일:** 공개 웹 조사. Aside 기본 프로필에는 대표 로그인이 있고 사내 주소 차단을 할 수 없다. 로그인 없는 임시 브라우저를 쓰는 기존 방식을 유지한다.

### 2-2. 로그인

1. 작업 전에 `checkLogin(대상 주소)`.
2. `protected`면 멈춘다(자동 재시도 금지).
3. `needs_login`이면 `openVisible(그 서비스 로그인 주소)` → 3초 간격 `checkLogin` → 최대 30분 기다린다. 로그인되면 대표 답장 없이 이어 간다.
4. 비밀번호는 대표가 직접 입력한다. 코드(특히 `aside repl`)에 비밀번호를 넣지 않는다(Aside 로컬 기록에 남을 수 있다).

### 2-3. 외부 작업(메일·글·댓글) 안전 흐름: 이 순서를 지킨다

1. 같은 대상·같은 원문의 기록이 "확인 완료"면 다시 하지 않는다. "불확실"이면 대표 확인 전까지 멈춘다.
2. 로그인 확인(2-2).
3. **실행 전 화면 기록:** 댓글은 대상 글에 원문 앞부분이 몇 번 나오는지, 메일은 보낸메일함에서 같은 제목 메일의 id 목록.
4. **기록을 `committing`으로 저장한다.** Aside가 버튼을 누를 수 있는 순간부터 결과를 모르는 상태로 다룬다.
5. 첨부가 있으면 `stageFiles`로 Aside 작업 폴더에 복사한다.
6. Aside 실행. 지시문은 `asidePublishPrompt`를 쓴다. 원문을 `<<<본문 … 본문>>>`으로 그대로 넣고, 한 번만 누르고, 결과를 `{status, summary, resultUrl, completed, submitted, question}` JSON으로 받는다.
7. 첨부 사본을 지운다(`cleanup`).
8. **결과 확인:** 실행은 다시 하지 않고, 3초 간격으로 최대 3번 **다시 읽기만** 한다.
   - 댓글: 원문 앞부분 수가 실행 전보다 늘었는지
   - 글: 직원이 보고한 `resultUrl`(그 서비스 주소일 때만)에서 제목과 본문. 유튜브·지도 링크 줄은 카드로 바뀌므로 빼고 본문만 비교한다.
   - 메일: 보낸메일함에 새로 생긴 메일의 상세 화면에서 본문과 받는사람 전원. 보낸사람 주소를 모르면 받는사람 외에 주소 하나만 더 있어도 인정한다.
   - 글자 비교는 NFKC로 정규화한 뒤 공백·폭 없는 문자를 지우고 한다. 화면 대기 조건도 같은 기준으로 맞춘다.
9. 확인되면 "확인 완료"(결과 주소 포함)로 둔다. 안 보이면 다음처럼 처리한다.
   - 직원이 `submitted:false`(누르지 않음)라고 보고했으면: "준비"로 두어 다시 할 수 있게 한다.
   - 그 밖: "불확실"로 두고 이유를 기록한다. 대표에게 결과 주소와 함께 "올라간 것 확인했어" 또는 "미발송 확인, 재발송"으로 답하게 안내한다.

**#64에서 고친 버그(꼭 피할 것):** 결과 확인 중에 계정 정보(보낸사람 주소 등)를 조회하면, Aside는 계정 연결이 없어 오류가 나고 확인이 실패한다. 계정 조회는 메일 확인일 때만 하고, 실패해도 넘어가게 만든다.

**카페 공식 API가 있는 플랫폼이면:** 일반 카페 글은 API로, 장소(네이버 지도) 카드가 필요한 글만 Aside로 올린다(카드는 편집기에 링크를 붙여 넣을 때만 생긴다).

### 2-4. 일반 웹사이트 작업(관리 화면 저장·업로드 등)

2-3의 1·2·4·5·6·7 단계는 같다. 사이트마다 완료 화면이 달라서 결과는 직원 보고(`completed`·`summary`·`resultUrl`)를 증표로 남긴다. `completed:false`면 미완료로 두고 완료로 닫지 않는다.

### 2-5. 로그인한 사이트 조회

지시에 다음을 넣는다.
- 대상 주소에서 시작한다. 읽기 전용이다(저장·등록·수정·삭제·발송 금지).
- 대표 요청에 맞는 메뉴·검색·필터를 스스로 찾고, 범위가 정해졌으면 그 범위만 연다.
- 로그인 화면이 나오면 입력하지 말고 `needs_decision`으로 알린다.
- 숫자는 화면 원문 표기(예: 1.3K)를 함께 적는다.

결과는 답 JSON의 `content`로 받는다(2-1).

### 2-6. Aside 지시문

- **Aside 전용 규칙**(원본 `lib/sync.mjs`의 `asideRules`)을 지시문 앞에 붙인다. 내용은 다음과 같다.
  - 보이는 탭에서 작업
  - 파일 대신 JSON 응답
  - 로그인·인증·보호 조치에는 입력하지 않음
  - 숫자는 원문 표기
  - 한국어로 보고
- 그 플랫폼의 일반 AI 규칙 중 "파일을 써라", "특정 브라우저 도구를 써라" 같은 지시는 Aside 지시문에 넣지 않는다. 두 규칙이 부딪친다.
- 외부 작업 지시문은 `asidePublishPrompt`를 그대로 쓴다.

### 2-7. 안내(선택)

Aside 설치 여부와 Aside로 바꾸면 좋은 작업 단위(예전에 메일·글·사이트 일을 맡은 것)를 플랫폼 화면이나 점검 명령에 알린다. 브라우저 업무가 없는 사용자에게 계속 띄우지는 않는다.

### 2-8. 화면(UI/UX): 요구사항만 옮기고 모양은 그 플랫폼 규칙대로

ai-office의 화면 코드·색·배치·문구 위치를 복사하지 않는다. 그 플랫폼의 기존 화면 부품·스타일·말투를 쓰고, 아래 **사용자가 할 수 있어야 하는 일과 봐야 하는 정보**만 맞춘다.

| 요구사항 | 내용 |
|---|---|
| 켜고 끄기 | 작업 단위(직원·에이전트 등)마다 "Aside로 실행"을 켜고 끌 수 있다. 끄면(비우면) 원래 실행 방식이다. 켰는데 Aside가 없으면 원래 방식으로 돈다는 것을 알 수 있게 한다 |
| 로그인 안내 | 로그인이 필요하면 "Aside 창에 로그인 화면을 열었다. 직접 로그인하면 이어 간다"를 그 플랫폼의 알림 방식으로 보여 준다. 보호 조치면 "서비스에서 직접 해제 후 답장"을 안내한다 |
| 불확실 정지 | 멈춘 이유, 직원이 보고한 결과 주소, 답하는 방법("올라간 것 확인했어" / "미발송 확인, 재발송")을 한 번에 보여 준다 |
| 권장 안내 | Aside로 바꿀 대상이 있을 때만, 닫을 수 있게 보여 준다 |
| 실행 표시(선택) | 실행 기록·진행 화면에 Aside가 처리했다는 표시 |
| 사용 설명 | 그 플랫폼의 문서 형식으로 쓴다. Aside 앱 설치·첫 세팅(가입, 브라우저 데이터 가져오기 건너뛰기, 구독 선택, 기본 브라우저 유지, 업무 사이트 로그인)은 플랫폼과 상관없어 원본 `GUIDE.html` Aside 탭을 참고한다 |

바꾼 화면은 그 플랫폼의 화면 확인 방식(데스크톱·모바일 캡처, 화면 검사 스크립트 등)으로 확인한다.

## 3. 꼭 지킬 규칙

- 비밀번호·쿠키를 다루지 않는다. 로그인은 대표가 Aside에서 직접 한다.
- 외부 작업은 실행 전에 기록하고, 실행 뒤 화면을 다시 읽어 원문을 대조한다. 결과를 모르면 다시 실행하지 않는다.
- 공개 웹 조사는 Aside에 맡기지 않는다.
- 첨부는 Aside 작업 폴더에 잠깐 복사했다가 지운다.
- 멈춘 Aside 세션은 정리한다.
- Aside가 없으면 원래 방식으로 돌아간다.

## 4. 꼭 확인할 상황 (그 플랫폼에 맞게 테스트로 만든다)

| 상황 | 기대 결과 |
|---|---|
| Aside CLI 없음 | 원래 실행 방식으로 돈다 |
| `exec` 출력 해석 | `answer`를 결과로 쓴다. 실패·중지 뒤 세션을 멈춘다 |
| 로그인 필요 | 실행 전에 알리고(대기), 기록을 남기지 않는다 |
| 보호 조치 | 멈추고 다시 시도하지 않는다 |
| 댓글 | 실행 뒤 문구 수가 늘면 확인 완료. 같은 대상을 다시 요청하면 실행하지 않는다 |
| 결과가 안 보임 | 불확실로 멈춘다. `submitted:false`면 다시 할 수 있게 둔다 |
| 첫 읽기 실패 | 다시 읽어 확인한다(실행은 1번만) |
| 글 | `resultUrl`의 제목·본문으로 확인한다. 다른 사이트 주소면 확인하지 않는다 |
| 메일 | 새 보낸 메일 상세로 확인하고, 첨부 사본을 지운다 |
| 계정 조회가 오류를 내는 환경 | 글 확인이 성공해야 한다(#64 회귀 방지) |
| 공개 웹 조사·파일 산출물 배정 | Aside에 맡기지 않는다 |
| 카페 공식 API 연결됨 | 일반 글은 API, 장소 카드 글만 Aside |

실제 Aside 시험은 원본 `scripts/aside-fixture-checks.mjs`처럼 **가짜 로컬 사이트**(댓글·글·첨부 메일·웹 작업)에서 한다. 바깥 사이트에는 보내지 않는다. 연결한 구독 사용량이 든다.

## 5. ai-office에서의 위치 (참고)

| 기능 | ai-office 파일 |
|---|---|
| Aside 모듈 | `lib/aside.mjs` |
| 실행 방식(2-1) | `dashboard/runner.mjs`의 `buildSpec`·`asideSpec`·출력 해석, `dashboard/orchestrator.mjs`의 `engineFor`·단계 실행 |
| 로그인(2-2) | `lib/browser-work.mjs`의 `asideCheckLogin`·`asideRequestLogin`, `dashboard/orchestrator.mjs`의 `asideLogin` |
| 외부 작업(2-3·2-4) | `lib/browser-work.mjs`의 `deliverAside`·`deliverWebAside`·`resultSeen`·`sentMailReceipt` |
| 지시문(2-6) | `lib/sync.mjs`의 `asideRules`, `lib/aside.mjs`의 `asidePublishPrompt` |
| 안내(2-7) | `lib/doctor.mjs`의 `asideCheck`, 대시보드 배너(`asideBanners`) |
| 화면(2-8, 참고만) | `dashboard/public/index.html`·`app.js`의 직원 편집 "엔진: Aside", 부서 엔진, 배너, aside 표시 |
| 테스트 | `test/aside.test.mjs`, `test/aside-orchestration.test.mjs` |

## 6. 끝나면 보고

다음을 짧게 보고한다.
- 옮긴 기능
- 그 플랫폼에 없어서 뺀 기능
- 테스트 결과
- 화면에서 Aside를 켜는 곳(그 플랫폼 화면 기준)
- 대표가 할 일(Aside 설치·첫 세팅·업무 사이트 로그인, Aside로 바꿀 작업 단위)
