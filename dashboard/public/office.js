// 픽셀 사무실 캔버스 렌더러.
// 외부 이미지 없이 사각형만으로 방·가구·캐릭터를 그린다. 레이아웃 계산은 순수 함수라 Node에서도 테스트한다.

const SLOT_W = 60;
const SLOT_H = 66;
const PAD = 14;
const HEAD = 34;
const FOOT = 36;
const GAP = 44;
const MARGIN = 48;
const TOP_H = 176;
const SPEED = 72; // 걷기 속도(px/s)
const UI_FONT = 'system-ui, -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
const NARROW_W = 640; // 이 폭보다 좁은 화면(모바일)은 방을 1열로 놓고 폭에 맞춘다
const LABEL_MIN_Z = 0.38; // 이 배율보다 작으면 이름표·말풍선을 그리지 않는다

const HAIR = ['#2b1d16', '#4a2f1d', '#6b3f22', '#a0522d', '#d9a441', '#1f2937', '#6d4bd8', '#e0679f', '#9ca3af', '#3b2a5a'];
const SHIRT = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b', '#f97316', '#22c55e', '#0ea5e9', '#a855f7'];
const PANTS = ['#1e293b', '#334155', '#3f3f46', '#1e3a8a', '#44403c'];
const SKIN = ['#f6d7bf', '#f1c7a5', '#e0ac85', '#c68863', '#8d5a3b'];

const DEFAULT_THOUGHTS = ['다음 업무 뭐지?', '커피 한 잔 할까…', '자료 정리 중', '보고서 다시 볼까', '오늘도 파이팅!'];

export const PALETTES = {
  neon: {
    bg: '#050913', dot: '#111b33', floor: '#0b1326', tile: '#0e1830', wallW: 1.5, glow: true,
    text: '#d8e4ff', muted: '#7d8db3', deskTop: '#2a3a5c', deskFront: '#1a253f', chair: '#24324f',
    monitor: '#070b16', screenOff: '#14203a', screenOn: '#34f5c5', screenLine: '#0a4b3e', kbd: '#3a4a6e',
    plate: 'rgba(5,9,20,.82)', plateText: '#d6e4ff', bubble: '#0a1324', bubbleText: '#eafff9', bubbleLine: '#34f5c5',
    thought: '#141c36', thoughtText: '#c4cff0', thoughtLine: '#56658a', plant: '#22c55e', plantDark: '#15803d',
    pot: '#3b4a6b', rug: '#141a38', wood: '#2a3a5c', ceo: '#f472b6', meeting: '#38bdf8', shadow: 'rgba(0,0,0,.5)',
    outline: null, blush: null, headerFill: null, select: '#34f5c5',
  },
  pastel: {
    bg: '#ffe6f2', dot: '#ffc9e0', floor: '#f3ecff', tile: '#e9e0fb', wallW: 6, glow: false,
    text: '#4a2b3c', muted: '#8a6076', deskTop: '#f0cfa4', deskFront: '#c99a6c', chair: '#7c6aa8',
    monitor: '#3a3450', screenOff: '#5b5478', screenOn: '#9ff0d0', screenLine: '#4fbf98', kbd: '#ffffff',
    plate: 'rgba(255,255,255,.92)', plateText: '#4a2b3c', bubble: '#ffffff', bubbleText: '#4a2b3c', bubbleLine: '#4a2b3c',
    thought: '#fff8fb', thoughtText: '#8a6076', thoughtLine: '#e9a8c8', plant: '#5cc46a', plantDark: '#2f8a45',
    pot: '#ffffff', rug: '#ffc4de', wood: '#d9a877', ceo: '#ff5fa8', meeting: '#9b7bff', shadow: 'rgba(74,43,60,.18)',
    outline: '#3b2433', blush: '#ff9dc7', headerFill: true, select: '#ff5fa8',
  },
};

