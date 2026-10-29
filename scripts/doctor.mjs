#!/usr/bin/env node
// 실행 환경 점검. 사용법: node scripts/doctor.mjs [--json] [--port 4777]
// 종료 코드: 필수 항목(Node 20 이상, claude 설치·로그인) 실패 시 1, 그 밖에는 0. 잘못된 옵션은 64
import { DEFAULT_PORT, formatDoctor, runDoctor } from '../lib/doctor.mjs';

const USAGE = '사용법: node scripts/doctor.mjs [--json] [--port 4777]';

function parseArgs(argv) {
  const opts = { json: false, port: DEFAULT_PORT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--port' || arg.startsWith('--port=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
      opts.port = Number(value);
      if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) throw new Error('--port는 1~65535 정수여야 합니다.');
    } else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else {
      throw new Error(`알 수 없는 옵션입니다: ${arg}`);
    }
  }
  return opts;
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(`오류: ${err.message}\n${USAGE}`);
  process.exit(64);
}

const result = await runDoctor({ port: opts.port });
if (opts.json) console.log(JSON.stringify(result, null, 2));
else console.log(formatDoctor(result).join('\n'));
process.exit(result.ok ? 0 : 1);
