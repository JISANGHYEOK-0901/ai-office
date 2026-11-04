import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSources, extractSources, isPrivateAddress, sourceProblemReason, titleMatches } from '../lib/source-check.mjs';

const page = (title, { status = 200, type = 'text/html', location = null } = {}) => new Response(status >= 300 && status < 400 ? null : `<html><head><title>${title}</title></head></html>`,
  { status, headers: { 'content-type': type, ...(location ? { location } : {}) } });
const publicDns = async () => [{ address: '93.184.216.34' }];

test('출처 추출: 표·목록·괄호 링크에서 주소만 뽑고 끝 문장부호와 중복을 뺀다', () => {
  const urls = extractSources('| 제목 | https://a.example/x |\n- [글](https://b.example/y).\nhttps://a.example/x\n<a href="https://c.example/z">c</a>').map((s) => s.url);
  assert.deepEqual(urls, ['https://a.example/x', 'https://b.example/y', 'https://c.example/z']);
  assert.deepEqual(extractSources('[위키](https://en.wikipedia.org/wiki/Tesla_Roadster_(second_generation)). (https://a.example/y)').map((s) => s.url), ['https://en.wikipedia.org/wiki/Tesla_Roadster_(second_generation)', 'https://a.example/y']);
  assert.match(extractSources('## Tesla reveals Roadster\n\n링크: https://a.example/x')[0].context, /Tesla reveals Roadster/);
});

test('제목 대조: 사이트 이름·기호를 빼고 비교하며 짧거나 차단 화면이면 판단하지 않는다', () => {
  assert.equal(titleMatches('Tesla reveals SpaceX-powered Roadster | TechCrunch', '제목: Tesla reveals SpaceX powered Roadster'), true);
  assert.equal(titleMatches('Tesla reveals SpaceX-powered Roadster | TechCrunch', 'Tesla sets Roadster event for Thursday'), false);
  assert.equal(titleMatches('Tesla&#8217;s new Roadster is here - Electrek', 'Tesla’s new Roadster is here'), true);
  assert.equal(titleMatches('Tesla Roadster: reservar la versi&oacute;n que vuela cuesta mucho', 'Tesla Roadster: reservar la versión que vuela cuesta mucho'), true);
  assert.equal(titleMatches('Just a moment...', '아무 글'), true);
  assert.equal(titleMatches('Home', '아무 글'), true);
});

test('내부 주소 판별', () => {
  for (const ip of ['10.0.0.1', '127.0.0.1', '192.168.0.5', '172.20.1.1', '169.254.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '0.0.0.0']) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('출처 확인: 열림·깨짐·제목 불일치·차단·DNS 실패를 구분한다', async () => {
  const text = ['Good article title here', 'https://a.example/ok', '', '', '', '', '', '', '', '', 'Wrong title written', 'https://a.example/title', '', '', '', '', '', '', '', '', 'https://a.example/gone', 'https://a.example/blocked', 'https://nodns.example/x'].join('\n');
  const seen = [];
  const result = await checkSources([{ stage: 'collect', text }], { lookup: async (host) => {
    if (host === 'nodns.example') throw Object.assign(new Error('x'), { code: 'ENOTFOUND' });
    return publicDns();
  }, fetchImpl: async (url, init) => {
    seen.push(init);
    if (url.endsWith('/ok')) return page('Good article title here | Site');
    if (url.endsWith('/title')) return page('A completely different page title | Site');
    if (url.endsWith('/gone')) return page('', { status: 404 });
    return page('', { status: 403 });
  } });
  assert.equal(result.checked, 5);
  assert.deepEqual(result.broken.map((b) => [b.url, b.status]).sort((x, y) => x[0].localeCompare(y[0])), [['https://a.example/gone', 404], ['https://nodns.example/x', 'ENOTFOUND']]);
  assert.deepEqual(result.mismatched.map((m) => m.url), ['https://a.example/title']);
  assert.deepEqual(result.unknown.map((u) => u.status), [403]);
  assert.ok(seen.every((init) => init.credentials === 'omit' && init.redirect === 'manual'));
  const reason = sourceProblemReason([...result.broken, ...result.mismatched]);
  assert.match(reason, /다시 조사하지 말고.*이 항목만 고치세요/);
  assert.match(reason, /참고로 적은 링크이거나 차단 화면이면 그대로/);
  assert.match(reason, /열리지 않음\(404\).*gone/);
  assert.match(reason, /실제 제목: A completely different/);
});

test('출처 확인: 내부 주소는 열지 않고, 공개 주소에서 내부로 가는 리디렉션도 막는다', async () => {
  const opened = [];
  const result = await checkSources([{ stage: 's', text: 'http://localhost:4777/x http://10.0.0.5/erp https://intra.example/a https://pub.example/r' }], {
    lookup: async (host) => [{ address: host === 'intra.example' ? '192.168.1.9' : '93.184.216.34' }],
    fetchImpl: async (url) => { opened.push(url); return page('', { status: 302, location: 'https://intra.example/secret' }); } });
  assert.deepEqual(opened, ['https://pub.example/r']);
  assert.equal(result.skipped, 4);
  assert.equal(result.checked, 0);
});

test('출처 확인: 링크가 40개를 넘으면 나머지는 건너뛴다', async () => {
  const text = Array.from({ length: 45 }, (_, i) => `https://a.example/${i}`).join('\n');
  const result = await checkSources([{ stage: 's', text }], { lookup: publicDns, fetchImpl: async () => page('') });
  assert.equal(result.checked, 40);
  assert.equal(result.skipped, 5);
});
