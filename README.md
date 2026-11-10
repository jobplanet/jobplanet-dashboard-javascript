# Jobplanet Review Dashboard

Jobplanet 리뷰 현황을 보여주는 정적 대시보드 + Express API 서버입니다.

## 로컬 실행

Bun package manager를 설치합니다.

```bash
# macOS
curl -fsSL https://bun.sh/install | bash

# Windows
powershell -c "irm bun.sh/install.ps1 | iex"
```

의존성을 설치합니다.

```bash
bun install
```

로컬 BigQuery 인증은 레포 루트에 `service-account.json` 파일을 두는 방식이 가장 간단합니다.

```txt
jobplanet-dashboard-javascript/
  service-account.json
```

`service-account.json`은 git에 커밋하면 안 됩니다. 현재 `.gitignore`에 포함되어 있습니다.

service-account.json는 관리자에게 별도로 문의해주세요!
(관리자가 key를 갖고 있지 않다면, GCP > IAM > 서비스계정`dashboard-bigquery-readonly`를 찾아서 키 추가 > json을 추가하여 사용하면 됩니다.)

서버를 실행합니다.

```bash
bun start
```

브라우저에서 아래 주소로 접속합니다.

```txt
http://localhost:3333
```

API만 확인하려면:

```bash
curl http://localhost:3333/api/reviews
curl http://localhost:3333/api/mtd
curl http://localhost:3333/api/reviews/live
curl http://localhost:3333/api/pv
```

## 필요한 GCP 권한

BigQuery를 조회하는 서비스 계정에 아래 권한을 부여합니다.

```txt
jobplanet-korea-production 프로젝트:
- BigQuery Job User

dw_jp 데이터셋:
- BigQuery Data Viewer

cleaned_event 데이터셋:
- BigQuery Data Viewer

datalab_dis 데이터셋:
- BigQuery Data Viewer
```

## Vercel 환경변수

Vercel에는 `service-account.json` 파일을 올리지 않고, 환경변수로 서비스 계정 JSON 전체를 주입합니다.

```txt
GOOGLE_SERVICE_ACCOUNT_JSON
```

CLI로 등록하는 예시:

```bash
vercel login
vercel link
vercel env add GOOGLE_SERVICE_ACCOUNT_JSON production
vercel env add GOOGLE_SERVICE_ACCOUNT_JSON preview
```

프롬프트가 뜨면 `service-account.json`의 JSON 전체 내용을 붙여넣습니다.

## 빌드와 배포

이 프로젝트는 별도 번들링이 필요 없는 정적 HTML + Express API 구조입니다. Vercel에서는 `vercel.json`에 따라 아래 명령이 실행됩니다.

```bash
bun install
```

빌드 단계:

```bash
bun run build
```

Preview 배포:

```bash
vercel
```

Production 배포:

```bash
vercel --prod
```

## 외부 공개용 화면 (`/external/`)

잠재고객 등 외부에 보여주는 화면입니다. 사내 TV용 화면(`/`)과 API(`/api/*`)는 그대로 두고 IP 허용목록으로 막습니다.

- 하루 1회 Vercel Cron이 `/api/cron/public-snapshot`을 호출해 BigQuery를 조회하고, 외부에 보여줄 값만 담은 JSON을 Vercel Blob(private)에 저장합니다.
- 외부 화면은 `/external/snapshot.json`(저장된 JSON)만 읽습니다. 외부 방문자의 요청은 BigQuery에 닿지 않습니다.
- 스냅샷에 담기지 않는 것: 작성자 나이·연차 원값(BigQuery 안에서 구간으로 바꾼 뒤 집계로만 내보냄), 승인 시각, 리뷰 ID, 리뷰탭 PV/UV 수치, MTD·누적 리뷰 수. 값이 비어 있으면 지어내지 않습니다.
- 기본으로 꺼진 항목(T&S 확인 후 환경변수로 켬):

| 환경변수 | 켜면 |
|---|---|
| `PUBLIC_SHOW_REVIEW_TEXT=true` | 카드에 리뷰 한줄평 원문 표시 |
| `PUBLIC_SHOW_TOP_VIEWED=true` | "이달 많이 본 기업" 순위 표시 (기업명·순위만, 수치 없음) |

### Vercel 설정 (처음 한 번)

1. Storage › Blob 스토어를 **Private**로 만들고 이 프로젝트에 연결합니다. `BLOB_READ_WRITE_TOKEN`이 자동으로 들어갑니다.
2. 환경변수 `CRON_SECRET`에 임의의 긴 문자열을 넣습니다. Cron 경로는 IP 허용목록 밖이라 이 값으로 막습니다. 없으면 실행을 거부합니다.
3. 배포하면 `vercel.json`의 `crons`에 따라 매일 06:00 KST(21:00 UTC)에 스냅샷이 만들어집니다. 첫 스냅샷은 Vercel 대시보드 › Cron Jobs에서 수동으로 한 번 실행합니다.

### 로컬에서 보기

```bash
bun run snapshot   # BigQuery 조회 → .local/public-snapshot.json
bun start          # http://localhost:3333/external/
```

### 테스트

```bash
bun run test       # 스냅샷에 들어가면 안 되는 값이 없는지 검사
```
