import bolt from '@slack/bolt';
import { config } from './config.js';
import { parseError, buildTitle } from './parser.js';
import { JiraClient } from './jira.js';

const { App } = bolt;

const app = new App({
  token: config.slack.botToken,
  appToken: config.slack.appToken,
  socketMode: true,
});

const jira = new JiraClient();

// 같은 메시지를 짧은 시간에 여러 번 처리하지 않도록 (이모지 중복 추가 등)
const inFlight = new Set();

async function addReaction(client, channel, ts, name) {
  try {
    await client.reactions.add({ channel, timestamp: ts, name });
  } catch (e) {
    if (e?.data?.error !== 'already_reacted') console.warn('reaction add 실패:', e?.data?.error || e.message);
  }
}

// 이모지 단 슬랙 사용자 → { email, name }
async function getReactor(client, userId) {
  try {
    const info = await client.users.info({ user: userId });
    const p = info.user?.profile || {};
    return { email: p.email || '', name: info.user?.real_name || p.display_name || info.user?.name || userId };
  } catch (e) {
    console.warn('users.info 실패:', e?.data?.error || e.message);
    return { email: '', name: userId };
  }
}

// 메시지 객체를 재귀적으로 훑어 모든 텍스트를 수집
// (Block Kit rich_text / section / attachments 등 어떤 중첩 구조여도 대응)
function collectText(node, acc) {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const x of node) collectText(x, acc);
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if ((k === 'text' || k === 'fallback' || k === 'pretext' || k === 'title') && typeof v === 'string') {
      acc.push(v);
    } else if (typeof v === 'object') {
      collectText(v, acc);
    }
  }
}

function extractText(msg) {
  const acc = [];
  if (typeof msg.text === 'string') acc.push(msg.text);
  collectText(msg.blocks, acc);
  collectText(msg.attachments, acc);
  return acc.join('\n');
}

app.event('reaction_added', async ({ event, client }) => {
  if (event.reaction !== config.slack.triggerEmoji) return;
  if (event.item?.type !== 'message') return;

  const channel = event.item.channel;
  const ts = event.item.ts;

  if (config.slack.allowedChannels.length && !config.slack.allowedChannels.includes(channel)) return;

  const dedupeKey = `${channel}:${ts}`;
  if (inFlight.has(dedupeKey)) return;
  inFlight.add(dedupeKey);

  try {
    // 반응 달린 원본 메시지 가져오기
    const hist = await client.conversations.history({
      channel,
      latest: ts,
      inclusive: true,
      limit: 1,
    });
    const msg = hist.messages && hist.messages[0];
    if (!msg) return;

    const text = extractText(msg);
    const parsed = parseError(text, channel);
    if (!parsed) {
      console.warn('파싱 실패. 추출 텍스트 %d자, 블록타입=%s\n--- 추출본 앞부분 ---\n%s',
        text.length,
        (msg.blocks || []).map((b) => b.type).join(',') || '(none)',
        text.slice(0, 400));
      await addReaction(client, channel, ts, 'question'); // 에러 메시지로 인식 못함
      await client.chat.postMessage({
        channel,
        thread_ts: ts,
        text: '⚠️ 예외/스택트레이스를 인식하지 못해 Jira 등록을 건너뛰었습니다.',
      });
      return;
    }

    // 슬랙 원본 permalink + 발생시각
    let slackUrl = '';
    try {
      const pl = await client.chat.getPermalink({ channel, message_ts: ts });
      slackUrl = pl.permalink;
    } catch { /* permalink 실패해도 진행 */ }
    const occurredAt = new Date(Number(ts.split('.')[0]) * 1000).toLocaleString('ko-KR', {
      timeZone: 'Asia/Seoul',
    });

    // 이모지 단 개발자 → Jira accountId (못 찾으면 기본 담당자=봇 운영자로 폴백)
    const reactor = await getReactor(client, event.user);
    const devId = await jira.resolveAccountId(reactor.email);
    const ownerId = devId || (await jira.defaultAccountId());

    // 지문으로 기존 이슈 검색 → 재발생 or 신규
    const existing = await jira.findByFingerprint(parsed.fingerprint);
    let result, isNew;
    if (existing) {
      result = await jira.recordRecurrence(existing, {
        slackUrl,
        occurredAt,
        remoteIp: parsed.remoteIp,
        byName: reactor.name,
      });
      isNew = false;
    } else {
      const title = buildTitle(parsed);
      result = await jira.createIssue({
        title,
        parsed,
        slackUrl,
        occurredAt,
        reporterId: ownerId,
        assigneeId: ownerId,
      });
      isNew = true;
    }

    await addReaction(client, channel, ts, 'white_check_mark');
    const whoNote = !devId
      ? `\n⚠️ ${reactor.email || reactor.name} 의 Jira 계정을 못 찾아 ${config.jira.assigneeEmail}(으)로 등록했습니다.`
      : '';
    const dropNote = result.droppedFields?.length
      ? `\n⚠️ 권한 부족으로 ${result.droppedFields.join('/')} 지정이 생략됐습니다(보고자 수정 권한 확인 필요).`
      : '';
    await client.chat.postMessage({
      channel,
      thread_ts: ts,
      text: isNew
        ? `✅ Jira 등록 완료 → <${result.url}|${result.key}>\n• ${parsed.service || '서비스 미상'} · ${parsed.exceptionType} · ${parsed.source}\n• 보고자/담당자: ${reactor.name}${whoNote}${dropNote}`
        : `♻️ 이미 등록된 예외입니다 → <${result.url}|${result.key}> (재발생 ${result.count}회째 기록 by ${reactor.name})`,
    });
    console.log(`[${isNew ? 'CREATE' : 'RECUR'}] ${result.key} fp=${parsed.fingerprint} ${parsed.service} ${parsed.exceptionType}`);
  } catch (err) {
    console.error('처리 실패:', err);
    await addReaction(client, channel, ts, 'warning');
    await client.chat.postMessage({
      channel,
      thread_ts: ts,
      text: `❌ Jira 등록 중 오류: ${err.message?.slice(0, 300) || err}`,
    }).catch(() => {});
  } finally {
    inFlight.delete(dedupeKey);
  }
});

(async () => {
  // 시작 시 기본 담당자 accountId 미리 검증
  await jira.defaultAccountId();
  await app.start();
  console.log(`⚡️ Slack→Jira 예외봇 가동. 트리거 이모지 = :${config.slack.triggerEmoji}: → ${config.jira.projectKey}`);
})().catch((e) => {
  console.error('기동 실패:', e.message);
  process.exit(1);
});
