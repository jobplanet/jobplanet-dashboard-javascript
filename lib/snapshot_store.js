// 외부 공개용 스냅샷 저장소.
// - Vercel: Vercel Blob(private)에 저장한다. BLOB_READ_WRITE_TOKEN 이 있으면 이쪽을 쓴다.
// - 로컬: .local/public-snapshot.json 파일을 쓴다.

const fs = require('fs');
const path = require('path');

const BLOB_PATHNAME = 'public-snapshot.json';
const LOCAL_PATH = path.join(__dirname, '..', '.local', 'public-snapshot.json');

function useBlob() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

async function saveSnapshot(snapshot) {
  const body = JSON.stringify(snapshot);
  if (useBlob()) {
    const { put } = require('@vercel/blob');
    await put(BLOB_PATHNAME, body, {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
    });
    return { store: 'blob', pathname: BLOB_PATHNAME, bytes: Buffer.byteLength(body) };
  }
  fs.mkdirSync(path.dirname(LOCAL_PATH), { recursive: true });
  fs.writeFileSync(LOCAL_PATH, body);
  return { store: 'local', pathname: LOCAL_PATH, bytes: Buffer.byteLength(body) };
}

// 저장된 스냅샷 JSON 문자열을 돌려준다. 없으면 null.
async function loadSnapshotText() {
  if (useBlob()) {
    const { get } = require('@vercel/blob');
    const result = await get(BLOB_PATHNAME, { access: 'private' });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    return new Response(result.stream).text();
  }
  if (!fs.existsSync(LOCAL_PATH)) return null;
  return fs.readFileSync(LOCAL_PATH, 'utf8');
}

module.exports = { saveSnapshot, loadSnapshotText, BLOB_PATHNAME, LOCAL_PATH };
