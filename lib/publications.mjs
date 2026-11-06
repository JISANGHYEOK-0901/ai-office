// 연구 후 결정되는 수신자·게시 문안도 검토한 산출물 안에서 확정한다.
import { createHash } from 'node:crypto';
import { youtubeVideoIds } from './video-history.mjs';
import { MAX_MAILS_PER_RUN } from './guardrails.mjs';

export function preparePublications(plan, readContent, { excludedVideos = [], videoPolicy = null } = {}) {
  const jobs = [], errors = [], skipped = [];
  const seen = new Set(excludedVideos);
  const commented = new Set();
  let postCount = 0, infoCount = 0;
  for (const publication of plan.publications || []) {
    if (publication.action === 'web') {
      // 일반 웹사이트: 지침과 첨부(검토한 단계 산출물)를 그대로 넘긴다. 실제 동작은 직원이 연결 사이트에서 판단한다.
      const files = (publication.files || []).map((ref) => plan.stages.find((s) => s.id === ref || s.output === ref)?.output || null);
      if (files.some((f) => !f)) { errors.push({ stage: '', reason: '일반 웹사이트 업무의 첨부는 계획 단계 산출물이어야 합니다.' }); continue; }
      jobs.push({ publication: { ...publication, id: publication.id || `web-${jobs.length}` }, body: publication.instructions, files, source: files[0] || '' });
      continue;
    }
    const stage = plan.stages.find((s) => s.id === publication.content || s.output === publication.content);
    if (!stage) { errors.push({ stage: '', reason: '외부 작업 본문 단계가 없습니다.' }); continue; }
    const raw = readContent(stage.output);
    let value;
    try { value = JSON.parse(raw); } catch { /* txt/md/HTML 본문 */ }
    let messages;
    // 여러 글·댓글 묶음. 댓글 묶음을 posts로 적은 문안도 받는다
    const drafts = publication.action === 'post' ? value?.posts : publication.action === 'comment' ? value?.comments ?? value?.posts : null;
    const commentBatch = publication.action === 'comment' && Array.isArray(drafts);
    if (publication.action === 'mail' && value && Array.isArray(value.messages)) {
      messages = value.messages;
      if (Array.isArray(value.skipped)) skipped.push(...value.skipped.filter((s) => typeof s === 'string').slice(0, 100));
    } else if (Array.isArray(drafts)) {
      messages = drafts;
      if (Array.isArray(value.skipped)) skipped.push(...value.skipped.filter((s) => typeof s === 'string').slice(0, 100));
      if (!messages.length && !value.skipped?.some((s) => typeof s === 'string' && s.trim())) errors.push({ stage: stage.id, reason: '게시 후보가 없으면 skipped에 확인한 사유를 적어 주세요.' });
    } else if (publication.action === 'comment' && value && typeof value === 'object') {
      // JSON 원문이 댓글 한 건으로 그대로 올라가지 않게 막는다
      errors.push({ stage: stage.id, reason: '여러 댓글은 {comments:[{target,body,subject,author}],skipped:[사유]} 형식으로 쓰세요.' }); continue;
    } else {
      let body = raw;
      if (/\.html?$/i.test(stage.output)) body = (raw.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] || raw)
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<\/(?:p|div|h[1-6]|li|tr|section)>/gi, '\n')
        .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
      messages = [{ recipients: publication.recipients, subject: publication.subject, body }];
    }
    if (messages.length > 500) { errors.push({ stage: stage.id, reason: '한 번에 준비하는 발송 문안은 500개 이하로 나누세요.' }); continue; }
    for (const [index, message] of messages.entries()) {
      if (!message || typeof message.body !== 'string' || !message.body.trim() || message.body.length > 200000 || !commentBatch && typeof message.subject !== 'string') {
        errors.push({ stage: stage.id, reason: '외부 작업마다 제목(subject)·비어 있지 않은 본문(body)이 필요합니다.' }); continue;
      }
      if (publication.action === 'mail' && (!Array.isArray(message.recipients) || !message.recipients.length || message.recipients.some((r) => typeof r !== 'string' || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(r)))) {
        errors.push({ stage: stage.id, reason: '메일은 조사 자료에서 확인한 수신자(recipients)와 제목(subject)·본문(body)을 messages 배열에 정리하세요. 연락처를 확인하지 못한 업체는 skipped에 적고 발송 대상에서 빼세요.' }); continue;
      }
      // 영상이 아닌 글(장소·정보 소개 등)은 kind:"info"로 적고 유튜브 링크를 넣지 않는다. 링크가 있으면 영상 글로 본다
      const info = publication.action === 'post' && message.kind === 'info' && !youtubeVideoIds(message.subject + '\n' + message.body).length;
      if (info && videoPolicy?.uniqueYoutube) {
        // 영상 예약은 지시에 영상이 아닌 글 개수가 있을 때만 그 수까지 받는다(영상 글 목표 수에는 세지 않음)
        const limit = videoPolicy.infoPosts || 0;
        if (infoCount >= limit) { skipped.push(limit ? `오늘 영상이 아닌 글 최대 ${limit}개를 넘는 후보는 제외했습니다: ${message.subject}` : `영상 예약 지시에 영상이 아닌 글 개수가 없어 제외했습니다: ${message.subject}`); continue; }
        infoCount++;
      } else if (publication.action === 'post') {
        const ids = youtubeVideoIds(message.subject + '\n' + message.body);
        if (videoPolicy?.uniqueYoutube && (ids.length !== 1 || youtubeVideoIds(message.body).length !== 1)) { errors.push({ stage: stage.id, reason: '영상 게시글 본문마다 확인한 유튜브 영상 링크를 1개 넣어 주세요. 영상이 아닌 글은 kind:"info"로 적어 주세요.' }); continue; }
        if (ids.some((id) => seen.has(id))) { skipped.push(`중복 또는 게시 결과 확인 중인 영상 제외: ${ids.join(', ')}`); continue; }
        if (videoPolicy?.maxPosts && postCount >= videoPolicy.maxPosts) { skipped.push(`오늘 최대 ${videoPolicy.maxPosts}개를 넘는 후보는 제외했습니다.`); continue; }
        ids.forEach((id) => seen.add(id)); postCount++;
      }
      // 제휴 제안은 대상별 개별 메일로 보내 수신자 주소를 다른 업체에 노출하지 않는다.
      // 글은 앞 단계에서 정한 게시판 주소(posts[].target)로 올릴 수 있다. 대표가 준 주소와 같은 사이트 안만 허용한다
      // 댓글은 글 화면을 모바일 주소(m.)로 여는 경우가 있어 같은 사이트로 본다
      const siteOf = (url) => { const parsed = new URL(url); return parsed.protocol !== 'https:' ? null : publication.action === 'comment' ? parsed.host.replace(/^m\./, '') : parsed.origin; };
      const sameSite = (url) => { try { const site = siteOf(url); return Boolean(site) && site === siteOf(publication.target); } catch { return false; } };
      const wanted = typeof message.target === 'string' ? message.target.trim() : '';
      // 댓글 묶음은 글마다 대상이 다르다. 게시판 주소로 대신 보내지 않고, 같은 글에 두 번 달지 않는다
      if (commentBatch) {
        if (!sameSite(wanted)) { errors.push({ stage: stage.id, reason: '댓글마다 같은 사이트의 대상 글 주소(target)가 필요합니다.' }); continue; }
        if (commented.has(wanted)) { errors.push({ stage: stage.id, reason: `같은 글에 댓글을 두 번 달 수 없습니다: ${wanted}` }); continue; }
        commented.add(wanted);
      }
      const target = (publication.action === 'post' || commentBatch) && wanted && sameSite(wanted) ? wanted : publication.target;
      // 댓글에는 제목 칸이 없다. 문안의 제목·작성자는 대상 글 확인용으로만 넘긴다
      const details = commentBatch
        ? { subject: '', targetTitle: typeof message.subject === 'string' ? message.subject.trim() : '', targetAuthor: typeof message.author === 'string' ? message.author.trim() : '' }
        : { subject: message.subject, kind: info ? 'info' : undefined };
      for (const recipients of publication.action === 'mail' ? message.recipients.map((r) => [r]) : [[]]) {
        jobs.push({ publication: { ...publication, id: `${publication.id}-${index}`, content: stage.output, target,
          ...details, recipients }, body: message.body, source: stage.output });
      }
    }
  }
  return { jobs, errors, skipped };
}

