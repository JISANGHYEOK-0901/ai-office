import { test } from 'node:test';
import { verifyBrowserWork } from '../scripts/browser-fixture-checks.mjs';
import { verifyLogin } from '../scripts/login-fixture-checks.mjs';
import { verifyWebWork } from '../scripts/web-fixture-checks.mjs';
import { verifyMailEditor } from '../scripts/mail-fixture-checks.mjs';
test('실제 Playwright 브라우저: 로컬 가짜 사이트 발송·게시·댓글과 재실행 방지', async () => { await verifyBrowserWork(); });
test('실제 Playwright 브라우저: 직원 첫 로그인과 네이버웍스 단계형 인증', async () => { await verifyLogin(); });
test('실제 Playwright 브라우저: 일반 웹사이트 입력·파일 첨부·업로드 증표와 차단 규칙', async () => { await verifyWebWork(); });
test('실제 Playwright 브라우저: 메일 서명 유지와 보낸메일함 발송 확인', async () => { await verifyMailEditor(); });
