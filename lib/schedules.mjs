// 한국 시각의 매일 예약. 업무 내역과 별도로 저장하며 놓친 시각을 몰아서 실행하지 않는다.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { readPrivate, writePrivate } from './private-state.mjs';
import { loadSettings, validateChief } from './settings.mjs';
import { redact, redactContext } from './events.mjs';

const KST = 9 * 3600000, DAY = 86400000;
export const SCHEDULE_ZONE = 'Asia/Seoul';
export const localDate = (now) => new Date(now + KST).toISOString().slice(0, 10);
const timeValue = (time) => {
  if (typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('예약 시각은 00:00~23:59 형식으로 입력해 주세요.');
  return time.split(':').map(Number);
};
export function nextDailyTime(time, now) {
  timeValue(time);
  const at = Date.parse(`${localDate(now)}T${time}:00+09:00`);
  return at > now ? at : at + DAY;
}

export function videoPostPolicy(prompt) {
  const youtube = /유튜브|숏츠|youtube|youtu\.be|shorts/i.test(prompt);
  const post = /카페|게시|포스팅|블로그/.test(prompt);
  if (!youtube || !post) return null;
  const range = prompt.match(/(\d+)\s*[~∼～-]\s*(\d+)\s*(?:개|건|편)/);
  const count = [...prompt.matchAll(/(\d+)\s*(?:개|건|편)(?:\s*씩)?/g)].at(-1);
  const minPosts = Number(range?.[1] || count?.[1] || 2), maxPosts = Number(range?.[2] || count?.[1] || 3);
  if (minPosts < 1 || maxPosts > 20 || minPosts > maxPosts) throw new Error('영상 게시 수는 하루 1~20개 범위로 지정해 주세요.');
  return { uniqueYoutube: true, minPosts, maxPosts };
}

export function dailyScheduleRequest(prompt) {
  const text = String(prompt || '');
  if (!/매일|every\s+day|\bdaily\b/i.test(text)) return null;
  if (/가능한지|가능한가|가능해|할\s*수\s*있/.test(text) && !/진행해|등록해|예약해|게시해|올려|시작해/.test(text)) return null;
  const clock = text.match(/(?:매일|every\s+day|\bdaily\b)\s*(?:at\s*)?(오전|오후)?\s*(\d{1,2})(?:시\s*(?:(\d{1,2})분)?|:(\d{2}))/i);
  if (!clock) throw new Error('매일 실행할 시각을 지정해 주세요. 예: 매일 오전 11시에 …');
  let hour = Number(clock[2]), minute = Number(clock[3] || clock[4] || 0);
  if (hour > 23 || minute > 59 || clock[1] && (hour < 1 || hour > 12)) throw new Error('예약 시각을 확인해 주세요.');
  if (clock[1]) hour = hour % 12 + (clock[1] === '오후' ? 12 : 0);
  return { time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
}

export function createSchedules({ root, start, runs = () => [], now = Date.now, onChange = () => {} }) {
  const file = join(root, '.office', 'schedules.json');
  const data = readPrivate(file, { version: 1, items: [] });
  if (data.version !== 1 || !Array.isArray(data.items)) throw new Error('저장된 반복 예약을 읽을 수 없습니다.');
  const items = data.items;
  const save = () => { writePrivate(file, { version: 1, items }); onChange(); };
  const find = (id) => { const item = items.find((item) => item.id === id); if (!item) throw new Error('반복 예약을 찾을 수 없습니다.'); return item; };
  const validate = (input) => {
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 4000) throw new Error('예약 업무 지시를 1~4,000자로 입력해 주세요.');
    const time = input.time || dailyScheduleRequest(input.prompt)?.time;
    timeValue(time);
    return { prompt: redactContext(input.prompt.trim()), time, chief: validateChief(input.chief || loadSettings(root).chief),
      policy: videoPostPolicy(input.prompt) };
  };
  const reconcile = () => {
    let changed = false;
    const list = runs();
    for (const item of items) {
      if (!item.lastRun?.id) continue;
      const latest = list.filter((run) => !run.phase && run.schedule?.id === item.id && (run.rootId || run.id) === item.lastRun.rootId).at(-1);
      if (!latest) continue;
      const status = latest.needsReply ? 'needs_reply' : latest.status;
      if (item.lastRun.status !== status || item.lastRun.id !== latest.id) {
        item.lastRun = { ...item.lastRun, id: latest.id, task: latest.task, status, summary: redact(latest.summary || '', 180) };
        changed = true;
      }
    }
    if (changed) save();
  };
  // 부팅/절전 복귀 때 지난 예약은 다음 날로 넘긴다. 저장된 실행 시도는 되돌리지 않는다.
  let missed = false;
  for (const item of items) {
    timeValue(item.time);
    if (!Number.isFinite(Date.parse(item.nextAt))) throw new Error('저장된 반복 예약의 다음 실행 시각을 읽을 수 없습니다.');
    if (item.enabled && Date.parse(item.nextAt) <= now()) {
      item.nextAt = new Date(nextDailyTime(item.time, now())).toISOString();
      item.lastSkipped = { at: new Date(now()).toISOString(), reason: '앱이 실행되지 않은 예약 시각은 건너뛰었습니다.' }; missed = true;
    }
  }
  if (missed) save();
  const list = ({ full = false } = {}) => {
    reconcile();
    return items.map((item) => full ? structuredClone(item) : { ...structuredClone(item), prompt: redact(item.prompt, 120) });
  };
  return {
    list,
    add(input) {
      if (items.length >= 100) throw new Error('반복 예약은 100개 이하로 관리해 주세요.');
      const valid = validate(input);
      if (items.some((item) => item.prompt === valid.prompt && item.time === valid.time)) throw new Error('같은 업무와 시각의 예약이 이미 있습니다.');
      const item = { id: randomBytes(8).toString('hex'), ...valid, timeZone: SCHEDULE_ZONE, enabled: true,
        createdAt: new Date(now()).toISOString(), nextAt: new Date(nextDailyTime(valid.time, now())).toISOString() };
      items.push(item); save(); return structuredClone(item);
    },
    update(id, input) {
      const item = find(id);
      if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('enabled는 true 또는 false여야 합니다.');
      const valid = validate({ ...item, ...input });
      const reschedule = valid.time !== item.time || input.enabled === true && !item.enabled;
      Object.assign(item, valid);
      if (input.enabled !== undefined) item.enabled = input.enabled;
      if (reschedule) item.nextAt = new Date(nextDailyTime(item.time, now())).toISOString();
      save(); return structuredClone(item);
    },
    remove(id) { find(id); items.splice(items.findIndex((item) => item.id === id), 1); save(); return { removed: true }; },
    tick() {
      reconcile();
      const stamp = now();
      for (const item of items) {
        if (!item.enabled || Date.parse(item.nextAt) > stamp) continue;
        const due = Date.parse(item.nextAt), slot = localDate(due);
        item.nextAt = new Date(nextDailyTime(item.time, stamp)).toISOString();
        if (stamp - due > 60000 || item.lastSlot === slot) {
          item.lastSkipped = { at: new Date(stamp).toISOString(), reason: '지난 예약 시각을 건너뛰었습니다.' }; save(); continue;
        }
        item.lastSlot = slot;
        if (runs().some((run) => !run.phase && run.schedule?.id === item.id && (['running', 'queued'].includes(run.status) || run.needsReply))) {
          item.lastSkipped = { at: new Date(stamp).toISOString(), reason: '이전 예약 업무가 진행 중이거나 답변을 기다려 이번 실행을 건너뛰었습니다.' }; save(); continue;
        }
        // 프로세스가 끊겨도 같은 날짜를 다시 시작하지 않도록 실행 전에 먼저 기록한다.
        item.lastRun = { slot, status: 'starting', startedAt: new Date(stamp).toISOString() }; save();
        try {
          const run = start({ prompt: `${item.prompt}\n\n[예약 실행] 한국 시각 ${slot} ${item.time}의 1회 업무입니다. 오늘 분량만 처리하고 반복 예약·대기·지속 감시는 다시 시작하지 마세요.`,
            ...item.chief, continuous: false, schedule: { id: item.id, slot, ...item.policy } });
          item.lastRun = { ...item.lastRun, id: run.id, rootId: run.rootId || run.id, task: run.task, status: run.status };
        } catch (error) { item.lastRun.status = 'failed'; item.lastRun.summary = redact(error.message, 180); }
        save();
      }
    },
  };
}
