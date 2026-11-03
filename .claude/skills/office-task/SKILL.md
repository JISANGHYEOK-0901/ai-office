---
name: office-task
description: 비서실장(메인 세션)이 사무 업무 요청을 받아 업무 등록 → 담당 확인(없으면 [회의]) → plan.json 작성·검사 → 계획대로 직원(서브에이전트) 병렬 배정·부서 간 협조 → 검토(flow review, 반려 최대 2회) → report.md → flow deliver(검토 후 자동 완료)까지 진행하는 절차. 산출물이 필요한 업무 요청(조사, 문서·HTML·엑셀·PPT 작성, 정산, 계약 검토 등)을 받으면 사용한다.
---

# office-task: 업무 처리 체크리스트

각 단계를 끝내면 체크하고 다음으로 넘어간다. 서브에이전트(직원)는 다른 서브에이전트를 부를 수 없으므로 배정·협조·반려 지시는 모두 비서실장이 한다. 명령 형식은 프로그램 폴더의 `docs/SPEC.md`와 같다.

**직접 실무 금지:** 업무 등록 뒤에는 웹 수집·스크립트 실행·산출물 작성을 직접 하지 않는다. `hooks/chief-guard.mjs`가 거부한다.
- 허용: Read·Glob·Grep, 근무중 직원 Agent 호출, `node scripts/office.mjs …`·`node scripts/codex-review.mjs …` 단독 실행(`cd`·`&&`·`;`·`|`·리다이렉션·`$` 없이, 특수문자 값은 작은따옴표), `outputs/<id>/`의 `brief.md`·`meeting.md`·`plan.json`·`report.md`·`review-notes.md` 작성
- 업무 폴더 파일 목록은 `node scripts/office.mjs task files <id>`로 본다(Glob·Grep이 없는 세션에서도 된다).
- Agent를 `run_in_background: true`로 부르지 않는다(거부된다). 병렬은 한 응답에서 여러 Agent를 동시에 호출하고 모두 끝날 때까지 기다린다.
- plan의 모든 단계, 검토, `flow deliver`가 끝나기 전에 "진행 중"이라는 최종 답변으로 종료하지 않는다(헤드리스 실행은 그 답변으로 끝나 업무가 멈춘다).
- 거부되면 우회하지 말고 사유대로 고친다. 필요한 직원이 없으면 대신 하지 말고 `plan.json`의 `gaps`에 적는다.

대시보드의 제어 실행 중에는 주입된 phase/JSON 응답 계약을 우선한다. 비서실장은 기본 최종 검토자이며 별도 검증실 부재를 공백으로 알리지 않는다. 전문 검토는 대표가 요청한 경우만 추가한다. 직원 질문·오전달·팀장 분담은 needs_decision/reroute/delegate 응답으로 실행기에 전달하고 직접 다른 직원을 호출하지 않는다. 지속 감시는 실행기가 계속 유지하며 새 자료의 후속 업무와 동시에 진행한다. 대표가 지시한 메일·글/댓글 게시만 publications로 계획하고 검토 후 연결된 office_browser로 실행한다. 로그인 값은 읽거나 요구하지 않는다. 아래 CLI 절차는 터미널에서 직접 업무를 운영할 때 사용한다.

## 1. 요청 분류

- [ ] 단순 질문인가? 그렇다면 이 절차 없이 직접 답한다.
- [ ] 산출물·완료 기준을 한 문장으로 정리했다.
- [ ] 대시보드에서 헤드리스(`claude -p`)로 실행 중일 수 있다고 보고 질문을 최소화했다. 대표는 대시보드의 "이어서 답하기"로만 답할 수 있다.
  - 대표에게는 비용 발생·외부 발송·법적 판단·되돌리기 어려운 결정만 묻는다. 분담·범위는 회의(4단계)로 정한다.
  - 그 밖의 모호함은 묻지 않고 합리적으로 가정해 `가정:`으로 밝힌 뒤 진행한다.
  - 물을 때는 번호 목록으로 한 번에 묶고, 질문마다 `(권장 기본값: …)`을 붙이고, "답장 또는 '기본값으로 진행'이라고 답하면 됩니다."로 끝낸다. 대표가 "기본값으로 진행"이라고 답하면 권장 기본값으로 진행한다.

