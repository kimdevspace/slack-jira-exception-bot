import { config } from './config.js';
import { buildDescriptionAdf, buildRecurrenceAdf } from './adf.js';

const OCCUR_PREFIX = 'occur-';

export class JiraClient {
  constructor() {
    this.base = config.jira.baseUrl;
    this.auth = 'Basic ' + Buffer.from(`${config.jira.email}:${config.jira.apiToken}`).toString('base64');
    this._accountIdByEmail = new Map(); // email → accountId 캐시
  }

  async _req(method, path, body) {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: this.auth,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const contentType = res.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await res.json().catch(() => ({})) : await res.text();
    if (!res.ok) {
      const detail = typeof payload === 'string' ? payload : JSON.stringify(payload);
      const err = new Error(`Jira ${method} ${path} → ${res.status}: ${detail.slice(0, 500)}`);
      err.status = res.status;
      err.payload = payload;
      throw err;
    }
    return payload;
  }

  /** 이메일 → Jira accountId (캐시). 못 찾으면 null */
  async resolveAccountId(email) {
    if (!email) return null;
    if (this._accountIdByEmail.has(email)) return this._accountIdByEmail.get(email);
    let accountId = null;
    try {
      const users = await this._req('GET', `/rest/api/3/user/search?query=${encodeURIComponent(email)}`);
      const hit = Array.isArray(users)
        ? users.find((u) => (u.emailAddress || '').toLowerCase() === email.toLowerCase()) || users[0]
        : null;
      accountId = hit ? hit.accountId : null;
    } catch (e) {
      console.warn(`accountId 조회 실패(${email}):`, e.message);
    }
    this._accountIdByEmail.set(email, accountId);
    return accountId;
  }

  /** 기본 담당자(설정의 assigneeEmail, 보통 봇 운영자 본인) accountId */
  async defaultAccountId() {
    const id = await this.resolveAccountId(config.jira.assigneeEmail);
    if (!id) throw new Error(`기본 담당자(${config.jira.assigneeEmail}) accountId 조회 실패`);
    return id;
  }

  fingerprintLabel(fingerprint) {
    return `${config.jira.fingerprintPrefix}${fingerprint}`;
  }

  /** 지문 라벨로 기존 이슈 검색. 있으면 {key, labels} 반환, 없으면 null */
  async findByFingerprint(fingerprint) {
    const label = this.fingerprintLabel(fingerprint);
    const jql = `project = ${config.jira.projectKey} AND labels = "${label}" ORDER BY created DESC`;
    const data = await this._req('POST', '/rest/api/3/search/jql', {
      jql,
      fields: ['labels', 'summary', 'status'],
      maxResults: 1,
    });
    const issue = data.issues && data.issues[0];
    if (!issue) return null;
    return { key: issue.key, labels: issue.fields.labels || [], summary: issue.fields.summary };
  }

  /**
   * 신규 이슈 생성. reporterId/assigneeId = 이모지 단 개발자(없으면 기본 담당자).
   * 토큰 주인에게 "보고자 수정" 권한이 없거나 담당자 지정이 거부되면 해당 필드만 빼고 1회 재시도.
   * @returns {key, url, droppedFields}
   */
  async createIssue({ title, parsed, slackUrl, occurredAt, reporterId, assigneeId }) {
    const labels = [
      ...config.jira.defaultLabels,
      this.fingerprintLabel(parsed.fingerprint),
      `${OCCUR_PREFIX}1`,
    ];
    if (parsed.kind === 'delay') labels.push(config.jira.delayLabel);
    const description = buildDescriptionAdf(parsed, {
      slackUrl,
      occurredAt,
      appendSkeleton: config.appendResolutionSkeleton,
    });
    const fields = {
      project: { key: config.jira.projectKey },
      issuetype: { id: config.jira.issueTypeId },
      summary: title,
      labels,
      description,
    };
    if (assigneeId) fields.assignee = { id: assigneeId };
    if (reporterId) fields.reporter = { id: reporterId };

    const droppedFields = [];
    try {
      const data = await this._req('POST', '/rest/api/3/issue', { fields });
      return { key: data.key, url: `${this.base}/browse/${data.key}`, droppedFields };
    } catch (e) {
      // 400 이고 reporter/assignee 필드 문제면 그 필드만 제거 후 재시도
      const errs = e.status === 400 && e.payload && e.payload.errors ? e.payload.errors : null;
      if (errs && (errs.reporter || errs.assignee)) {
        if (errs.reporter) { delete fields.reporter; droppedFields.push('reporter'); }
        if (errs.assignee) { delete fields.assignee; droppedFields.push('assignee'); }
        const data = await this._req('POST', '/rest/api/3/issue', { fields });
        return { key: data.key, url: `${this.base}/browse/${data.key}`, droppedFields };
      }
      throw e;
    }
  }

  /** 기존 이슈에 재발생 기록: occur-N 라벨 증가 + 코멘트 추가 → {key, url, count} */
  async recordRecurrence(existing, { slackUrl, occurredAt, remoteIp, byName, kindLabel }) {
    const { key, labels } = existing;
    let count = 1;
    const occurLabel = labels.find((l) => l.startsWith(OCCUR_PREFIX));
    if (occurLabel) {
      const n = parseInt(occurLabel.slice(OCCUR_PREFIX.length), 10);
      if (!Number.isNaN(n)) count = n;
    }
    const next = count + 1;

    // 라벨 occur-N → occur-(N+1)
    const update = { update: { labels: [] } };
    if (occurLabel) update.update.labels.push({ remove: occurLabel });
    update.update.labels.push({ add: `${OCCUR_PREFIX}${next}` });
    await this._req('PUT', `/rest/api/3/issue/${key}`, update);

    // 재발생 코멘트
    await this._req('POST', `/rest/api/3/issue/${key}/comment`, {
      body: buildRecurrenceAdf({ occurredAt, remoteIp, slackUrl, count: next, byName, kindLabel }),
    });

    return { key, url: `${this.base}/browse/${key}`, count: next };
  }
}
