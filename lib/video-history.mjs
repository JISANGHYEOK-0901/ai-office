// 확정·시도 중인 영상 ID의 영구 기록. 실행 로그 초기화와 독립적이다.
import { join } from 'node:path';
import { readPrivate, writePrivate } from './private-state.mjs';

export class VideoHistoryError extends Error {
  constructor(message) { super(message); this.code = 'VIDEO_DUPLICATE'; }
}
export function youtubeVideoIds(value) {
  const ids = new Set();
  const text = String(value || '').replace(/&amp;/gi, '&');
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`\])}]+/gi)) {
    let url, path; try { url = new URL(match[0].replace(/[.,;!]+$/, '')); path = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { continue; }
    const host = url.hostname.toLowerCase();
    let id;
    if (['youtu.be', 'www.youtu.be'].includes(host)) id = path[0];
    else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(host)) {
      id = path[0] === 'watch' ? url.searchParams.get('v') : ['shorts', 'embed', 'live'].includes(path[0]) ? path[1] : null;
    }
    if (typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id)) ids.add(id);
  }
  return [...ids];
}

export function createVideoHistory(root) {
  const file = join(root, '.office', 'video-publications.json');
  const read = () => {
    const data = readPrivate(file, { version: 1, videos: {}, batches: {} });
    if (data.version !== 1 || !data.videos || !data.batches) throw new Error('영상 게시 이력을 읽을 수 없어 게시를 중단합니다.');
    return data;
  };
  const check = (data, { ids, owner, schedule }) => {
    for (const id of ids) {
      const previous = Object.hasOwn(data.videos, id) ? data.videos[id] : null;
      if (previous && (previous.owner !== owner || previous.status === 'confirmed')) throw new VideoHistoryError(`이미 게시했거나 게시 결과를 확인 중인 영상입니다: ${id}`);
    }
    if (schedule?.maxPosts) {
      const batch = data.batches[`${schedule.id}/${schedule.slot}`];
      if (batch && !batch.owners.includes(owner) && batch.owners.length >= schedule.maxPosts) throw new VideoHistoryError(`오늘 예약의 최대 게시 수 ${schedule.maxPosts}개를 이미 처리했습니다.`);
    }
  };
  return {
    excluded(scope) { return Object.entries(read().videos).filter(([, value]) => value.scope !== scope).map(([id]) => id); },
    check(input) { check(read(), input); },
    claim(input) {
      const data = read(); check(data, input);
      const at = new Date().toISOString();
      for (const id of input.ids) data.videos[id] = { owner: input.owner, scope: input.scope, status: 'committing', at };
      if (input.schedule?.maxPosts) {
        const key = `${input.schedule.id}/${input.schedule.slot}`;
        const batch = data.batches[key] ||= { owners: [] };
        if (!batch.owners.includes(input.owner)) batch.owners.push(input.owner);
      }
      writePrivate(file, data);
    },
    confirm({ ids, owner, resultUrl }) {
      if (!ids.length) return;
      const data = read();
      for (const id of ids) if (data.videos[id]?.owner === owner) Object.assign(data.videos[id], { status: 'confirmed', resultUrl, confirmedAt: new Date().toISOString() });
      writePrivate(file, data);
    },
  };
}
