// `node --test test/` 호환용 진입점.
// Node 22 이상은 --test에 준 폴더를 펼치지 않고 모듈 경로로 해석해 test/package.json의 main(이 파일)을 실행한다.
// 그때만 test/*.test.mjs를 파일마다 별도 프로세스로 실행한다. 폴더를 펼치는 Node 20이나
// 인자 없는 `node --test`에서는 이 파일이 개별 파일로 실행되므로 아무 테스트도 등록하지 않는다(중복 실행 방지).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const launchedAsDir = process.argv[1] && resolve(process.argv[1]) === HERE;

if (launchedAsDir) {
  const files = readdirSync(HERE).filter((f) => f.endsWith('.test.mjs')).sort();
  for (const file of files) {
    test(file, (t) => {
      // 바깥 러너의 자식 표식(NODE_TEST_CONTEXT)을 넘기면 안쪽 러너가 결과를 사람이 읽는 형식으로 내지 않는다
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const res = spawnSync(process.execPath, ['--test', '--test-reporter=spec', join(HERE, file)], { cwd: resolve(HERE, '..'), encoding: 'utf8', env });
      const out = `${res.stdout}\n${res.stderr}`;
      const summary = out.split('\n').filter((l) => /^ℹ (tests|pass|fail) /.test(l)).map((l) => l.slice(2)).join(' / ');
      assert.equal(res.status, 0, `${file} 실패\n${out.slice(-4000)}`);
      t.diagnostic(summary || '요약 없음');
      assert.match(summary, /fail 0/, `${file}: 테스트 요약을 찾지 못했습니다\n${out.slice(-2000)}`);
    });
  }
}
