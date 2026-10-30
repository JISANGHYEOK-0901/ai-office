import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createKeepAwake } from '../lib/keep-awake.mjs';
test('한 감시가 끝나도 다른 감시의 절전 방지를 유지하고 마지막 작업 종료에 해제한다', () => {
  const calls = []; let stopped = 0;
  const keep = createKeepAwake({ platform: 'darwin', spawnImpl: (command, args) => {
    calls.push({ command, args }); const child = new EventEmitter(); child.kill = () => { stopped++; }; return child;
  } });
  const first = keep('one'), second = keep('two');
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].args, ['-i', '-w', String(process.pid)]);
  first(); assert.equal(stopped, 0); second(); assert.equal(stopped, 1);
});
