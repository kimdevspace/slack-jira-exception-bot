# Exception → Jira 자동등록 봇 (slack-jira-bot)

Slack 모니터링 채널에 올라온 런타임 예외 메시지에 **🎫(`:ticket:`) 이모지**를 달면,
스택트레이스를 파싱해 **Jira에 이슈를 자동 생성**합니다.
같은 예외가 또 발생하면 **새 티켓 대신 기존 티켓에 "재발생" 코멘트**를 누적합니다(스택트레이스 지문 기반 중복제거).

> Socket Mode 라 공인 URL 없이 PC/사내서버 어디서든 구동됩니다.

## 동작 흐름

```
[모니터링 채널 예외 메시지] ──🎫 반응──▶ 봇
   1. 원본 메시지 텍스트 가져오기 (rich_text/attachments 포함)
   2. 예외타입 + 최상단 앱 패키지 스택프레임 → SHA 지문
   3. Jira 라벨 autoexc-<지문> 으로 기존 이슈 검색
        ├─ 있으면 → 기존 티켓에 재발생 코멘트 + occur-N 라벨 증가
        └─ 없으면 → 신규 이슈 생성 (보고자·담당자 = 이모지 단 사람)
   4. 원본 스레드에 "→ PROJ-1234 등록 완료" 답글 + ✅ 반응
```

- **제목**: `[{서비스} {TITLE_LABEL}] {예외타입} ({클래스}.{메서드})` — 서비스는 메시지 host 키워드로 자동 판별(미상이면 생략)
- **본문**: 발생현황 + 요청정보 + 스택트레이스 원문 + 슬랙 원본 링크 + (조사 후 채울) `원인/수정 내용/효과` 빈 골격
- **상태는 Jira 라벨에만 저장** → 별도 DB 없음, 봇 재시작/이전 자유로움

## 명의(누구 티켓으로 등록되나)

봇은 **운영자 개인 토큰 1개**로 Jira에 접속하지만, **이모지를 단 사람**을 식별해
그 사람을 **보고자(Reporter)·담당자(Assignee)** 로 지정합니다. 사용자는 이모지만 달면 됩니다.

- Slack `users:read.email` 로 반응한 사람 이메일 → Jira accountId 변환
- 이메일로 Jira 계정을 못 찾으면 운영자 본인(`JIRA_ASSIGNEE_EMAIL`)으로 폴백 + 스레드에 경고
- **Creator(작성자)** 칸만 토큰 주인으로 고정됨 (Atlassian Cloud 사양상 불변)
- ⚠️ 보고자를 "이모지 단 사람"으로 지정하려면 토큰 주인에게 **"보고자 수정(Modify Reporter)" 권한**이
  필요합니다. 없으면 보고자 지정이 자동 생략(담당자만)되고 스레드에 경고가 뜹니다.

## 1. 설치

```bash
cd slack-jira-bot
npm install
cp .env.example .env                       # 토큰/설정 채우기
cp services.example.json services.local.json   # host키워드→서비스명 매핑 채우기(선택)
```

## 2. Slack 앱 만들기 (Socket Mode)

1. https://api.slack.com/apps → **Create New App → From a manifest**
2. 워크스페이스 선택 후 `manifest.json`(또는 `manifest.yml`) 내용 붙여넣기 → 생성
3. **Basic Information → App-Level Tokens → Generate Token**
   - scope `connections:write` 추가 → 생성된 `xapp-...` → `.env` 의 `SLACK_APP_TOKEN`
4. **OAuth & Permissions → Install to Workspace** (관리자 승인 필요할 수 있음)
   - 발급된 `xoxb-...` → `.env` 의 `SLACK_BOT_TOKEN`
5. **모니터링 채널에 봇 초대**: 채널에서 `/invite @monitoring-bot`
   - `conversations.history` 로 메시지를 읽으려면 봇이 채널 멤버여야 합니다.

> 🎫 이모지 이름은 `ticket` 입니다. 다른 이모지를 쓰려면 `.env` 의 `TRIGGER_EMOJI` 변경.

## 3. Jira API 토큰

1. https://id.atlassian.com/manage-profile/security/api-tokens → **Create API token**
2. 토큰 → `.env` 의 `JIRA_API_TOKEN`, 본인 이메일 → `JIRA_EMAIL`
3. `.env` 의 `JIRA_BASE_URL`, `JIRA_PROJECT_KEY`, `JIRA_ISSUE_TYPE_ID`, `JIRA_ASSIGNEE_EMAIL` 확인
   - 프로젝트/이슈타입 id 는 본인 Jira 환경 값으로 채웁니다.

## 4. 파서 동작 확인 (토큰 없이 가능)

```bash
npm run test:parse
```

예외 샘플로 서비스판별 · 제목 · 지문 · 재발생 동일성을 검증합니다.

## 5. 실행

```bash
npm start
```

`⚡️ Slack→Jira 예외봇 가동...` 이 뜨면 정상. 모니터링 채널의 예외 메시지에 🎫 를 달아 테스트하세요.

## 6. 상시 구동 (Windows)

### 방법 A) pm2 (권장)

```bash
npm i -g pm2 pm2-windows-startup
pm2 start src/index.js --name slack-jira-bot
pm2 save
pm2-startup install      # 부팅 시 자동 시작
```

로그 확인: `pm2 logs slack-jira-bot` / 재시작: `pm2 restart slack-jira-bot`

### 방법 B) NSSM (Windows 서비스로 등록)

```powershell
# https://nssm.cc 에서 nssm.exe 받은 뒤 (경로는 본인 환경에 맞게)
nssm install SlackJiraBot "C:\Program Files\nodejs\node.exe" "<프로젝트경로>\src\index.js"
nssm set SlackJiraBot AppDirectory "<프로젝트경로>"
nssm start SlackJiraBot
```

## 설정 요약 (.env)

| 변수 | 설명 |
|------|------|
| `SLACK_BOT_TOKEN` | `xoxb-...` 봇 토큰 |
| `SLACK_APP_TOKEN` | `xapp-...` Socket Mode 토큰 |
| `TRIGGER_EMOJI` | 트리거 이모지 (기본 `ticket`) |
| `ALLOWED_CHANNELS` | 처리할 채널 ID (쉼표, 비우면 전체) |
| `JIRA_*` | Jira 접속/프로젝트/담당자 |
| `APP_PACKAGE_PREFIX` | 스택트레이스에서 내 앱 프레임 식별용 패키지 prefix (예: `com.mycompany`) |
| `TITLE_LABEL` | 제목 라벨 (`[{서비스} {TITLE_LABEL}]`) |
| `APPEND_RESOLUTION_SKELETON` | 본문에 원인/수정/효과 빈 골격 추가 (기본 true) |

서비스 매핑(host키워드 → 표시명)은 `services.local.json` 에 둡니다(없으면 `services.example.json` 사용).

## 트러블슈팅

- **`question` 반응 + "예외 인식 못함"**: 메시지에서 스택트레이스를 못 찾음. 알림 포맷이 바뀌었는지,
  `APP_PACKAGE_PREFIX` 가 실제 앱 패키지와 맞는지 확인. 로그에 추출 텍스트/블록타입이 찍힘.
- **`not_in_channel`**: 봇을 채널에 초대하지 않음.
- **Jira 401/403**: API 토큰/이메일 또는 프로젝트 생성 권한 확인.
- **지문이 매번 달라 중복 티켓**: 핫픽스로 라인번호가 바뀌면 신규로 취급됩니다(의도된 동작).
  클래스/메서드만으로 묶고 싶으면 `parser.js` 의 `fingerprintBase` 에서 `:line` 을 제거하세요.
