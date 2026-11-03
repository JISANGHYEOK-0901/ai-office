import { spawn } from 'node:child_process';

// 감시가 있을 때만 자동 유휴 절전을 막는다. 화면 잠금/화면 꺼짐은 허용한다.
export function createKeepAwake({ platform = process.platform, spawnImpl = spawn } = {}) {
  const owners = new Set();
  let child;
  return (id) => {
    owners.add(id);
    if (!child && platform === 'darwin') {
      child = spawnImpl('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', windowsHide: true });
      child.on('error', () => { child = null; });
      child.unref?.();
    }
    return () => {
      owners.delete(id);
      if (!owners.size && child) { child.kill('SIGTERM'); child = null; }
    };
  };
}