## 2. 업무 등록

- [ ] `node scripts/office.mjs task start "<제목>" --slug <영문-슬러그>` 실행
- [ ] 출력 마지막 줄 `OFFICE_TASK=<id>`에서 업무 id를 확인했다. 업무 폴더는 `outputs/<id>/`. 이때부터 직접 실무 금지가 적용된다.

## 3. 조직·담당 확인

- [ ] 세션 시작 때 주입된 "현재 조직도"에서 근무중 직원·부서 역량·협조 관계(handoffs)를 확인했다. 없으면 `org/roster.json`·`org/departments.json`을 Read로 본다. 부서 이름을 짐작하지 않는다.
- [ ] 지시문에 담당(부서·이름·직무)이 적혀 있으면 그대로 매칭했다. 예: "마케팅이 조사하고 최대리가 HTML 작성, 비서실장이 검토".
- [ ] 매칭되지 않는 담당이 있거나, 지시문에 담당(부서·이름·직무)이 하나도 없고 관련 근무중 부서가 둘 이상이면 4단계 회의로 간다. 요청이 짧거나 "간단히"여도 생략하지 않는다(비서실장 혼자 분담을 정하지 않는다). 담당이 모두 분명하거나 근무중 부서가 하나뿐이면 5단계로 간다.
- [ ] 휴무·없는 직원, 내장 에이전트(`general-purpose` 등)는 부르지 않는다. Codex 검증실 직원은 `codex-review.mjs`로만 부른다.

## 4. 회의 (담당이 없을 때)

- [ ] `node scripts/office.mjs meeting <id> start --attendees <직원id,직원id> --agenda "<안건>"`
- [ ] 관련 부서 팀장·담당 2~4명을 한 메시지에서 Agent로 병렬 호출했다. `description`과 지시문 모두 `[회의]`로 시작하고, 요청 요지와 각자 제안할 것(범위·산출물·분담·순서·가정)을 적었다.
- [ ] 제안을 취합해 `outputs/<id>/meeting.md`(참석자·안건·결정·가정·분담)를 썼다. 이견이 크면 취합안으로 2차 회의를 열었다.
- [ ] `node scripts/office.mjs meeting <id> end --summary "<결정 요약>"`

## 5. 작업 계획표

- [ ] `outputs/<id>/plan.json`을 썼다.
  ```json
  {"version":1,"task":"<id>","goal":"…",
   "stages":[{"id":"research","title":"…","dept":"<부서id>","agent":"<직원id>","inputs":[],"output":"outputs/<id>/<부서id>/<파일>","done":"완료 기준","dependsOn":[],"parallelGroup":"a"}],
   "review":{"by":"chief","criteria":"…"},
   "gaps":[{"need":"HTML 작성","suggestion":"개발부 추가 권장"}]}
  ```
  - `agent`는 근무중 직원 id, `dept`는 그 직원의 부서. `output`은 `outputs/<id>/<부서id>/<직원id>-<내용>.<확장자>`. 직원은 report·summary·findings·analysis로 시작하는 `.md` 파일을 쓸 수 없다(Claude Code 제한, plan validate가 거부). `inputs`는 앞 단계 id·output 경로나 이미 있는 파일.
  - 필요한 역량의 근무중 부서가 없으면 그 일은 단계로 만들지 않고 `gaps`에 적는다.
- [ ] `node scripts/office.mjs plan validate <id>` 통과. 실패하면 사유대로 고쳐서 다시 실행했다.
- [ ] `outputs/<id>/brief.md`에 요청 요지·완료 기준·배정표(단계별 담당·입력·출력·완료 기준)를 채웠다. 비밀값은 적지 않았다.

## 6. 계획대로 실행

- [ ] 계획에 있는 직원만 계획 순서대로 불렀다. 계획을 바꿔야 하면 plan.json을 고치고 다시 검사했다.
- [ ] 의존이 없거나 앞 단계가 끝난 단계, 같은 `parallelGroup` 단계는 한 메시지에서 Agent를 여러 번 호출해 병렬로 배정했다. `subagent_type`은 직원 id.
- [ ] 지시문마다 포함했다:
  - 업무 폴더 `outputs/<id>/`
  - 이번 단계의 입력(앞 단계 산출물 경로)·출력(이번 산출물 경로)·완료 기준 — brief.md 배정표 그대로
  - 참고할 원본 파일 경로
  - 보고 형식(결과 첫 문장에 산출물 경로 / 산출물 / 근거 / 확인 필요)
