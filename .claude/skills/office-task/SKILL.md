---
name: office-task
description: 비서실장(메인 세션)이 사무 업무 요청을 받아 업무 등록 → 직원(서브에이전트) 병렬 배정 → 팀장 취합 → Codex 검증 → 수정 → report.md → 완료 처리까지 진행하는 절차. 산출물이 필요한 업무 요청(조사, 문서·엑셀·PPT 작성, 정산, 계약 검토 등)을 받으면 사용한다.
---

# office-task: 업무 처리 체크리스트

각 단계를 끝내면 체크하고 다음으로 넘어간다. 서브에이전트(직원)는 다른 서브에이전트를 부를 수 없으므로 배정과 취합 지시는 모두 비서실장이 한다.

## 1. 요청 분류

- [ ] 단순 질문·한 줄 수정인가? 그렇다면 이 절차 없이 직접 답한다.
- [ ] 산출물·완료 기준을 한 문장으로 정리했다. 모호하면 대표에게 한 번만 짧게 묻는다.
- [ ] 필요한 부서·직무를 골랐다(조사 → research, 문서·보고서 → business, 숫자·정산 → finance, 계약 → legal 등).

## 2. 업무 등록

- [ ] `node scripts/office.mjs task start "<제목>" --slug <영문-슬러그>` 실행
- [ ] 출력 마지막 줄 `OFFICE_TASK=<id>`에서 업무 id를 확인했다. 업무 폴더는 `outputs/<id>/`.
- [ ] `outputs/<id>/brief.md`에 요청 요지·완료 기준·배정표를 채웠다. 비밀값은 적지 않았다.

## 3. 직원 확인

- [ ] `org/roster.json`과 `.claude/agents/`에서 근무중인 직원 id를 확인했다.
- [ ] 필요한 직무의 직원이 없으면 지어내지 않고, 대표에게 "대시보드에서 <부서>에 <직무> 직원을 추가해 주세요"라고 안내했다.
- [ ] 휴무 직원(에이전트 파일 없음)은 부르지 않는다.

## 4. 병렬 배정

- [ ] 서로 의존하지 않는 일은 한 메시지에서 Agent 도구를 여러 번 호출해 병렬로 배정한다. `subagent_type`은 직원 id.
- [ ] 지시문마다 포함했다:
  - 업무 폴더 `outputs/<id>/`
  - 산출물 위치 `outputs/<id>/<부서id>/<직원id>-<내용>.md`
  - 맡은 범위와 완료 기준, 참고할 원본 파일 경로
  - 보고 형식(결과 / 산출물 / 근거 / 확인 필요)
- [ ] 외부 제출 문서·최종 시장 분석·복잡한 논리 문서는 Agent 호출에 `model: "opus"`를 지정했다. 대량 페이지 수집·분류는 haiku 직원에게 나눠 맡겼다.
- [ ] 의존 관계가 있는 일(예: 조사 → 보고서)은 앞 단계 산출물 경로를 다음 지시에 넣어 순서대로 배정한다.

## 5. 팀장 취합

- [ ] 부서원 작업이 끝나면 각 부서 팀장을 불러 `outputs/<id>/<부서id>/summary.md`를 쓰게 했다.
- [ ] 팀장이 없는 부서는 비서실장이 직접 취합했다.
- [ ] 직원 보고의 "확인 필요" 항목을 모았다.

## 6. Codex 검증

- [ ] `node scripts/codex-review.mjs --target outputs/<id> --task <id> [--reviewers ...]` 실행
  - 재무 숫자 → `number-auditor`, 사실 주장 → `fact-checker`, 문서 → `document-qa`, 코드 → `code-reviewer`, 종합 → `verification-lead`
  - 위 값은 직무 key다. 화면에서 만든 직원(id 예: `verify-1`)도 직무 key로 찾는다. 직원 id를 직접 써도 된다.
- [ ] `outputs/<id>/reviews/*.md`의 판정(PASS/FIX/BLOCK)을 읽었다. 종료 코드 2는 BLOCK이 있다는 뜻이다.

## 7. 수정

- [ ] FIX·BLOCK 지적마다 담당 직원을 다시 불러 고쳤다.
- [ ] 재무 숫자는 원본과 다시 대조했다. 송금·발송·결제·신고는 하지 않았다.
- [ ] 필요하면 검증을 다시 실행했다. BLOCK이 남아 있으면 완료로 보고하지 않는다.

## 8. 최종 보고

- [ ] `outputs/<id>/report.md`를 작성했다: `## 완료` / `## 확인 필요` / `## 근거`(Codex 판정과 반영 여부 포함)
- [ ] 대표에게 결과 요약, 확인 필요 항목, report.md 경로를 전달했다.

## 9. 상태 변경

- [ ] 끝났으면 `node scripts/office.mjs task status <id> done`
- [ ] 대표 결정·외부 자료를 기다리면 `node scripts/office.mjs task status <id> blocked`
