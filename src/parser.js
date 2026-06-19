import crypto from 'node:crypto';
import { config, SERVICE_BY_KEYWORD, SERVICE_BY_CHANNEL } from './config.js';

/**
 * 알림 봇이 슬랙에 뿌리는 메시지를 구조화 파싱한다. 두 종류를 자동 판별:
 *  - kind='exception' : "에러 발생" / [에러 정보] / [스택 트레이스]
 *  - kind='delay'     : "응답 지연 발생" / [성능 정보] (소요 시간/임계치)
 * 둘 다 아니면 null.
 */

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// "Label : value" 한 줄에서 값 추출 (label 은 정규식 일부로 사용 가능, 공백 다수/콜론 허용)
function field(text, label) {
  const re = new RegExp(`^\\s*${label}\\s*:\\s*(.*)$`, 'mi');
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

// "[헤더]" ~ 다음 "[헤더]"(또는 "====" 또는 끝) 사이 블록 추출
function section(text, header) {
  const re = new RegExp(`\\[${header}\\]\\s*\\n([\\s\\S]*?)(?=\\n\\s*\\[[^\\]]+\\]|\\n={3,}|$)`, 'i');
  const m = text.match(re);
  return m ? m[1].replace(/\s+$/, '') : '';
}

// 스택트레이스에서 첫 '내 앱 패키지' 프레임 추출 (prefix 는 config.appPackagePrefix)
function findTopAppFrame(stack) {
  const prefix = escapeRe(config.appPackagePrefix);
  const re = new RegExp(`at\\s+(${prefix}\\.[^\\s(]+)\\(([^:)]+):(\\d+)\\)`);
  const m = stack.match(re);
  if (!m) return null;
  const fqcnMethod = m[1];
  const file = m[2];
  const line = m[3];
  const parts = fqcnMethod.split('.');
  const method = parts.pop();
  const className = parts.pop();
  return { fqcnMethod, file, line, method, className, raw: `${fqcnMethod}(${file}:${line})` };
}

function shortException(type) {
  if (!type) return '';
  return type.split('.').pop().trim();
}

// 서비스 키워드(host 또는 프로젝트명 등)를 찾아 표시명 판별
function detectService(text, channelId) {
  const lower = text.toLowerCase();
  for (const [kw, name] of Object.entries(SERVICE_BY_KEYWORD)) {
    if (lower.includes(kw.toLowerCase())) return name;
  }
  if (channelId && SERVICE_BY_CHANNEL[channelId]) return SERVICE_BY_CHANNEL[channelId];
  return '';
}

// URI 정규화: 쿼리 제거 + 매번 바뀌는 세그먼트(긴 hex/숫자)를 {id} 로 치환
//   /ptfol/cp/dgns/eb7ddda0ffd43bae614d927845d24850/index.do → /ptfol/cp/dgns/{id}/index.do
function normalizeUri(uri) {
  const path = (uri || '').split('?')[0];
  return path
    .split('/')
    .map((seg) => {
      if (/^[0-9a-f]{16,}$/i.test(seg)) return '{id}';
      if (/^\d+$/.test(seg)) return '{id}';
      if (/^[0-9a-f]{8,}-[0-9a-f-]+$/i.test(seg)) return '{id}'; // UUID 류
      return seg;
    })
    .join('/');
}

function sha12(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}

// 모든 종류 공통 요청/세션 필드
function commonFields(text) {
  return {
    requestUri: field(text, 'Request URI'),
    requestMethod: field(text, 'Request Method'),
    queryString: field(text, 'Query String'),
    remoteIp: field(text, 'Remote IP'),
    userAgent: field(text, 'User Agent'),
    referer: field(text, 'Referer'),
  };
}

export function parseError(rawText, channelId = '') {
  if (!rawText || typeof rawText !== 'string') return null;
  const text = rawText.replace(/```/g, '').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

  const common = commonFields(text);
  const service = detectService(`${common.referer} ${common.requestUri} ${text}`, channelId);

  // ── 응답 지연 메시지 ──
  const isDelay = /응답\s*지연/.test(text) || !!section(text, '성능 정보');
  if (isDelay) {
    const elapsed = field(text, '소요\\s*시간');
    const threshold = field(text, '임계치');
    if (!elapsed && !common.requestUri) return null;
    const normalizedUri = normalizeUri(common.requestUri);
    const elapsedMs = parseInt((String(elapsed).match(/(\d+)\s*ms/) || [])[1], 10) || null;
    const fingerprintBase = `delay|${normalizedUri}`;
    return {
      kind: 'delay',
      elapsed,
      elapsedMs,
      threshold,
      normalizedUri,
      ...common,
      params: parseParams(text),
      service,
      fingerprint: sha12(fingerprintBase),
      fingerprintBase,
    };
  }

  // ── 예외 메시지 ──
  const stackTrace = section(text, '스택 트레이스');
  let exceptionType = field(text, 'Exception Type');
  if (!exceptionType && stackTrace) {
    const m = stackTrace.match(/^([\w.$]+(?:Exception|Error|Throwable))(?::|\s|$)/m);
    if (m) exceptionType = m[1];
  }
  const topFrame = findTopAppFrame(stackTrace || text);
  if (!exceptionType && !topFrame) return null;

  const fingerprintBase = [shortException(exceptionType), topFrame ? topFrame.raw : field(text, 'Source')]
    .filter(Boolean)
    .join('|');
  return {
    kind: 'exception',
    exceptionType: shortException(exceptionType),
    exceptionTypeFull: exceptionType,
    message: field(text, 'Message'),
    source: field(text, 'Source'),
    ...common,
    params: parseParams(text),
    stackTrace,
    topFrame,
    service,
    fingerprint: sha12(fingerprintBase),
    fingerprintBase,
  };
}

function parseParams(text) {
  const paramBlock = section(text, '요청 파라미터');
  const params = {};
  for (const line of paramBlock.split('\n')) {
    const m = line.match(/^\s*([\w.]+)\s*:\s*(.*)$/);
    if (m) params[m[1]] = m[2].trim();
  }
  return params;
}

/** 제목 생성 (종류별 분기) */
export function buildTitle(parsed) {
  const servicePart = parsed.service ? `${parsed.service} ` : '';
  const prefix = `[${servicePart}${config.titleLabel}]`;
  let title;
  if (parsed.kind === 'delay') {
    const ms = parsed.elapsedMs ? `${parsed.elapsedMs}ms` : parsed.elapsed;
    title = `${prefix} 응답지연 ${parsed.requestMethod || ''} ${parsed.normalizedUri || parsed.requestUri}`.trim() + (ms ? ` (${ms})` : '');
  } else {
    const where = parsed.topFrame ? ` (${parsed.topFrame.className}.${parsed.topFrame.method})` : '';
    const exc = parsed.exceptionType || 'Runtime exception';
    title = `${prefix} ${exc}${where}`;
  }
  if (title.length > 250) title = title.slice(0, 247) + '...';
  return title;
}