- [ ] 다른 부서의 결과를 이어받는 단계는 앞 단계가 끝난 뒤, 배정 직전에 `node scripts/office.mjs flow <id> cooperate --from <부서A> --to <부서B> --note "<넘기는 것>"`를 기록하고 배정했다.
- [ ] 외부 제출 문서·최종 시장 분석·복잡한 논리 문서는 Agent 호출에 `model: "opus"`를 지정했다. 대량 페이지 수집·분류는 haiku 직원에게 나눠 맡겼다.
- [ ] 부서 보고서가 필요하면 계획의 팀장 취합 단계로 `outputs/<id>/<부서id>/dept-report.md`를 쓰게 했다.

## 7. 검토

- [ ] `node scripts/office.mjs flow <id> review-request --from <부서>`
- [ ] `node scripts/office.mjs task files <id>`로 산출물 목록과 계획 단계 산출물(있음/없음)을 확인했다. '없음' 단계는 작업 완료로 보고됐어도 `[반려]`로 파일 작성을 다시 지시했다.
- [ ] 산출물을 Read로 확인하고 plan.json의 `review.criteria`와 각 단계 완료 기준으로 판단했다. 지적은 `outputs/<id>/review-notes.md`에 적었다.
- [ ] 대표가 별도 전문 검증을 요청한 경우에만 `node scripts/codex-review.mjs --target outputs/<id> --task <id> [--reviewers ...]` 실행
  - 재무 숫자 → `number-auditor`, 사실 주장 → `fact-checker`, 문서 → `document-qa`, 코드 → `code-reviewer`, 종합 → `verification-lead` (직무 key 또는 직원 id)
  - `outputs/<id>/reviews/*.md`의 판정(PASS/FIX/BLOCK)을 읽었다. 종료 코드 2는 BLOCK이 있다는 뜻이다.
- [ ] 결과를 기록했다: `node scripts/office.mjs flow <id> review --verdict pass|reject --to <부서> --reason "<사유>"`
- [ ] 반려면 해당 부서 직원을 다시 불렀다. `description`과 지시문 모두 `[반려]`로 시작하고 사유·수정 기준·입력·출력을 적었다. 원인이 앞 단계면 앞 단계 부서로 보냈다. 고친 뒤 이 단계를 다시 밟았다.
- [ ] 반려는 최대 2회(3번째는 CLI·가드가 거부). 부서에 단계가 여럿이면 `--to <직원 id>`나 `--stage <단계 id>`로 지정했다. 그래도 해결되지 않으면 남은 문제를 report.md "확인 필요"에 적고 blocked로 두었다. 검토 통과한 업무만 8단계에서 완료한다. BLOCK이 남아 있으면 완료로 쓰지 않았다.

## 8. 보고·완료

- [ ] `outputs/<id>/report.md`를 작성했다: `## 완료` / `## 확인 필요`(역량 공백·남은 문제 포함) / `## 근거`(검토 판정과 반영 여부 포함)
- [ ] 검토 통과와 보고서·최종 산출물을 확인하고 `node scripts/office.mjs flow <id> deliver`를 실행했다. 업무는 `done`으로 자동 완료되며 대표 승인을 요청하지 않는다.
- [ ] 대표에게 결과 요약, 확인 필요 항목, report.md 경로를 전달했다.
- [ ] 대표 결정·외부 자료를 기다리면 `node scripts/office.mjs task status <id> blocked`

## 9. 사용자 반려

- [ ] 대표 피드백이 "이어서 답하기"로 오면 반영할 단계를 정해 해당 부서에 `[반려]`로 재배정하고 7~8단계를 다시 밟았다.
- [ ] 완료 모달에는 완료 작업과 최종 산출물만 전달했다. 결과 확인은 알림 읽음 처리이며 추가 승인을 요구하지 않았다. 완료 후 추가 수정은 새 업무로 처리한다.
