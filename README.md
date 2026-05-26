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
