// 연구 후 결정되는 수신자·게시 문안도 검토한 산출물 안에서 확정한다.
import { youtubeVideoIds } from './video-history.mjs';

export function preparePublications(plan, readContent, { excludedVideos = [], videoPolicy = null } = {}) {
  const jobs = [], errors = [], skipped = [];
  const seen = new Set(excludedVideos);
  let postCount = 0;
  for (const publication of plan.publications || []) {
    const stage = plan.stages.find((s) => s.id === publication.content || s.output === publication.content);
    if (!stage) { errors.push({ stage: '', reason: '외부 작업 본문 단계가 없습니다.' }); continue; }
    const raw = readContent(stage.output);
    let value;
    try { value = JSON.parse(raw); } catch { /* txt/md/HTML 본문 */ }
    let messages;
    if (publication.action === 'mail' && value && Array.isArray(value.messages)) {
      messages = value.messages;
      if (Array.isArray(value.skipped)) skipped.push(...value.skipped.filter((s) => typeof s === 'string').slice(0, 100));
    } else if (publication.action === 'post' && value && Array.isArray(value.posts)) {
      messages = value.posts;
      if (Array.isArray(value.skipped)) skipped.push(...value.skipped.filter((s) => typeof s === 'string').slice(0, 100));
      if (!messages.length && !value.skipped?.some((s) => typeof s === 'string' && s.trim())) errors.push({ stage: stage.id, reason: '게시 후보가 없으면 skipped에 확인한 사유를 적어 주세요.' });
    } else {
      let body = raw;
      if (/\.html?$/i.test(stage.output)) body = (raw.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] || raw)
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<\/(?:p|div|h[1-6]|li|tr|section)>/gi, '\n')
        .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
      messages = [{ recipients: publication.recipients, subject: publication.subject, body }];
    }
    if (messages.length > 500) { errors.push({ stage: stage.id, reason: '한 번에 준비하는 발송 문안은 500개 이하로 나누세요.' }); continue; }
    for (const [index, message] of messages.entries()) {
      if (!message || typeof message.body !== 'string' || !message.body.trim() || message.body.length > 200000 || typeof message.subject !== 'string') {
        errors.push({ stage: stage.id, reason: '외부 작업마다 제목(subject)·비어 있지 않은 본문(body)이 필요합니다.' }); continue;
      }
      if (publication.action === 'mail' && (!Array.isArray(message.recipients) || !message.recipients.length || message.recipients.some((r) => typeof r !== 'string' || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(r)))) {
        errors.push({ stage: stage.id, reason: '메일은 조사 자료에서 확인한 수신자(recipients)와 제목(subject)·본문(body)을 messages 배열에 정리하세요. 연락처를 확인하지 못한 업체는 skipped에 적고 발송 대상에서 빼세요.' }); continue;
      }
      if (publication.action === 'post') {
        const ids = youtubeVideoIds(message.subject + '\n' + message.body);
        if (videoPolicy?.uniqueYoutube && (ids.length !== 1 || youtubeVideoIds(message.body).length !== 1)) { errors.push({ stage: stage.id, reason: '영상 게시글 본문마다 확인한 유튜브 영상 링크를 1개 넣어 주세요.' }); continue; }
        if (ids.some((id) => seen.has(id))) { skipped.push(`중복 또는 게시 결과 확인 중인 영상 제외: ${ids.join(', ')}`); continue; }
        if (videoPolicy?.maxPosts && postCount >= videoPolicy.maxPosts) { skipped.push(`오늘 최대 ${videoPolicy.maxPosts}개를 넘는 후보는 제외했습니다.`); continue; }
        ids.forEach((id) => seen.add(id)); postCount++;
      }
      // 제휴 제안은 대상별 개별 메일로 보내 수신자 주소를 다른 업체에 노출하지 않는다.
      for (const recipients of publication.action === 'mail' ? message.recipients.map((r) => [r]) : [[]]) {
        jobs.push({ publication: { ...publication, id: `${publication.id}-${index}`, content: stage.output,
          subject: message.subject, recipients }, body: message.body, source: stage.output });
      }
    }
  }
  return { jobs, errors, skipped };
}
