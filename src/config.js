import 'dotenv/config';
import fs from 'node:fs';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`환경변수 ${name} 가 설정되지 않았습니다. .env 를 확인하세요.`);
  return v;
}

function list(name, fallback = '') {
  return (process.env[name] ?? fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  slack: {
    botToken: required('SLACK_BOT_TOKEN'),
    appToken: required('SLACK_APP_TOKEN'),
    triggerEmoji: process.env.TRIGGER_EMOJI || 'ticket',
    allowedChannels: list('ALLOWED_CHANNELS'), // 비우면 전체 허용
  },
  jira: {
    baseUrl: (process.env.JIRA_BASE_URL || 'https://your-domain.atlassian.net').replace(/\/$/, ''),
    email: required('JIRA_EMAIL'),
    apiToken: required('JIRA_API_TOKEN'),
    projectKey: process.env.JIRA_PROJECT_KEY || 'PROJ',
    issueTypeId: process.env.JIRA_ISSUE_TYPE_ID || '10001',
    assigneeEmail: process.env.JIRA_ASSIGNEE_EMAIL || process.env.JIRA_EMAIL,
    defaultLabels: list('JIRA_DEFAULT_LABELS', 'monitoring'),
    fingerprintPrefix: process.env.FINGERPRINT_LABEL_PREFIX || 'autoexc-',
  },
  // 스택트레이스에서 '내 애플리케이션' 프레임을 식별할 패키지 prefix (예: com.mycompany)
  appPackagePrefix: process.env.APP_PACKAGE_PREFIX || 'com.example',
  // 제목 라벨: `[{서비스명} {titleLabel}] ...` 형태로 들어감
  titleLabel: process.env.TITLE_LABEL || 'monitoring',
  appendResolutionSkeleton: (process.env.APPEND_RESOLUTION_SKELETON ?? 'true') !== 'false',
};

// host/URL 키워드 → 서비스(표시)명 매핑.
// 실제 매핑은 services.local.json (git 미추적) 에 두고, 없으면 services.example.json 로 폴백.
// 형식: { "byKeyword": { "host키워드": "표시명" }, "byChannel": { "채널ID": "표시명" } }
function loadJson(relPath) {
  try {
    return JSON.parse(fs.readFileSync(new URL(relPath, import.meta.url), 'utf8'));
  } catch {
    return null;
  }
}
const serviceMap = loadJson('../services.local.json') || loadJson('../services.example.json') || {};
export const SERVICE_BY_KEYWORD = serviceMap.byKeyword || {};
export const SERVICE_BY_CHANNEL = serviceMap.byChannel || {};
