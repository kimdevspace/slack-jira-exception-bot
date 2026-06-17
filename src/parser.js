import crypto from 'node:crypto';
import { config, SERVICE_BY_KEYWORD, SERVICE_BY_CHANNEL } from './config.js';

/**
 * 에러 알림 봇이 슬랙에 뿌리는 예외 메시지를 구조화 파싱한다.
 * 기대 포맷(섹션 헤더 기반):
 *   ================== 에러 발생 ==================
 *   [에러 정보]
 *     Exception Type: NullPointerException
 *     Message       : ...
 *     Source        : FooController.java:42
 *   [요청 정보]
 *     Request URI   : /api/...
 *     ...
 *   [스택 트레이스]
 *     java.lang.NullPointerException
 *       at com.example.web.FooController.bar(FooController.java:42)
 *   ====================================================
 */

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// "Label : value" 한 줄에서 값 추출 (공백 다수/콜론 허용)
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
//   at com.example.web.FooController.bar(FooController.java:42)
function findTopAppFrame(stack) {
  const prefix = escapeRe(config.appPackagePrefix);
  const re = new RegExp(`at\\s+(${prefix}\\.[^\\s(]+)\\(([^:)]+):(\\d+)\\)`);
  const m = stack.match(re);
  if (!m) return null;
  const fqcnMethod = m[1]; // com.example....FooController.bar
  const file = m[2]; // FooController.java
  const line = m[3]; // 42
  const parts = fqcnMethod.split('.');
  const method = parts.pop();
  const className = parts.pop();
  return { fqcnMethod, file, line, method, className, raw: `${fqcnMethod}(${file}:${line})` };
}

// 예외 타입 정규화: java.lang.NullPointerException → NullPointerException
function shortException(type) {
  if (!type) return '';
  return type.split('.').pop().trim();
}

// 메시지/스택 어디서든 서비스 키워드(host 등)를 찾아 표시명 판별
function detectService(text, channelId) {
  const lower = text.toLowerCase();
  for (const [kw, name] of Object.entries(SERVICE_BY_KEYWORD)) {
    if (lower.includes(kw)) return name;
  }
  if (channelId && SERVICE_BY_CHANNEL[channelId]) return SERVICE_BY_CHANNEL[channelId];
  return '';
}

/**
 * @returns {null | {
 *   exceptionType, message, source, requestUri, requestMethod, queryString,
 *   remoteIp, userAgent, referer, params, stackTrace, topFrame, service,
 *   fingerprint, fingerprintBase
 * }}
 *  파싱 불가(예외/스택 못 찾음)면 null.
 */
export function parseError(rawText, channelId = '') {
  if (!rawText || typeof rawText !== 'string') return null;
  // 코드블록 백틱/슬랙 escape 정리
  const text = rawText.replace(/```/g, '').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

  const stackTrace = section(text, '스택 트레이스');
  let exceptionType = field(text, 'Exception Type');

  // 스택 트레이스 첫 줄에서 예외타입 보강 (예: java.lang.NullPointerException)
  if (!exceptionType && stackTrace) {
    const m = stackTrace.match(/^([\w.$]+(?:Exception|Error|Throwable))(?::|\s|$)/m);
    if (m) exceptionType = m[1];
  }

  const topFrame = findTopAppFrame(stackTrace || text);

  // 예외도 스택도 못 찾으면 에러 메시지가 아님
  if (!exceptionType && !topFrame) return null;

  // 요청 파라미터 블록 → 객체
  const paramBlock = section(text, '요청 파라미터');
  const params = {};
  for (const line of paramBlock.split('\n')) {
    const m = line.match(/^\s*([\w.]+)\s*:\s*(.*)$/);
    if (m) params[m[1]] = m[2].trim();
  }

  const requestUri = field(text, 'Request URI');
  const referer = field(text, 'Referer');
  const service = detectService(`${referer} ${requestUri} ${text}`, channelId);

  // 지문: 예외타입 + 최상단 앱 프레임. 라인번호 포함(같은 버그면 동일, 핫픽스로 라인 이동 시 신규로 취급).
  const fingerprintBase = [shortException(exceptionType), topFrame ? topFrame.raw : field(text, 'Source')]
    .filter(Boolean)
    .join('|');
  const fingerprint = crypto.createHash('sha1').update(fingerprintBase).digest('hex').slice(0, 12);

  return {
    exceptionType: shortException(exceptionType),
    exceptionTypeFull: exceptionType,
    message: field(text, 'Message'),
    source: field(text, 'Source'),
    requestUri,
    requestMethod: field(text, 'Request Method'),
    queryString: field(text, 'Query String'),
    remoteIp: field(text, 'Remote IP'),
    userAgent: field(text, 'User Agent'),
    referer,
    params,
    stackTrace,
    topFrame,
    service,
    fingerprint,
    fingerprintBase,
  };
}

/** 제목 생성: [{서비스} {titleLabel}] {예외타입} ({Class}.{method}) — 서비스 미상이면 [{titleLabel}] */
export function buildTitle(parsed) {
  const servicePart = parsed.service ? `${parsed.service} ` : '';
  const where = parsed.topFrame ? ` (${parsed.topFrame.className}.${parsed.topFrame.method})` : '';
  const exc = parsed.exceptionType || 'Runtime exception';
  let title = `[${servicePart}${config.titleLabel}] ${exc}${where}`;
  // Jira summary 길이 안전선
  if (title.length > 250) title = title.slice(0, 247) + '...';
  return title;
}
