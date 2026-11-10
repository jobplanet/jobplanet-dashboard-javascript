// 외부 공개용 스냅샷을 지금 한 번 만든다.
// 로컬: .local/public-snapshot.json 에 저장 (BigQuery 인증 필요: README 참고)
// BLOB_READ_WRITE_TOKEN 이 있으면 Vercel Blob 에 저장한다.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { BigQuery } = require('@google-cloud/bigquery');
const { generatePublicSnapshot } = require('../lib/public_snapshot');
const { saveSnapshot } = require('../lib/snapshot_store');

const KEY_PATH = path.join(__dirname, '..', 'service-account.json');
const bqOptions = { projectId: 'jobplanet-korea-production' };
if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  bqOptions.credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
} else if (fs.existsSync(KEY_PATH)) {
  bqOptions.keyFilename = KEY_PATH;
}

generatePublicSnapshot(new BigQuery(bqOptions))
  .then(saveSnapshot)
  .then(saved => console.log(`saved to ${saved.store}: ${saved.pathname} (${saved.bytes} bytes)`))
  .catch(err => { console.error(err.message); process.exit(1); });
