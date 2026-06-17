// Atlassian Document Format(ADF) 빌더 — Jira Cloud api/3 본문/코멘트용

const text = (s) => ({ type: 'text', text: String(s ?? '') });
const strong = (s) => ({ type: 'text', text: String(s ?? ''), marks: [{ type: 'strong' }] });

const paragraph = (...content) => ({ type: 'paragraph', content: content.length ? content : [text('')] });
const heading = (level, s) => ({ type: 'heading', attrs: { level }, content: [text(s)] });
const codeBlock = (s, language = 'java') => ({
  type: 'codeBlock',
  attrs: { language },
  content: [text(s || '(스택트레이스 없음)')],
});
const link = (label, href) => ({ type: 'text', text: label, marks: [{ type: 'link', attrs: { href } }] });

function bulletList(items) {
  return {
    type: 'bulletList',
    content: items.map((nodes) => ({
      type: 'listItem',
      content: [{ type: 'paragraph', content: Array.isArray(nodes) ? nodes : [nodes] }],
    })),
  };
}

function doc(content) {
  return { version: 1, type: 'doc', content };
}

/**
 * 사실 기록형 본문 생성 (LLM 추측 없음).
 * @param {object} p parseError 결과
 * @param {object} opts { slackUrl, occurredAt, appendSkeleton }
 */
export function buildDescriptionAdf(p, { slackUrl, occurredAt, appendSkeleton } = {}) {
  const facts = [
    [strong('예외'), text(`  ${p.exceptionTypeFull || p.exceptionType}`)],
    [strong('발생 위치'), text(`  ${p.source || (p.topFrame ? p.topFrame.raw : '-')}`)],
    [strong('요청'), text(`  ${p.requestMethod || ''} ${p.requestUri || '-'}`)],
  ];
  if (p.message && p.message !== 'No message available') facts.push([strong('메시지'), text(`  ${p.message}`)]);
  if (p.remoteIp) facts.push([strong('발생 IP'), text(`  ${p.remoteIp}`)]);
  if (occurredAt) facts.push([strong('발생 시각'), text(`  ${occurredAt}`)]);

  const content = [heading(3, '발생 현황'), bulletList(facts)];

  // 요청 파라미터
  const paramEntries = Object.entries(p.params || {}).filter(([, v]) => v !== '');
  if (paramEntries.length) {
    content.push(heading(4, '요청 파라미터'));
    content.push(bulletList(paramEntries.map(([k, v]) => [strong(k), text(` : ${v}`)])));
  }

  // 스택 트레이스
  content.push(heading(4, '스택 트레이스'));
  content.push(codeBlock(p.stackTrace, 'java'));

  // 출처 링크
  const refs = [];
  if (slackUrl) refs.push([link('Slack 원본 알림 보기', slackUrl)]);
  if (p.referer) refs.push([text('Referer: '), link(p.referer, p.referer)]);
  if (refs.length) {
    content.push(heading(4, '출처'));
    content.push(bulletList(refs));
  }

  // 조사 후 채울 빈 골격 (기존 컨벤션과 동일)
  if (appendSkeleton) {
    content.push({ type: 'rule' });
    content.push(heading(2, '원인'));
    content.push(paragraph(text('(조사 후 작성)')));
    content.push(heading(2, '수정 내용'));
    content.push(paragraph(text('(작성)')));
    content.push(heading(2, '효과'));
    content.push(paragraph(text('(작성)')));
  }

  // 지문 (재현/추적용, 사람이 봐도 무방)
  content.push({ type: 'rule' });
  content.push(paragraph(text(`자동등록 · 지문 ${p.fingerprint}`)));

  return doc(content);
}

/** 재발생 코멘트 본문 */
export function buildRecurrenceAdf({ occurredAt, remoteIp, slackUrl, count, byName }) {
  const line = [strong('🔁 동일 예외 재발생 감지')];
  if (count) line.push(text(`  (누적 ${count}회)`));
  const info = [];
  if (occurredAt) info.push([strong('시각'), text(`  ${occurredAt}`)]);
  if (remoteIp) info.push([strong('IP'), text(`  ${remoteIp}`)]);
  if (byName) info.push([strong('기록'), text(`  ${byName}`)]);
  if (slackUrl) info.push([link('Slack 원본 보기', slackUrl)]);
  return doc([{ type: 'paragraph', content: line }, bulletList(info.length ? info : [[text('-')]])]);
}