// 보낸 메일 식별: 같은 수신자·제목·본문(첨부가 있으면 첨부 이름까지)이면 같은 메일이다(이어 보내기에서 다시 보내지 않음)
export const mailKey = (job) => createHash('sha256').update(JSON.stringify([job.publication.recipients, job.publication.subject, job.body,
  ...(job.publication.attachments?.length ? [job.publication.attachments] : [])])).digest('hex').slice(0, 32);

// 메일 대량 발송 금지: 이번 확인에서 보낼 수 있는 통수(allowance, 보낸 메일 포함 누적)까지만 실행 목록에 넣는다.
// 이미 보낸 메일은 실행 목록에 남겨 결과를 보고하고(실제 재발송은 하지 않음), 나머지는 remaining으로 돌려 대표에게 다시 묻는다
export function splitMailBatch(jobs, { sent = [], allowance = MAX_MAILS_PER_RUN } = {}) {
  const done = new Set(sent);
  const isMail = (job) => job.publication.action === 'mail';
  const sentCount = jobs.filter((job) => isMail(job) && done.has(mailKey(job))).length;
  let room = Math.max(0, allowance - sentCount);
  const run = [], remaining = [];
  for (const job of jobs) {
    if (!isMail(job) || done.has(mailKey(job))) run.push(job);
    else if (room > 0) { run.push(job); room--; } else remaining.push(job);
  }
  return { run, remaining, sentCount };
}
