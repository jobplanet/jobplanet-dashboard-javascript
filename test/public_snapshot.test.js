const test = require('node:test');
const assert = require('node:assert');
const { buildSnapshot, buildFeedQuery } = require('../lib/public_snapshot');

function row(over = {}) {
  return {
    review_type: 'general_review',
    company_name: '테스트기업',
    city_name: '서울특별시',
    industry: 'IT/웹/통신',
    company_lat: 37.5, company_lng: 127.0,
    company_city: '서울특별시',
    rating: 4,
    review_title: '한줄평 원문',
    age_bucket: '25-29세',
    career_bucket: '1~2년',
    base_date: { value: '2026-11-09' },
    // 아래는 쿼리가 내보내지 않지만, 혹시 섞여 들어와도 밖으로 나가면 안 되는 값
    user_age: 27, experience_year: 2, approved_ts: '2026-11-09T01:02:03Z', review_id: 123, user_id: 9,
    ...over,
  };
}

const OFF = { showReviewText: false, showTopViewed: false };
const FORBIDDEN_KEYS = ['user_age', 'experience_year', 'approved_ts', 'review_id', 'user_id', 'age_bucket', 'career_bucket', 'city_name', 'pv_cnt', 'uv_cnt'];

function allKeys(obj, out = new Set()) {
  if (Array.isArray(obj)) obj.forEach(v => allKeys(v, out));
  else if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj)) { out.add(k); allKeys(v, out); }
  return out;
}

test('작성자 단위 속성과 시각·ID는 스냅샷 어디에도 없다', () => {
  const snap = buildSnapshot([row(), row({ review_type: 'salary_review' })], [], OFF);
  const keys = allKeys(snap);
  for (const k of FORBIDDEN_KEYS) assert.ok(!keys.has(k), `${k} 가 스냅샷에 있다`);
});

test('카드에는 연령·연차 구간도 붙지 않는다 (집계로만 나간다)', () => {
  const snap = buildSnapshot([row()], [], OFF);
  assert.deepStrictEqual(Object.keys(snap.cards[0]).sort(), ['company', 'industry', 'lat', 'lng', 'rating', 'regionHint', 'type']);
});

test('한줄평은 기본으로 빠지고, 켜면 들어간다', () => {
  const off = buildSnapshot([row()], [], OFF);
  assert.ok(!JSON.stringify(off).includes('한줄평 원문'));
  const on = buildSnapshot([row()], [], { ...OFF, showReviewText: true });
  assert.strictEqual(on.cards[0].title, '한줄평 원문');
});

test('한줄평이 꺼져 있으면 쿼리도 원문 컬럼을 읽지 않는다', () => {
  const q = buildFeedQuery({ showReviewText: false });
  assert.ok(!q.includes('company_one_line_review'));
  // 최종 SELECT 는 나이·연차 원값을 내보내지 않는다 (구간만)
  const finalSelect = q.slice(q.lastIndexOf('SELECT\n    review_type'));
  assert.ok(finalSelect.includes('age_bucket'));
  assert.ok(!/\buser_age\s+AS|,\s*user_age\s*,|\bexperience_year\s*,/.test(finalSelect.replace(/CASE[\s\S]*?END/g, '')));
  assert.ok(buildFeedQuery({ showReviewText: true }).includes('company_one_line_review'));
});

test('조회 순위는 기본으로 빠지고, 켜면 순위·기업명만 들어간다', () => {
  const top = [{ rank: 1, company_name: 'A', pv_cnt: 999 }, { rank: 2, company_name: null }];
  assert.ok(!('topViewed' in buildSnapshot([row()], top, OFF)));
  const on = buildSnapshot([row()], top, { ...OFF, showTopViewed: true });
  assert.deepStrictEqual(on.topViewed, [{ rank: 1, company: 'A' }]);
});

test('빈 값을 지어내지 않는다: 연령·연차 미상은 어느 구간에도 세지 않는다', () => {
  const snap = buildSnapshot([row({ age_bucket: null, career_bucket: null }), row()], [], OFF);
  assert.strictEqual(snap.ageGroups.reduce((s, g) => s + g.count, 0), 1);
  assert.strictEqual(snap.careerGroups.reduce((s, g) => s + g.count, 0), 1);
  assert.strictEqual(snap.summary.reviewCount, 2);
});

test('표본이 10건 미만인 구간은 평균 평점을 내보내지 않는다', () => {
  const rows = Array.from({ length: 9 }, () => row());
  const g = buildSnapshot(rows, [], OFF).ageGroups.find(x => x.label === '25-29세');
  assert.strictEqual(g.count, 9);
  assert.strictEqual(g.avgRating, null);
  const g10 = buildSnapshot(rows.concat(row()), [], OFF).ageGroups.find(x => x.label === '25-29세');
  assert.strictEqual(g10.avgRating, 4);
});

test('평점 없는 유형(연봉·프리미엄)은 평점 집계에서 빠진다', () => {
  const snap = buildSnapshot([row({ review_type: 'salary_review', rating: 5 }), row({ rating: 2 })], [], OFF);
  assert.strictEqual(snap.summary.ratedCount, 1);
  assert.deepStrictEqual(snap.summary.ratingDist, { 1: 0, 2: 1, 3: 0, 4: 0, 5: 0 });
  assert.strictEqual(snap.cards.find(c => c.type === 'salary_review').rating, null);
});

test('카드 순서는 섞인다 (승인 순서가 드러나지 않게)', () => {
  const rows = Array.from({ length: 20 }, (_, i) => row({ company_name: `C${i}` }));
  let seed = 1;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const names = buildSnapshot(rows, [], OFF, { random }).cards.map(c => c.company);
  assert.notDeepStrictEqual(names, rows.map(r => r.company_name));
  assert.deepStrictEqual(names.slice().sort(), rows.map(r => r.company_name).sort());
});

test('기준일은 BigQuery DATE 객체에서 문자열로 나온다', () => {
  assert.strictEqual(buildSnapshot([row()], [], OFF).baseDate, '2026-11-09');
  assert.strictEqual(buildSnapshot([], [], OFF).baseDate, null);
});