// FNV-1a 32비트 해시. 직원 id로 외형을 고정한다.
export function hashString(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function lookFor(id) {
  const h = hashString(id);
  return {
    hair: HAIR[h % HAIR.length],
    shirt: SHIRT[(h >>> 4) % SHIRT.length],
    pants: PANTS[(h >>> 9) % PANTS.length],
    skin: SKIN[(h >>> 13) % SKIN.length],
    style: (h >>> 17) % 4,
  };
}

function roomSize(count) {
  const cols = count <= 2 ? 2 : Math.min(8, Math.ceil(Math.sqrt(count * 1.8)));
  const rows = Math.max(1, Math.ceil(count / cols));
  return { cols, rows, w: PAD * 2 + cols * SLOT_W, h: HEAD + rows * SLOT_H + FOOT };
}

function finishRoom(room) {
  room.door = { x: Math.round(room.x + room.w / 2), y: room.y + room.h };
  room.doorIn = { x: room.door.x, y: room.y + room.h - 10 };
  room.doorOut = { x: room.door.x, y: room.y + room.h + GAP / 2 };
  return room;
}

// 부서 목록을 받아 방·좌석 좌표를 계산한다. departments: [{id, name, en, color, members:[{id}]}]
// maxCols: 방 격자의 최대 열 수(모바일은 1)
export function layoutOffice(departments = [], { maxCols = 4 } = {}) {
  const n = departments.length;
  const gridCols = Math.max(1, Math.min(maxCols, Math.ceil(Math.sqrt(n))));
  const sizes = departments.map((d) => roomSize((d.members || []).length));
  const colW = Array.from({ length: gridCols }, (_, c) =>
    Math.max(PAD * 2 + 2 * SLOT_W, ...sizes.filter((_, i) => i % gridCols === c).map((s) => s.w)));
  const colX = [];
  let cx = MARGIN;
  for (let c = 0; c < gridCols; c++) { colX.push(cx); cx += colW[c] + GAP; }
  const gridW = cx - GAP - MARGIN;

  const rooms = [];
  const ceo = finishRoom({ id: '__ceo', kind: 'ceo', name: '대표실', en: 'CEO', x: MARGIN, y: MARGIN, w: 216, h: TOP_H });
  const meeting = finishRoom({ id: '__meeting', kind: 'meeting', name: '회의실', en: 'MEETING', x: MARGIN + 216 + GAP, y: MARGIN, w: 300, h: TOP_H });
  rooms.push(ceo, meeting);

  const seats = new Map();
  let y = MARGIN + TOP_H + GAP;
  for (let r = 0; r * gridCols < n; r++) {
    const rowItems = departments.slice(r * gridCols, (r + 1) * gridCols);
    const rowH = Math.max(...rowItems.map((_, i) => sizes[r * gridCols + i].h));
    rowItems.forEach((dept, i) => {
      const idx = r * gridCols + i;
      const size = sizes[idx];
      const room = finishRoom({
        id: dept.id, kind: 'dept', name: dept.name || dept.id, en: dept.en || '', color: dept.color || '#38bdf8',
        x: colX[i], y, w: size.w, h: size.h, cols: size.cols, laneX: colX[i] - GAP / 2, dept, seats: [],
      });
      (dept.members || []).forEach((m, k) => {
        const x0 = room.x + PAD + (k % size.cols) * SLOT_W;
        const y0 = room.y + HEAD + Math.floor(k / size.cols) * SLOT_H;
        const seat = { agentId: m.id, x0, y0, x: x0 + 22, y: y0 + 42, room };
        room.seats.push(seat);
        seats.set(m.id, seat);
      });
      room.addHint = (dept.members || []).length === 0
        ? { x: room.x + PAD, y: room.y + HEAD + 6, w: room.w - PAD * 2, h: SLOT_H - 14 } : null;
      // 서성일 자리: 방 아래쪽 빈 공간
      room.loiter = [0.2, 0.4, 0.6, 0.8].map((f) => ({ x: Math.round(room.x + room.w * f), y: room.y + room.h - 12 }));
      rooms.push(room);
    });
    y += rowH + GAP;
  }
  const width = Math.max(gridW, meeting.x + meeting.w - MARGIN) + MARGIN * 2;
  const height = (n ? y - GAP : MARGIN + TOP_H) + MARGIN;
  // 대표실 보고 자리, 회의실 모임 자리
  ceo.spots = [-36, -12, 12, 36, -60, 60].map((dx) => ({ x: ceo.x + ceo.w / 2 + dx, y: ceo.y + 138 }));
  const mx = meeting.x + meeting.w / 2;
  meeting.spots = [];
  for (const dy of [74, 142]) for (const dx of [-84, -42, 0, 42, 84]) meeting.spots.push({ x: mx + dx, y: meeting.y + dy });
  meeting.spots.push({ x: mx - 128, y: meeting.y + 112 }, { x: mx + 128, y: meeting.y + 112 });
  return { width, height, rooms, seats, ceo, meeting, gridCols };
}

// 두 방 사이 경로: 문 → 복도 → (세로 통로) → 대상 문 → 목적지
export function routeBetween(from, fromRoom, to, toRoom) {
  if (!fromRoom || !toRoom || fromRoom === toRoom) return [{ x: to.x, y: to.y }];
  const pts = [fromRoom.doorIn, fromRoom.doorOut];
  const a = fromRoom.doorOut;
  const b = toRoom.doorOut;
  if (Math.abs(a.y - b.y) > 1) {
    const lane = fromRoom.kind === 'dept' ? fromRoom.laneX : toRoom.laneX;
    pts.push({ x: lane, y: a.y }, { x: lane, y: b.y });
  }
  pts.push(b, toRoom.doorIn, to);
  return pts.map((p) => ({ x: p.x, y: p.y }));
}

// 진행 중인 리뷰(review.start 후 review.end 없음)의 검토자 id 집합. feed는 최신순/과거순 모두 허용.
export function openReviewers(feed = []) {
  const sorted = [...feed].filter((e) => e && e.agent && (e.kind === 'review.start' || e.kind === 'review.end'))
    .sort((x, y) => String(x.ts).localeCompare(String(y.ts)));
  const open = new Set();
  for (const e of sorted) {
    if (e.kind === 'review.start') open.add(e.agent); else open.delete(e.agent);
  }
  return open;
}

function mix(hex, other, t) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const valid = (h) => /^#[0-9a-f]{6}$/i.test(h);
  if (!valid(hex) || !valid(other)) return hex;
  const a = p(hex); const b = p(other);
  return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

// 픽셀 캐릭터. (x, y)는 발 위치, 한 칸은 2px, 전체 20x28px.
export function drawCharacter(ctx, x, y, look, opt = {}) {
  const P = 2;
  const ox = Math.round(x - 10);
  const oy = Math.round(y - 28 - (opt.bob ? P : 0));
  const pose = opt.pose || 'stand';
  const paint = (override) => {
    const r = (cx, cy, w, h, color) => { ctx.fillStyle = override || color; ctx.fillRect(ox + cx * P, oy + cy * P, w * P, h * P); };
    // 머리
    r(2, 0, 6, 1, look.hair); r(1, 1, 8, 1, look.hair);
    if (look.style === 2) r(4, -1, 2, 1, look.hair);
    r(2, 2, 6, 4, look.skin);
    r(1, 2, 1, look.style === 1 ? 6 : 3, look.hair); r(8, 2, 1, look.style === 1 ? 6 : 3, look.hair);
    if (look.style === 3) r(4, 2, 4, 1, look.hair); else r(2, 2, 6, 1, look.hair);
    if (!override) {
      r(3, 4, 1, 1, '#1b1420'); r(6, 4, 1, 1, '#1b1420');
      if (opt.blush) { r(2, 5, 1, 1, opt.blush); r(7, 5, 1, 1, opt.blush); }
    }
    r(4, 6, 2, 1, look.skin);
    // 몸통과 팔
    r(2, 7, 6, 4, look.shirt);
    if (!override) r(4, 7, 2, 1, mix(look.shirt, '#ffffff', 0.45));
    const typing = pose === 'sit' && opt.typing;
    const lift = typing ? (opt.frame % 2) : 0;
    r(1, 7, 1, 3, look.shirt); r(8, 7, 1, 3, look.shirt);
    r(1, 10 - lift, 1, 1, look.skin); r(8, 9 + lift, 1, 1, look.skin);
    if (pose !== 'sit') {
      const step = pose === 'walk' ? opt.frame % 2 : -1;
      r(3, 11, 2, step === 1 ? 1 : 2, look.pants); r(5, 11, 2, step === 0 ? 1 : 2, look.pants);
      r(3, step === 1 ? 12 : 13, 2, 1, '#241a22'); r(5, step === 0 ? 12 : 13, 2, 1, '#241a22');
    }
  };
  ctx.save();
  if (opt.alpha != null) ctx.globalAlpha = opt.alpha;
  if (opt.outline) {
    // 파스텔 테마는 진한 외곽선으로 레트로 픽셀 느낌을 낸다
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      ctx.save(); ctx.translate(dx, dy); paint(opt.outline); ctx.restore();
    }
  }
  paint(null);
  ctx.restore();
}

