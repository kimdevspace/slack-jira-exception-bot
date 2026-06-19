// 예외 샘플로 파서/지문/제목을 검증 (env 불필요하도록 더미값 주입)
process.env.SLACK_BOT_TOKEN ||= 'xoxb-test';
process.env.SLACK_APP_TOKEN ||= 'xapp-test';
process.env.JIRA_EMAIL ||= 'test@example.com';
process.env.JIRA_API_TOKEN ||= 'test';
process.env.APP_PACKAGE_PREFIX ||= 'com.example';

const { parseError, buildTitle } = await import('../src/parser.js');

const SAMPLE = `================== 에러 발생 ==================
[에러 정보]
  Exception Type: NullPointerException
  Message       : No message available
  Source        : FooController.java:42

[요청 정보]
  Request URI   : /api/foo/now
  Request Method: POST
  Query String  : null
  Remote IP     : 10.0.0.5
  User Agent    : Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0
  Referer       : https://app.alpha.example.com/foo/list?page=1

[요청 파라미터]
  kind : 1000014
  seq :
  userId : 12345

[세션 정보]
  Session ID    : 377DFFE9826E43E3400C10AF2B39CAC5
  Session Create: Tue Jun 16 22:03:25 KST 2026
  Last Accessed : Tue Jun 16 22:03:25 KST 2026

[스택 트레이스]
java.lang.NullPointerException
    at com.example.web.FooController.now(FooController.java:42)
    at sun.reflect.GeneratedMethodAccessor608.invoke(Unknown Source)
    at java.lang.reflect.Method.invoke(Method.java:498)
    at org.springframework.web.servlet.DispatcherServlet.doDispatch(DispatcherServlet.java:938)
... (42 more lines)
====================================================`;

const parsed = parseError(SAMPLE, 'C0TEST');
console.log('--- 파싱 결과 ---');
console.log('서비스      :', parsed.service);
console.log('예외타입    :', parsed.exceptionType);
console.log('발생위치    :', parsed.source);
console.log('Request URI :', parsed.requestUri, `(${parsed.requestMethod})`);
console.log('topFrame    :', parsed.topFrame?.raw);
console.log('지문 base   :', parsed.fingerprintBase);
console.log('지문 해시   :', parsed.fingerprint, '→ 라벨 autoexc-' + parsed.fingerprint);
console.log('파라미터    :', JSON.stringify(parsed.params));
console.log('\n--- 제목 ---');
console.log(buildTitle(parsed));

// 같은 예외 = 같은 지문인지 (IP/세션/시각만 다른 재발생 케이스)
const recur = SAMPLE
  .replace('10.0.0.5', '203.0.113.9')
  .replace('377DFFE9826E43E3400C10AF2B39CAC5', 'AAAA0000BBBB1111CCCC2222DDDD3333')
  .replace('Tue Jun 16 22:03:25 KST 2026', 'Wed Jun 17 09:10:00 KST 2026');
const parsed2 = parseError(recur, 'C0TEST');
console.log('\n--- 재발생(다른 IP/세션/시각) 지문 일치? ---');
console.log(parsed.fingerprint, '===', parsed2.fingerprint, '→', parsed.fingerprint === parsed2.fingerprint ? 'OK 동일 ✅' : 'FAIL ❌');

// 비-에러 메시지는 null
console.log('\n--- 일반 잡담 메시지 파싱 ---');
console.log(parseError('점심 뭐 먹지', 'C0TEST') === null ? 'null 반환 OK ✅' : 'FAIL ❌');

// ── 응답지연 메시지 ──
const DELAY = `================== 응답 지연 발생 ==================
[성능 정보]
  소요 시간     : 8898ms (8.898s)
  임계치        : 5000ms

[요청 정보]
  Request URI   : /ptfol/cp/dgns/eb7ddda0ffd43bae614d927845d24850/index.do
  Request Method: GET
  Query String  : null
  Remote IP     : 58.232.149.156

[세션 정보]
  Session ID    : 3A757A6676241E6F3F7C42A176FF25CE
  User Name     : 박보영
====================================================`;
const d = parseError(DELAY, 'C0TEST');
console.log('\n--- 응답지연 파싱 ---');
console.log('kind        :', d?.kind);
console.log('소요시간    :', d?.elapsed, '/ ms:', d?.elapsedMs, '/ 임계치:', d?.threshold);
console.log('정규화 URI  :', d?.normalizedUri);
console.log('지문        :', d?.fingerprint);
console.log('제목        :', d ? buildTitle(d) : '(null)');

// 다른 엔티티 해시여도 같은 엔드포인트면 지문 동일해야 함
const d2 = parseError(DELAY.replace('eb7ddda0ffd43bae614d927845d24850', 'ffff1111aaaa2222bbbb3333cccc4444').replace('8898', '7201'), 'C0TEST');
console.log('다른 id/시간 → 지문 동일?', d.fingerprint === d2.fingerprint ? 'OK ✅' : 'FAIL ❌');
