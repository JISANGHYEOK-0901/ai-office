import { test } from 'node:test';
import { verifyBrowserWork } from '../scripts/browser-fixture-checks.mjs';
import { verifyLogin } from '../scripts/login-fixture-checks.mjs';
test('실제 Playwright 브라우저: 로컬 가짜 사이트 발송·게시·댓글과 재실행 방지', async () => { await verifyBrowserWork(); });
test('실제 Playwright 브라우저: 직원 첫 로그인과 네이버웍스 단계형 인증', async () => { await verifyLogin(); });