const avatarCache = new Map();
// HTML 목록에 쓰는 작은 아바타 이미지(data URL). 브라우저에서만 동작한다.
export function avatarDataURL(id) {
  if (avatarCache.has(id)) return avatarCache.get(id);
  if (typeof document === 'undefined') return '';
  const c = document.createElement('canvas');
  c.width = 24; c.height = 24;
  const g = c.getContext('2d');
  drawCharacter(g, 12, 30, lookFor(id), { pose: 'sit' });
  const url = c.toDataURL();
  avatarCache.set(id, url);
  return url;
}

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
}

function clip(text, max) {
  const s = String(text || '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// 이름표용 짧은 이름: "오유진 팀장"처럼 뒤에 직급이 붙어 있으면 좁은 이름표에서는 직급을 뗀다
function plateName(agent) {
  const name = String(agent?.name || agent?.id || '');
  const rank = String(agent?.rank || '');
  return rank && name.endsWith(' ' + rank) ? name.slice(0, -rank.length - 1) : name;
}

// 현재 글꼴 기준 maxWidth 안에 들어가도록 한 글자씩 줄인다
function clipToWidth(ctx, text, maxWidth) {
  const s = String(text || '');
  if (ctx.measureText(s).width <= maxWidth) return s;
  let base = s;
  while (base.length > 1 && ctx.measureText(base + '…').width > maxWidth) base = base.slice(0, -1);
  return base + '…';
}

export function createOffice(canvas, handlers = {}) {
  const ctx = canvas.getContext('2d');
  let pal = PALETTES.neon;
  let layout = layoutOffice([]);
  let signature = '';
  let model = { departments: [], feed: [] };
  let deptById = new Map(); // 최신 부서 상태(레이아웃은 구성원이 바뀔 때만 다시 계산하므로 문패는 여기서 읽는다)
  let layoutCols = 4;
  const agents = new Map();
  const chars = new Map();
  const cam = { x: 0, y: 0, z: 1 };
  let camTarget = null;
  let userMoved = false;
  let patrol = false;
  let patrolIndex = 0;
  let patrolAt = 0;
  let running = false;
  let lastFrame = 0;
  let selectedId = null;
  let hoverId = null;
  let seen = new Set();
  let firstUpdate = true;
  let reviewers = new Set();
  let ceoBubbleUntil = 0;
  let cssW = 0;
  let cssH = 0;
  let dpr = 1;

  const now = () => performance.now() / 1000;
  const rand = (a, b) => a + Math.random() * (b - a);

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(3, window.devicePixelRatio || 1);
    cssW = Math.max(1, rect.width); cssH = Math.max(1, rect.height);
    canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
    // 숨겨진 상태(폭 0)에서는 열 수를 바꾸지 않는다
    const cols = rect.width < 1 ? layoutCols : cssW < NARROW_W ? 1 : 4;
    if (cols !== layoutCols) {
      layoutCols = cols;
      layout = layoutOffice(model.departments || [], { maxCols: cols });
      // 배치가 바뀌면 모든 직원을 새 좌석에 앉힌다
      for (const ch of chars.values()) {
        const seat = layout.seats.get(ch.id);
        if (seat) Object.assign(ch, { x: seat.x, y: seat.y, room: seat.room, mode: 'sit', path: [], job: null, bubble: null });
      }
    }
    if (!userMoved && !patrol) fit(true);
  }

  // 전체 보기. 모바일은 높이 대신 폭에 맞추고 위에서부터 보여준다(세로는 드래그로 이동)
  function fit(immediate) {
    const narrow = cssW < NARROW_W;
    const zw = cssW / layout.width; const zh = cssH / layout.height;
    const z = Math.max(0.3, Math.min(1.6, (narrow ? zw : Math.min(zw, zh)) * 0.96));
    const t = narrow
      ? { x: layout.width / 2 - cssW / (2 * z), y: 0, z }
      : { x: layout.width / 2 - cssW / (2 * z), y: layout.height / 2 - cssH / (2 * z), z };
    if (immediate) { Object.assign(cam, t); camTarget = null; } else camTarget = t;
  }

  // 축소해서 볼 때도 이름표·말풍선 글자가 화면에서 약 8px 이상이 되도록 월드 글자 크기를 키운다
  const labelScale = () => Math.min(2.4, Math.max(1, 1 / cam.z));

  function focusRoom(room) {
    const z = Math.max(0.5, Math.min(1.7, Math.min(cssW / (room.w + 120), cssH / (room.h + 120))));
    camTarget = { x: room.x + room.w / 2 - cssW / (2 * z), y: room.y + room.h / 2 - cssH / (2 * z), z };
  }

  function seatOf(id) { return layout.seats.get(id); }

  function goTo(ch, dest, destRoom, after) {
    const curRoom = ch.room || seatOf(ch.id)?.room;
    ch.path = routeBetween({ x: ch.x, y: ch.y }, curRoom, dest, destRoom);
    ch.mode = 'walk';
    ch.after = after;
    ch.destRoom = destRoom;
  }

  function goHome(ch) {
    const seat = seatOf(ch.id);
    if (!seat) return;
    goTo(ch, { x: seat.x, y: seat.y }, seat.room, { type: 'sit' });
  }

  function startReport(ch) {
    const spot = layout.ceo.spots[[...chars.values()].filter((c) => c.job === 'report').length % layout.ceo.spots.length];
    ch.job = 'report';
    goTo(ch, spot, layout.ceo, { type: 'wait', secs: 1.8, text: '보고드립니다!', then: 'home' });
  }

  function syncChars(prevSig) {
    const t = now();
    for (const [id, agent] of agents) {
      const seat = seatOf(id);
      if (!seat) continue;
      let ch = chars.get(id);
      if (!ch) {
        ch = { id, x: seat.x, y: seat.y, room: seat.room, mode: 'sit', path: [], job: null, status: agent.status,
          nextThought: t + rand(3, 30), nextWander: t + rand(8, 25), bubble: null };
        chars.set(id, ch);
      } else if (prevSig !== signature && ch.mode === 'sit') {
        // 레이아웃이 바뀌면 앉아 있는 직원은 새 좌석으로 옮긴다
        ch.x = seat.x; ch.y = seat.y; ch.room = seat.room;
      }
      const prev = ch.status;
      const next = agent.status;
      ch.status = next;
      if (next === 'off-duty') {
        Object.assign(ch, { x: seat.x, y: seat.y, room: seat.room, mode: 'sit', path: [], job: null, bubble: null });
        continue;
      }
      const inReview = reviewers.has(id);
      if (firstUpdate) {
        // 처음 열 때 이미 리뷰 중이면 걷지 않고 회의실에 바로 둔다
        if (inReview) {
          const spots = layout.meeting.spots;
          const spot = spots[[...chars.values()].filter((c) => c.job === 'review').length % spots.length];
          Object.assign(ch, { x: spot.x, y: spot.y, room: layout.meeting, mode: 'stand', job: 'review', path: [] });
        }
        continue;
      }
      if (inReview && ch.job !== 'review') {
        const spots = layout.meeting.spots;
        const idx = [...chars.values()].filter((c) => c.job === 'review').length % spots.length;
        ch.job = 'review';
        goTo(ch, spots[idx], layout.meeting, { type: 'stand' });
        continue;
      }
      if (!inReview && ch.job === 'review') { ch.job = null; goHome(ch); continue; }
      if (next === 'working' && prev !== 'working') {
        // 작업 시작: 자리로 걸어가 앉는다
        ch.job = null;
        if (ch.mode !== 'sit') goHome(ch);
      } else if (prev === 'working' && next !== 'working' && ch.job !== 'report') {
        startReport(ch);
      }
    }
    for (const id of [...chars.keys()]) if (!agents.has(id) || !seatOf(id)) chars.delete(id);
  }

  function update(next) {
    model = next || { departments: [] };
    const depts = model.departments || [];
    const prevSig = signature;
    signature = depts.map((d) => d.id + ':' + (d.members || []).map((m) => m.id).join(',')).join('|');
    deptById = new Map(depts.map((d) => [d.id, d]));
    if (signature !== prevSig) {
      layout = layoutOffice(depts, { maxCols: layoutCols });
      if (!userMoved && !patrol) fit(firstUpdate);
    }
    agents.clear();
    for (const d of depts) for (const m of d.members || []) agents.set(m.id, m);
    reviewers = openReviewers(model.feed || []);
    // 새 agent.stop 이벤트가 오면 보고 연출
    // 처음 받은 피드(과거 기록)는 연출하지 않고, 최근 30초 안의 이벤트만 쓴다
    const fresh = [];
    const recent = Date.now() - 30000;
    for (const e of model.feed || []) {
      const key = `${e.ts}|${e.agent}|${e.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!firstUpdate && e.kind === 'agent.stop' && Date.parse(e.ts) > recent) fresh.push(e.agent);
    }
    if (seen.size > 2000) seen = new Set([...seen].slice(-800));
    syncChars(prevSig);
    for (const id of fresh) {
      const ch = chars.get(id);
      if (ch && ch.job !== 'report' && ch.job !== 'review' && ch.status !== 'off-duty') startReport(ch);
    }
    if (depts.length) firstUpdate = false;
  }

  function step(dt, t) {
    for (const ch of chars.values()) {
      if (ch.status === 'off-duty') continue;
      if (ch.mode === 'walk') {
        let dist = SPEED * dt;
        while (dist > 0 && ch.path.length) {
          const p = ch.path[0];
          const dx = p.x - ch.x; const dy = p.y - ch.y;
          const d = Math.hypot(dx, dy);
          if (d <= dist) { ch.x = p.x; ch.y = p.y; ch.path.shift(); dist -= d; } else { ch.x += dx / d * dist; ch.y += dy / d * dist; dist = 0; }
        }
        if (!ch.path.length) {
          ch.room = ch.destRoom || ch.room;
          const a = ch.after || { type: 'stand' };
          if (a.type === 'sit') { ch.mode = 'sit'; ch.job = null; } else if (a.type === 'wait') {
            ch.mode = 'stand'; ch.waitUntil = t + a.secs; ch.bubble = { text: a.text, until: t + a.secs, kind: 'say' };
            if (ch.job === 'report') ceoBubbleUntil = t + a.secs;
          } else ch.mode = 'stand';
        }
      } else if (ch.mode === 'stand' && ch.waitUntil && t >= ch.waitUntil) {
        ch.waitUntil = 0;
        const then = ch.after?.then;
        if (ch.job === 'report') ch.job = null;
        if (then === 'home' || ch.status === 'working') goHome(ch);
      }
      // 대기 중 혼잣말·산책
      if (ch.status === 'standby' || ch.status === 'idle') {
        // 혼잣말은 화면 전체에서 동시에 3개까지만 띄운다
        const thinking = [...chars.values()].filter((c) => c.bubble?.kind === 'think').length;
        if (t > ch.nextThought && thinking >= 3) ch.nextThought = t + rand(2, 6);
        else if (t > ch.nextThought) {
          const agent = agents.get(ch.id);
          const list = Array.isArray(agent?.thoughts) && agent.thoughts.length ? agent.thoughts : DEFAULT_THOUGHTS;
          ch.bubble = { text: list[Math.floor(Math.random() * list.length)], until: t + 3.2, kind: 'think' };
          ch.nextThought = t + rand(9, 24);
        }
        if (ch.status === 'standby' && ch.mode === 'sit' && !ch.job && t > ch.nextWander) {
          const seat = seatOf(ch.id);
          if (seat) {
            const spot = seat.room.loiter[Math.floor(Math.random() * seat.room.loiter.length)];
            ch.job = 'wander';
            goTo(ch, spot, seat.room, { type: 'wait', secs: rand(3, 6), text: '', then: 'home' });
          }
          ch.nextWander = t + rand(14, 32);
        }
      } else if (ch.job === 'wander') { ch.job = null; goHome(ch); }
      if (ch.mode === 'sit' && ch.job === 'wander') ch.job = null;
      if (ch.bubble && t > ch.bubble.until) ch.bubble = null;
    }
    // 자동 순찰
    if (patrol && t > patrolAt) {
      const active = layout.rooms.filter((r) => r.kind === 'dept' && r.seats.some((s) => agents.get(s.agentId)?.status === 'working'));
      const pool = active.length ? active : layout.rooms.filter((r) => r.kind === 'dept');
      if (pool.length) { focusRoom(pool[patrolIndex % pool.length]); patrolIndex++; } else fit(false);
      patrolAt = t + 6;
    }
    if (camTarget) {
      const k = Math.min(1, dt * 2.2);
      cam.x += (camTarget.x - cam.x) * k; cam.y += (camTarget.y - cam.y) * k; cam.z += (camTarget.z - cam.z) * k;
      if (Math.abs(camTarget.x - cam.x) < 0.5 && Math.abs(camTarget.y - cam.y) < 0.5 && Math.abs(camTarget.z - cam.z) < 0.002) camTarget = null;
    }
  }

  // ───── 그리기 ─────
  function drawBackground() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr * cam.z, 0, 0, dpr * cam.z, -cam.x * dpr * cam.z, -cam.y * dpr * cam.z);
    const s = 24;
    const x0 = Math.floor(cam.x / s) * s; const y0 = Math.floor(cam.y / s) * s;
    const x1 = cam.x + cssW / cam.z; const y1 = cam.y + cssH / cam.z;
    if ((x1 - x0) / s * ((y1 - y0) / s) > 12000) return;
    ctx.fillStyle = pal.dot;
    for (let x = x0; x < x1; x += s) for (let y = y0; y < y1; y += s) ctx.fillRect(x, y, 2, 2);
  }

  function drawPlant(x, y, big) {
    const w = big ? 14 : 10;
    ctx.fillStyle = pal.pot; ctx.fillRect(x - w / 2 + 2, y - 8, w - 4, 8);
    if (pal.outline) { ctx.fillStyle = pal.outline; ctx.fillRect(x - w / 2 + 2, y - 1, w - 4, 1); }
    ctx.fillStyle = pal.plantDark; ctx.fillRect(x - w / 2, y - 16, w, 8);
    ctx.fillStyle = pal.plant; ctx.fillRect(x - w / 2 + 2, y - 20, w - 4, 8); ctx.fillRect(x - 2, y - 24, 4, 6);
  }

  function drawRoomShell(room, color, label, sub, counts) {
    const { x, y, w, h } = room;
    ctx.fillStyle = pal.floor; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = pal.tile;
    for (let ty = y + 16; ty < y + h; ty += 16) ctx.fillRect(x, ty, w, 1);
    for (let tx = x + 16; tx < x + w; tx += 16) ctx.fillRect(tx, y, 1, h);
    // 벽 (아래쪽은 문 자리를 비운다)
    const ww = pal.wallW;
    const wallColor = pal.glow ? color : mix(color, '#4a2b3c', 0.55);
    ctx.save();
    if (pal.glow) { ctx.shadowColor = color; ctx.shadowBlur = 14; }
    ctx.fillStyle = wallColor;
    ctx.fillRect(x - ww, y - ww, w + ww * 2, ww);
    ctx.fillRect(x - ww, y, ww, h);
    ctx.fillRect(x + w, y, ww, h);
    ctx.fillRect(x - ww, y + h, w / 2 - 12 + ww, ww);
    ctx.fillRect(x + w / 2 + 12, y + h, w / 2 - 12 + ww, ww);
    ctx.restore();
    if (!pal.glow) {
      ctx.fillStyle = mix(color, '#ffffff', 0.55);
      ctx.fillRect(x, y, w, 3);
    }
    // 문패
    ctx.textBaseline = 'middle';
    if (pal.headerFill) {
      ctx.fillStyle = mix(color, '#ffffff', 0.62);
      rr(ctx, x + 8, y + 7, w - 16, 20, 4); ctx.fill();
      ctx.strokeStyle = pal.outline; ctx.lineWidth = 1.5; ctx.stroke();
    } else {
      ctx.fillStyle = 'rgba(5,9,20,.55)'; ctx.fillRect(x + 1, y + 1, w - 2, 26);
      ctx.fillStyle = color; ctx.fillRect(x + 1, y + 27, w - 2, 1);
    }
    // 좁은 방에서는 영문 표기 → 긴 인원 표시(짧은 표시로) → 인원 표시 순서로 빼서 이름을 먼저 보여준다
    const countFont = `700 9px ui-monospace, Menlo, monospace`;
    ctx.font = `800 11px ${UI_FONT}`;
    const fullW = ctx.measureText(String(label || '')).width;
    ctx.font = countFont;
    const countW = (t) => (t ? ctx.measureText(t).width + 22 : 14);
    let countText = counts?.text || '';
    if (counts && fullW > w - 28 - countW(countText)) countText = counts.short || '';
    if (counts && fullW > w - 28 - countW(countText)) countText = '';
    const avail = w - 28 - (counts ? countW(countText) : 0);
    ctx.font = `800 11px ${UI_FONT}`;
    const name = clipToWidth(ctx, label, avail);
    const lw = ctx.measureText(name).width;
    ctx.fillStyle = pal.glow ? color : pal.text;
    ctx.textAlign = 'left';
    ctx.fillText(name, x + 14, y + 17);
    ctx.font = `700 8px ui-monospace, Menlo, monospace`;
    const subText = clip(sub, 16);
    if (subText && lw + 8 + ctx.measureText(subText).width <= avail) {
      ctx.fillStyle = pal.muted;
      ctx.fillText(subText, x + 20 + lw, y + 17.5);
    }
    if (counts) {
      ctx.textAlign = 'right';
      ctx.fillStyle = pal.text;
      ctx.font = countFont;
      if (countText) ctx.fillText(countText, x + w - 26, y + 17.5);
      ctx.fillStyle = counts.dot;
      ctx.beginPath(); ctx.arc(x + w - 17, y + 17, 4, 0, Math.PI * 2); ctx.fill();
      if (pal.outline) { ctx.strokeStyle = pal.outline; ctx.lineWidth = 1; ctx.stroke(); }
    }
  }

  function drawBubble(x, y, text, kind) {
    if (!text) return;
    const k = Math.min(1.8, labelScale());
    ctx.save();
    // 말풍선 아래 꼭짓점(x, y)을 기준으로 확대해 축소 화면에서도 읽히게 한다
    ctx.translate(x, y); ctx.scale(k, k); ctx.translate(-x, -y);
    ctx.font = `700 8px ${UI_FONT}`;
    const t = clip(text, k > 1.3 ? 12 : 18);
    const w = Math.ceil(ctx.measureText(t).width) + 10;
    const bx = Math.round(x - w / 2); const by = Math.round(y - 16);
    const think = kind === 'think';
    ctx.fillStyle = think ? pal.thought : pal.bubble;
    ctx.strokeStyle = think ? pal.thoughtLine : pal.bubbleLine;
    ctx.lineWidth = 1;
    rr(ctx, bx, by, w, 13, think ? 6 : 3); ctx.fill(); ctx.stroke();
    if (think) {
      ctx.beginPath(); ctx.arc(x - 2, by + 16, 1.6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    } else {
      ctx.fillStyle = pal.bubble; ctx.fillRect(x - 2, by + 12, 4, 3);
      ctx.fillStyle = pal.bubbleLine; ctx.fillRect(x - 3, by + 13, 1, 2); ctx.fillRect(x + 2, by + 13, 1, 2);
    }
    ctx.fillStyle = think ? pal.thoughtText : pal.bubbleText;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(t, x, by + 7);
    ctx.restore();
  }

  function statusColor(s) {
    return { working: '#34d399', standby: '#38bdf8', idle: '#a3a3c2', 'off-duty': '#f87171', offline: '#64748b' }[s] || '#64748b';
  }

  function drawSlot(seat, t, bubbles) {
    const agent = agents.get(seat.agentId);
    if (!agent) return;
    const ch = chars.get(seat.agentId);
    const { x0, y0 } = seat;
    const off = agent.status === 'off-duty';
    const working = agent.status === 'working';
    const h = hashString(agent.id);
    ctx.save();
    if (off) ctx.globalAlpha = 0.42;
    // 의자 등받이
    ctx.fillStyle = pal.chair; ctx.fillRect(x0 + 13, y0 + 16, 18, 18);
    ctx.fillStyle = mix(pal.chair, '#000000', 0.25); ctx.fillRect(x0 + 13, y0 + 32, 18, 2);
    const seated = ch && ch.mode === 'sit' && !off;
    if (seated) {
      drawCharacter(ctx, seat.x, seat.y, lookFor(agent.id), {
        pose: 'sit', typing: working, frame: Math.floor(t * 7 + (h % 5)),
        bob: !working && Math.floor(t * 0.8 + (h % 7)) % 2 === 0, outline: pal.outline, blush: pal.blush,
      });
    }
    // 책상
    ctx.fillStyle = pal.deskTop; ctx.fillRect(x0 + 4, y0 + 34, 52, 5);
    ctx.fillStyle = pal.deskFront; ctx.fillRect(x0 + 4, y0 + 39, 52, 9);
    ctx.fillStyle = mix(pal.deskFront, '#000000', 0.2); ctx.fillRect(x0 + 7, y0 + 48, 3, 4); ctx.fillRect(x0 + 50, y0 + 48, 3, 4);
    if (pal.outline) { ctx.fillStyle = pal.outline; ctx.fillRect(x0 + 4, y0 + 48, 52, 1); }
    ctx.fillStyle = pal.kbd; ctx.fillRect(x0 + 14, y0 + 35, 16, 2);
    if (seated && working) {
      const f = Math.floor(t * 7 + (h % 5)) % 2;
      const skin = lookFor(agent.id).skin;
      ctx.fillStyle = skin; ctx.fillRect(x0 + 15 + f * 2, y0 + 34 - f, 3, 2); ctx.fillRect(x0 + 25 - f * 2, y0 + 33 + f, 3, 2);
    }
    if (h % 3 === 0) { ctx.fillStyle = pal.glow ? '#f472b6' : '#ffffff'; ctx.fillRect(x0 + 6, y0 + 30, 4, 4); }
    // 모니터
    ctx.fillStyle = pal.monitor; ctx.fillRect(x0 + 34, y0 + 19, 19, 14); ctx.fillRect(x0 + 42, y0 + 33, 4, 2);
    ctx.save();
    if (working && pal.glow) { ctx.shadowColor = pal.screenOn; ctx.shadowBlur = 12; }
    ctx.fillStyle = working ? pal.screenOn : pal.screenOff; ctx.fillRect(x0 + 35, y0 + 20, 17, 11);
    ctx.restore();
    if (working) {
      ctx.fillStyle = pal.screenLine;
      for (let i = 0; i < 3; i++) {
        const w = 4 + ((Math.floor(t * 3) + i * 3 + h) % 9);
        ctx.fillRect(x0 + 37, y0 + 22 + i * 3, Math.min(13, w), 1);
      }
    }
    // 이름표(축소 화면에서는 글자를 키우고 좌석 폭에 맞춰 줄인다)
    if (cam.z >= LABEL_MIN_Z) {
      const k = labelScale();
      ctx.font = `700 ${8 * k}px ${UI_FONT}`;
      // 여백은 고정하고 글자·상태 점만 키워 좌석 폭(60) 안에 이름 3글자가 들어가게 한다
      const dot = 2.5 * k;
      const name = clipToWidth(ctx, plateName(agent), SLOT_W - 11 - dot);
      const tw = ctx.measureText(name).width + 9 + dot;
      const ph = 11 * k;
      const px = Math.round(x0 + 30 - tw / 2);
      ctx.fillStyle = pal.plate; rr(ctx, px, y0 + 52, tw, ph, 3); ctx.fill();
      if (pal.outline) { ctx.strokeStyle = pal.outline; ctx.lineWidth = 1; ctx.stroke(); }
      ctx.fillStyle = statusColor(agent.status); ctx.fillRect(px + 3, y0 + 52 + ph / 2 - dot / 2, dot, dot);
      ctx.fillStyle = pal.plateText; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(name, px + 6 + dot, y0 + 52 + ph / 2 + 0.5);
      if (agent.lead) { ctx.fillStyle = '#fbbf24'; ctx.fillRect(x0 + 30 - 2, y0 + 49, 4, 2); }
    }
    ctx.restore();
    if (seated) {
      if (working) bubbles.push({ x: seat.x, y: seat.y - 30, text: agent.lastTool || '작업 중', kind: 'say' });
      else if (ch.bubble) bubbles.push({ x: seat.x, y: seat.y - 30, text: ch.bubble.text, kind: ch.bubble.kind });
    }
    if (agent.id === selectedId || agent.id === hoverId) {
      if (seated) marker(seat.x, seat.y - 30, agent.id === selectedId);
    }
  }

  function marker(x, y, strong) {
    ctx.fillStyle = pal.select;
    ctx.globalAlpha = strong ? 1 : 0.6;
    ctx.fillRect(x - 3, y - 6, 6, 2); ctx.fillRect(x - 1, y - 4, 2, 2);
    ctx.globalAlpha = 1;
  }

  function drawCeo(room, t, bubbles) {
    drawRoomShell(room, pal.ceo, '대표실', 'CEO · 나', null);
    const cx = room.x + room.w / 2;
    ctx.fillStyle = pal.rug; rr(ctx, cx - 70, room.y + 108, 140, 46, 6); ctx.fill();
    // 책장·트로피·화분
    ctx.fillStyle = pal.wood; ctx.fillRect(room.x + 12, room.y + 40, 26, 44);
    ['#f472b6', '#38bdf8', '#fbbf24', '#a78bfa'].forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(room.x + 15 + i * 6, room.y + 44, 4, 14); ctx.fillRect(room.x + 15 + i * 6, room.y + 64, 4, 14); });
    ctx.fillStyle = '#fbbf24'; ctx.fillRect(room.x + room.w - 30, room.y + 46, 10, 8); ctx.fillRect(room.x + room.w - 27, room.y + 54, 4, 6); ctx.fillRect(room.x + room.w - 30, room.y + 60, 10, 3);
    drawPlant(room.x + room.w - 18, room.y + room.h - 8, true);
    drawPlant(room.x + 18, room.y + room.h - 8, false);
    // 대표 캐릭터와 책상
    ctx.fillStyle = pal.chair; ctx.fillRect(cx - 12, room.y + 46, 24, 22);
    drawCharacter(ctx, cx, room.y + 78, { hair: '#1f2937', shirt: '#334155', pants: '#1e293b', skin: '#f1c7a5', style: 0 },
      { pose: 'sit', bob: Math.floor(t) % 3 === 0, outline: pal.outline, blush: pal.blush });
    ctx.fillStyle = '#ef4444'; ctx.fillRect(cx - 1, room.y + 64, 2, 6); // 넥타이
    ctx.fillStyle = pal.deskTop; ctx.fillRect(cx - 44, room.y + 72, 88, 6);
    ctx.fillStyle = pal.deskFront; ctx.fillRect(cx - 44, room.y + 78, 88, 16);
    ctx.fillStyle = pal.monitor; ctx.fillRect(cx + 14, room.y + 56, 22, 16);
    ctx.fillStyle = pal.screenOn; ctx.fillRect(cx + 16, room.y + 58, 18, 11);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(cx - 34, room.y + 68, 7, 5);
    if (t < ceoBubbleUntil) bubbles.push({ x: cx, y: room.y + 46, text: '수고했어요!', kind: 'say' });
  }

  function drawMeeting(room, t) {
    const busy = [...chars.values()].some((c) => c.job === 'review');
    drawRoomShell(room, pal.meeting, '회의실', 'MEETING', busy ? { text: '리뷰 중', short: '리뷰', dot: '#f472b6' } : { text: '비어 있음', short: '', dot: '#94a3b8' });
    const cx = room.x + room.w / 2;
    // 화이트보드
    ctx.fillStyle = pal.glow ? '#0f1a33' : '#ffffff'; ctx.fillRect(cx - 40, room.y + 34, 80, 26);
    ctx.strokeStyle = pal.glow ? pal.meeting : pal.outline; ctx.lineWidth = 1; ctx.strokeRect(cx - 40, room.y + 34, 80, 26);
    [10, 16, 8, 20].forEach((hh, i) => { ctx.fillStyle = ['#38bdf8', '#f472b6', '#34d399', '#fbbf24'][i]; ctx.fillRect(cx - 30 + i * 9, room.y + 56 - hh, 6, hh); });
    ctx.fillStyle = '#f472b6'; ctx.beginPath(); ctx.arc(cx + 22, room.y + 47, 8, 0, Math.PI * 1.4); ctx.lineTo(cx + 22, room.y + 47); ctx.fill();
    // 테이블과 의자
    for (const dx of [-84, -42, 0, 42, 84]) {
      ctx.fillStyle = pal.chair; ctx.fillRect(cx + dx - 7, room.y + 80, 14, 10); ctx.fillRect(cx + dx - 7, room.y + 126, 14, 10);
    }
    ctx.fillStyle = pal.deskTop; ctx.fillRect(cx - 104, room.y + 90, 208, 8);
    ctx.fillStyle = pal.deskFront; ctx.fillRect(cx - 104, room.y + 98, 208, 26);
    if (pal.outline) { ctx.strokeStyle = pal.outline; ctx.strokeRect(cx - 104, room.y + 90, 208, 34); }
    ctx.fillStyle = '#ffffff'; ctx.fillRect(cx - 60, room.y + 93, 10, 3); ctx.fillRect(cx + 20, room.y + 93, 10, 3);
    drawPlant(room.x + 16, room.y + room.h - 8, true);
    drawPlant(room.x + room.w - 16, room.y + room.h - 8, false);
    ctx.fillStyle = pal.glow ? '#38bdf8' : '#bfe6ff'; ctx.fillRect(room.x + room.w - 26, room.y + 36, 10, 16);
    ctx.fillStyle = pal.glow ? '#1e293b' : '#ffffff'; ctx.fillRect(room.x + room.w - 28, room.y + 52, 14, 14);
  }

  function drawDept(room, t, bubbles) {
    const d = deptById.get(room.id) || room.dept;
    const members = d.members || [];
    const working = members.filter((m) => m.status === 'working').length;
    const onDuty = members.filter((m) => m.status !== 'off-duty').length;
    ctx.save();
    if (d.active === false) ctx.globalAlpha = 0.5;
    drawRoomShell(room, room.color, room.name, room.en, {
      text: `${onDuty}명 근무 · ${working} 작업`, short: `작업 ${working}/${onDuty}`, dot: working ? '#34d399' : onDuty ? '#fbbf24' : '#94a3b8',
    });
    const h = hashString(d.id);
    drawPlant(room.x + 14, room.y + room.h - 6, true);
    drawPlant(room.x + room.w - 14, room.y + room.h - 6, false);
    if (h % 2) {
      ctx.fillStyle = pal.wood; ctx.fillRect(room.x + room.w - 52, room.y + room.h - 30, 26, 24);
      ['#38bdf8', '#f472b6', '#fbbf24'].forEach((c, i) => { ctx.fillStyle = c; ctx.fillRect(room.x + room.w - 49 + i * 7, room.y + room.h - 27, 5, 9); });
    } else {
      ctx.fillStyle = pal.glow ? '#38bdf8' : '#bfe6ff'; ctx.fillRect(room.x + 34, room.y + room.h - 30, 8, 10);
      ctx.fillStyle = pal.glow ? '#1e293b' : '#ffffff'; ctx.fillRect(room.x + 32, room.y + room.h - 20, 12, 14);
    }
    for (const seat of room.seats) drawSlot(seat, t, bubbles);
    if (room.addHint) {
      const a = room.addHint;
      ctx.setLineDash([4, 3]); ctx.strokeStyle = pal.glow ? room.color : pal.outline; ctx.lineWidth = 1;
      rr(ctx, a.x, a.y, a.w, a.h, 6); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = pal.glow ? room.color : pal.text; ctx.font = `800 10px ${UI_FONT}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('+ 직원 추가', a.x + a.w / 2, a.y + a.h / 2);
    }
    ctx.restore();
  }

  function render(t) {
    drawBackground();
    const bubbles = [];
    for (const room of layout.rooms) {
      if (room.kind === 'ceo') drawCeo(room, t, bubbles);
      else if (room.kind === 'meeting') drawMeeting(room, t);
      else drawDept(room, t, bubbles);
    }
    // 서 있거나 걷는 직원
    const movers = [...chars.values()].filter((c) => c.mode !== 'sit' && c.status !== 'off-duty').sort((a, b) => a.y - b.y);
    for (const ch of movers) {
      ctx.fillStyle = pal.shadow; ctx.beginPath(); ctx.ellipse(ch.x, ch.y, 7, 2.5, 0, 0, Math.PI * 2); ctx.fill();
      drawCharacter(ctx, ch.x, ch.y, lookFor(ch.id), {
        pose: ch.mode === 'walk' ? 'walk' : 'stand', frame: Math.floor(t * 8), outline: pal.outline, blush: pal.blush,
      });
      if (cam.z >= LABEL_MIN_Z) {
        const agent = agents.get(ch.id);
        const k = labelScale();
        ctx.font = `700 ${7 * k}px ${UI_FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const name = clipToWidth(ctx, plateName(agent || { id: ch.id }), SLOT_W - 8);
        const tw = ctx.measureText(name).width + 6;
        ctx.fillStyle = pal.plate; rr(ctx, ch.x - tw / 2, ch.y + 2, tw, 9 * k, 2); ctx.fill();
        ctx.fillStyle = pal.plateText; ctx.fillText(name, ch.x, ch.y + 2 + 4.5 * k);
      }
      if (ch.bubble?.text) bubbles.push({ x: ch.x, y: ch.y - 30, text: ch.bubble.text, kind: ch.bubble.kind });
      else if (ch.job === 'review') bubbles.push({ x: ch.x, y: ch.y - 30, text: '검토 중', kind: 'say' });
      if (ch.id === selectedId || ch.id === hoverId) marker(ch.x, ch.y - 30, ch.id === selectedId);
    }
    if (cam.z >= LABEL_MIN_Z) for (const b of bubbles) drawBubble(b.x, b.y, b.text, b.kind);
  }

  function frame(ms) {
    if (!running) return;
    const t = ms / 1000;
    const dt = Math.min(0.1, lastFrame ? t - lastFrame : 0);
    lastFrame = t;
    step(dt, now());
    render(now());
    requestAnimationFrame(frame);
  }

  // ───── 입력 처리 ─────
  function toWorld(ev) {
    const rect = canvas.getBoundingClientRect();
    return { x: cam.x + (ev.clientX - rect.left) / cam.z, y: cam.y + (ev.clientY - rect.top) / cam.z };
  }

  function hitTest(p) {
    const movers = [...chars.values()].filter((c) => c.mode !== 'sit' && c.status !== 'off-duty').sort((a, b) => b.y - a.y);
    for (const ch of movers) if (p.x >= ch.x - 11 && p.x <= ch.x + 11 && p.y >= ch.y - 30 && p.y <= ch.y + 10) return { type: 'agent', id: ch.id };
    for (const room of layout.rooms) {
      if (room.kind !== 'dept') continue;
      for (const s of room.seats) if (p.x >= s.x0 && p.x <= s.x0 + SLOT_W && p.y >= s.y0 + 8 && p.y <= s.y0 + SLOT_H) return { type: 'agent', id: s.agentId };
      const a = room.addHint;
      if (a && p.x >= a.x && p.x <= a.x + a.w && p.y >= a.y && p.y <= a.y + a.h) return { type: 'add', id: room.id };
      if (p.x >= room.x && p.x <= room.x + room.w && p.y >= room.y && p.y <= room.y + room.h) return { type: 'room', id: room.id };
    }
    return null;
  }

  function stopPatrolByUser() {
    userMoved = true; camTarget = null;
    if (patrol) { patrol = false; handlers.onPatrolChange?.(false); }
  }

  let drag = null;
  canvas.addEventListener('pointerdown', (ev) => {
    drag = { sx: ev.clientX, sy: ev.clientY, cx: cam.x, cy: cam.y, moved: false, id: ev.pointerId };
    canvas.setPointerCapture?.(ev.pointerId);
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (drag) {
      const dx = ev.clientX - drag.sx; const dy = ev.clientY - drag.sy;
      if (!drag.moved && Math.hypot(dx, dy) > 4) { drag.moved = true; stopPatrolByUser(); canvas.classList.add('dragging'); }
      if (drag.moved) { cam.x = drag.cx - dx / cam.z; cam.y = drag.cy - dy / cam.z; }
      return;
    }
    const hit = hitTest(toWorld(ev));
    hoverId = hit?.type === 'agent' ? hit.id : null;
    canvas.style.cursor = hit ? 'pointer' : 'grab';
  });
  canvas.addEventListener('pointerup', (ev) => {
    const d = drag; drag = null;
    canvas.classList.remove('dragging');
    if (!d || d.moved) return;
    const hit = hitTest(toWorld(ev));
    if (!hit) return;
    if (hit.type === 'agent') { selectedId = hit.id; handlers.onAgentClick?.(hit.id); } else if (hit.type === 'add') handlers.onAddAgent?.(hit.id);
    else handlers.onRoomClick?.(hit.id);
  });
  canvas.addEventListener('pointercancel', () => { drag = null; canvas.classList.remove('dragging'); });
  canvas.addEventListener('pointerleave', () => { hoverId = null; });
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const rect = canvas.getBoundingClientRect();
    zoomAt(Math.exp(-ev.deltaY * 0.0015), ev.clientX - rect.left, ev.clientY - rect.top);
  }, { passive: false });

  function zoomAt(f, sx = cssW / 2, sy = cssH / 2) {
    stopPatrolByUser();
    const z = Math.max(0.3, Math.min(3, cam.z * f));
    const wx = cam.x + sx / cam.z; const wy = cam.y + sy / cam.z;
    cam.z = z; cam.x = wx - sx / z; cam.y = wy - sy / z;
  }

  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;
  ro?.observe(canvas);
  resize();

  return {
    update,
    setTheme(name) { pal = PALETTES[name] || PALETTES.neon; },
    setPatrol(on) { patrol = !!on; patrolAt = 0; if (!on) camTarget = null; else userMoved = false; },
    setSelected(id) { selectedId = id || null; },
    setVisible(on) {
      if (on && !running) { running = true; lastFrame = 0; resize(); requestAnimationFrame(frame); } else if (!on) running = false;
    },
    zoomIn() { zoomAt(1.25); },
    zoomOut() { zoomAt(0.8); },
    fit() { userMoved = false; fit(false); },
    focusDept(id) { const room = layout.rooms.find((r) => r.id === id); if (room) { stopPatrolByUser(); focusRoom(room); } },
    resize,
    destroy() { running = false; ro?.disconnect(); },
  };
}
