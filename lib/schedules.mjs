// 한국 시각 예약: 1회(특정 날짜), N회(시작일부터 N일 동안 매일), 횟수 제한 없는 매일 반복.
// 업무 내역과 별도로 저장하며 놓친 시각을 몰아서 실행하지 않는다(놓친 날도 횟수에 포함).
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { readPrivate, writePrivate } from './private-state.mjs';
import { loadSettings, validateChief } from './settings.mjs';
import { redact, redactContext } from './events.mjs';

const KST = 9 * 3600000, DAY = 86400000;
export const SCHEDULE_ZONE = 'Asia/Seoul';
export const localDate = (now) => new Date(now + KST).toISOString().slice(0, 10);
export const MAX_SCHEDULE_TIMES = 365;
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const slotAt = (date, time) => Date.parse(`${date}T${time}:00+09:00`);
const timeValue = (time) => {
  if (typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('예약 시각은 00:00~23:59 형식으로 입력해 주세요.');
  return time.split(':').map(Number);
};
export function nextDailyTime(time, now) {
  timeValue(time);
  const at = Date.parse(`${localDate(now)}T${time}:00+09:00`);
  return at > now ? at : at + DAY;
}

// 영상 예약의 하루 게시 수. 개수마다 바로 앞 문구에 영상 단어가 있는지 보고 영상 글과 영상이 아닌 글(장소 소개 등)의 개수를 나눈다.
// 둘 다 있으면 섞인 예약이라 영상이 아닌 글 수(infoPosts)를 따로 둔다. 영상 단어가 붙은 개수가 없으면 예전처럼 범위 우선·마지막 개수를 영상 글 수로 본다
const VIDEO_WORD = /유튜브|숏츠|youtube|youtu\.be|shorts|영상/i;
export function videoPostPolicy(prompt) {
  const youtube = /유튜브|숏츠|youtube|youtu\.be|shorts/i.test(prompt);
  const post = /카페|게시|포스팅|블로그/.test(prompt);
  if (!youtube || !post) return null;
  const counts = [];
  let from = 0;
  for (const m of prompt.matchAll(/(\d+)\s*(?:[~∼～-]\s*(\d+)\s*)?(?:개|건|편)/g)) {
    counts.push({ min: Number(m[1]), max: Number(m[2] || m[1]), range: m[2] !== undefined, video: VIDEO_WORD.test(prompt.slice(from, m.index)) });
    from = m.index + m[0].length;
  }
  const videos = counts.filter((c) => c.video), others = counts.filter((c) => !c.video);
  const mixed = videos.length > 0 && others.length > 0;
  const pool = mixed ? videos : counts;
  const chosen = pool.find((c) => c.range) || pool.at(-1);
  const minPosts = chosen ? chosen.min : 2, maxPosts = chosen ? chosen.max : 3;
  if (minPosts < 1 || maxPosts > 20 || minPosts > maxPosts) throw new Error('영상 게시 수는 하루 1~20개 범위로 지정해 주세요.');
  if (!mixed) return { uniqueYoutube: true, minPosts, maxPosts };
  const infoPosts = others.at(-1).max;
  if (infoPosts < 1 || infoPosts > 20) throw new Error('영상이 아닌 글 수는 하루 1~20개 범위로 지정해 주세요.');
  return { uniqueYoutube: true, minPosts, maxPosts, infoPosts };
}

const QUESTION = /가능한지|가능한가|가능해|할\s*수\s*있/, ACTION = /진행해|등록해|예약해|게시해|올려|시작해/;
const CLOCK = String.raw`(오전|오후)?\s*(\d{1,2})(?:시(?:\s*(\d{1,2})분|\s*(반))?|:(\d{2}))`;
function clockTime(m, offset = 0) {
  let hour = Number(m[offset + 2]), minute = m[offset + 4] ? 30 : Number(m[offset + 3] || m[offset + 5] || 0);
  if (hour > 23 || minute > 59 || m[offset + 1] && (hour < 1 || hour > 12)) throw new Error('예약 시각을 확인해 주세요.');
  if (m[offset + 1]) hour = hour % 12 + (m[offset + 1] === '오후' ? 12 : 0);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
const DATE = String.raw`(오늘|내일|모레|글피)|(\d{4})-(\d{1,2})-(\d{1,2})|(\d{1,2})월\s*(\d{1,2})일`;
function dateValue(m, now) {
  const today = localDate(now);
  if (m[1]) return addDays(today, { 오늘: 0, 내일: 1, 모레: 2, 글피: 3 }[m[1]]);
  const [year, month, day] = m[2] ? [Number(m[2]), Number(m[3]), Number(m[4])] : [Number(today.slice(0, 4)), Number(m[5]), Number(m[6])];
  const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date || month > 12) throw new Error('예약 날짜를 확인해 주세요.');
  // "11월 5일"처럼 연도가 없고 이미 지난 날짜면 내년으로 본다
  return !m[2] && date < today ? `${year + 1}${date.slice(4)}` : date;
}

// 지시 문장의 예약 요청(규칙 판별): {time, startDate?, times?} 또는 null.
// - "매일 오전 11시에" → 매일 반복, "내일부터 3일간 매일 10시" → 시작일·횟수
// - "내일 오전 10시에", "11월 5일 9시에" → 1회. 시각이 업무 내용("내일 10시에 있는 회의")이면 예약이 아니다
export function scheduleRequest(prompt, now = Date.now()) {
  const text = String(prompt || '');
  if (QUESTION.test(text) && !ACTION.test(text)) return null;
  const everyDay = /매일|every\s+day|\bdaily\b/i.test(text);
  const count = text.match(/(\d{1,3})\s*일\s*(?:간|동안)/) || text.match(/(\d{1,3})\s*(?:회|번)\s*(?:반복|실행|예약)/)
    || everyDay && text.match(/(\d{1,3})\s*(?:회|번)(?!\s*(?:게시판|째|방))/);
  const times = count ? Number(count[1]) : null;
  if (times !== null && (times < 1 || times > MAX_SCHEDULE_TIMES)) throw new Error(`예약 횟수는 1~${MAX_SCHEDULE_TIMES}회로 지정해 주세요.`);
  const start = text.match(new RegExp(`(?:${DATE})\\s*부터`));
  // "내일부터 3일간 오전 10시에"처럼 시작일과 기간이 있으면 매일 반복으로 본다
  if (everyDay || times && start) {
    const clock = text.match(new RegExp(String.raw`(?:매일|every\s+day|\bdaily\b)\s*(?:at\s*)?${CLOCK}`, 'i'))
      || !everyDay && text.match(new RegExp(`${CLOCK}\\s*(?:에|마다)`));
    if (!clock) throw new Error('매일 실행할 시각을 지정해 주세요. 예: 매일 오전 11시에 …');
    return { time: clockTime(clock), ...(start ? { startDate: dateValue(start, now) } : {}), ...(times ? { times } : {}) };
  }
  const once = text.match(new RegExp(`(?:${DATE})\\s*${CLOCK}\\s*(?:에|부터)(?!\\s*(?:있는|열리는|예정|시작하는|진행되는|하는\\s*회의))`));
  if (!once) return null;
  return { time: clockTime(once, 6), startDate: dateValue(once, now), times: times || 1 };
}

export function createSchedules({ root, start, runs = () => [], now = Date.now, onChange = () => {} }) {
  const file = join(root, '.office', 'schedules.json');
  const data = readPrivate(file, { version: 1, items: [] });
  if (data.version !== 1 || !Array.isArray(data.items)) throw new Error('저장된 예약을 읽을 수 없습니다.');
  const items = data.items;
  const save = () => { writePrivate(file, { version: 1, items }); onChange(); };
  const find = (id) => { const item = items.find((item) => item.id === id); if (!item) throw new Error('예약을 찾을 수 없습니다.'); return item; };
  // startDate(YYYY-MM-DD, 한국 날짜)·times(1~365, 없으면 무제한)는 선택이다. 시각만 주면 지금처럼 매일 반복한다
  const validate = (input, previous = null) => {
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 4000) throw new Error('예약 업무 지시를 1~4,000자로 입력해 주세요.');
    const parsed = input.time ? null : scheduleRequest(input.prompt, now());
    const time = input.time || parsed?.time;
    timeValue(time);
    const startDate = input.time ? input.startDate || null : parsed?.startDate || null;
    const rawTimes = input.time ? input.times : parsed?.times;
    const times = rawTimes === undefined || rawTimes === null || rawTimes === '' || rawTimes === 0 ? null : rawTimes;
    if (startDate !== null && (typeof startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || addDays(startDate, 0) !== startDate)) throw new Error('예약 시작 날짜는 YYYY-MM-DD 형식으로 입력해 주세요.');
    if (times !== null && (!Number.isInteger(times) || times < 1 || times > MAX_SCHEDULE_TIMES)) throw new Error(`예약 횟수는 1~${MAX_SCHEDULE_TIMES}회로 입력해 주세요.`);
    if (startDate && startDate !== previous?.startDate) {
      const today = localDate(now());
      if (startDate < today) throw new Error('예약 시작 날짜가 이미 지났습니다.');
      if (startDate > addDays(today, MAX_SCHEDULE_TIMES)) throw new Error('예약 시작 날짜는 1년 안으로 정해 주세요.');
    }
    return { prompt: redactContext(input.prompt.trim()), time, startDate, times, chief: validateChief(input.chief || loadSettings(root).chief),
      policy: videoPostPolicy(input.prompt) };
  };
  // 다음 실행 시각. 횟수 예약의 마지막 날(untilDate)이 지나면 null
  const nextSlot = (item, stamp) => {
    let at = nextDailyTime(item.time, stamp);
    if (item.startDate) at = Math.max(at, slotAt(item.startDate, item.time));
    return item.untilDate && localDate(at) > item.untilDate ? null : at;
  };
  // 예약 시각을 새로 정한다(추가·시각/날짜/횟수 수정). 1회 예약의 지정 시각이 이미 지났으면 거부한다
  const plan = (item, stamp) => {
    if (item.times === 1 && item.startDate && slotAt(item.startDate, item.time) <= stamp) throw new Error('예약 시각이 이미 지났습니다. 날짜나 시각을 바꿔 주세요.');
    const first = nextSlot({ ...item, untilDate: null }, stamp);
    item.untilDate = item.times ? addDays(localDate(first), item.times - 1) : null;
    item.nextAt = new Date(first).toISOString(); item.completed = false;
  };
  // 지난 회차 다음으로 넘긴다. 남은 회차가 없으면 예약을 끝낸다(nextAt은 마지막 회차로 남긴다)
  const advance = (item, stamp) => {
    const next = nextSlot(item, stamp);
    if (next === null) { item.enabled = false; item.completed = true; return; }
    item.nextAt = new Date(next).toISOString();
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
    if (!Number.isFinite(Date.parse(item.nextAt))) throw new Error('저장된 예약의 다음 실행 시각을 읽을 수 없습니다.');
    if (item.enabled && Date.parse(item.nextAt) <= now()) {
      advance(item, now());
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
      if (items.length >= 100) throw new Error('예약은 100개 이하로 관리해 주세요.');
      const valid = validate(input);
      if (items.some((item) => !item.completed && item.prompt === valid.prompt && item.time === valid.time && (item.startDate || null) === valid.startDate)) throw new Error('같은 업무와 시각의 예약이 이미 있습니다.');
      const item = { id: randomBytes(8).toString('hex'), ...valid, timeZone: SCHEDULE_ZONE, enabled: true, createdAt: new Date(now()).toISOString() };
      plan(item, now());
      items.push(item); save(); return structuredClone(item);
    },
    update(id, input) {
      const item = find(id);
      if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('enabled는 true 또는 false여야 합니다.');
      const merged = { ...item, ...input };
      const valid = validate({ ...merged, time: merged.time, startDate: merged.startDate ?? null, times: merged.times ?? null }, item);
      // 시각·날짜·횟수를 바꾸면 회차를 새로 센다. 단순히 다시 켜면 남은 회차만 이어 간다
      const changed = valid.time !== item.time || valid.startDate !== (item.startDate || null) || valid.times !== (item.times || null);
      const next = { ...item, ...valid };
      if (changed) plan(next, now());
      else if (input.enabled === true && !item.enabled) {
        const at = nextSlot(next, now());
        if (at === null) throw new Error('이미 끝난 예약입니다. 날짜나 횟수를 바꿔 다시 등록해 주세요.');
        next.nextAt = new Date(at).toISOString();
      }
      if (input.enabled !== undefined) next.enabled = input.enabled;
      else if (changed && item.completed) next.enabled = true; // 끝난 예약을 고쳐 저장하면 다시 켠다
      Object.assign(item, next);
      save(); return structuredClone(item);
    },
    remove(id) { find(id); items.splice(items.findIndex((item) => item.id === id), 1); save(); return { removed: true }; },
    tick() {
      reconcile();
      const stamp = now();
      for (const item of items) {
        if (!item.enabled || Date.parse(item.nextAt) > stamp) continue;
        const due = Date.parse(item.nextAt), slot = localDate(due);
        advance(item, stamp);
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
          const run = start({ prompt: `${item.prompt}\n\n[예약 실행] 예약한 한국 시각 ${slot} ${item.time}이 되어 시작한 1회 업무입니다. 지시의 날짜·시각·반복 표현은 예약으로 이미 처리했으니 지금 바로 이번 회차 분량만 처리하고, 반복 예약·대기·지속 감시는 다시 시작하지 마세요.`,
            ...item.chief, continuous: false, schedule: { id: item.id, slot, ...item.policy } });
          item.lastRun = { ...item.lastRun, id: run.id, rootId: run.rootId || run.id, task: run.task, status: run.status };
        } catch (error) { item.lastRun.status = 'failed'; item.lastRun.summary = redact(error.message, 180); }
        save();
      }
    },
  };
}
