// 외부 공개용 스냅샷.
// 하루 1회 BigQuery를 조회해 외부 화면에 필요한 값만 담은 JSON을 만든다.
// 외부 방문자는 이 JSON만 읽고 BigQuery에는 닿지 않는다.
//
// 이 파일에 담기지 않는 것: 작성자 나이·연차 원값, 승인 시각, 리뷰 ID,
// 리뷰탭 PV/UV 수치, MTD·누적 리뷰 수.
// 기본으로 꺼진 것(T&S 확인 후 환경변수로 켬):
//   PUBLIC_SHOW_REVIEW_TEXT=true  리뷰 한줄평 원문
//   PUBLIC_SHOW_TOP_VIEWED=true   이달 리뷰탭 조회 순위(기업명·순위만, 수치 없음)

const SCHEMA_VERSION = 1;
const MIN_GROUP_FOR_AVG = 10; // 이보다 적은 집단은 평균 평점을 내보내지 않는다
const TOP_VIEWED_LIMIT = 10;

const AGE_BUCKETS = ['20-24세', '25-29세', '30-34세', '35-39세', '40-44세', '45세 이상'];
const CAREER_BUCKETS = ['신입', '1~2년', '4~7년', '8년 이상'];
const REVIEW_TYPES = ['general_review', 'interview_review', 'salary_review', 'benefit_review', 'premium_review'];
const UNRATED_TYPES = new Set(['premium_review', 'salary_review']);

function readOptions(env = process.env) {
  return {
    showReviewText: env.PUBLIC_SHOW_REVIEW_TEXT === 'true',
    showTopViewed: env.PUBLIC_SHOW_TOP_VIEWED === 'true',
  };
}

// 나이·연차는 BigQuery 안에서 구간으로 바꿔서 가져온다. 원값은 서버로도 오지 않는다.
function buildFeedQuery({ showReviewText }) {
  const titleColumn = showReviewText
    ? `COALESCE(
      NULLIF(TRIM(r.general_review_detail.company_one_line_review), ''),
      NULLIF(SUBSTR(TRIM(r.interview_review_detail.interview_process_summary), 1, 50), ''),
      r.benefit_review_detail.benefit_category.name,
      NULLIF(TRIM(r.salary_review_detail.salary_negotiation_experience_opinion), ''),
      NULLIF(TRIM(r.premium_review_detail.questions[SAFE_OFFSET(0)].answers[SAFE_OFFSET(0)].answer_text), '')
    )`
    : 'CAST(NULL AS STRING)';

  return `
  WITH last_active AS (
    SELECT MAX(active_date) AS active_date
    FROM (
      SELECT DATE(approved_ts, 'Asia/Seoul') AS active_date
      FROM \`jobplanet-korea-production.dw_jp.dim_reviews_upsert\`
      WHERE DATE(approved_ts, 'Asia/Seoul') >= DATE_SUB(CURRENT_DATE('Asia/Seoul'), INTERVAL 14 DAY)
        AND DATE(approved_ts, 'Asia/Seoul') <  CURRENT_DATE('Asia/Seoul')
        AND review_status.en_name = 'Approved'
        AND approved_ts IS NOT NULL
        AND EXTRACT(DAYOFWEEK FROM DATE(approved_ts, 'Asia/Seoul')) NOT IN (1, 7)
      GROUP BY 1
      HAVING COUNT(*) >= 1000
    )
  ),
  valid_resume AS (
    SELECT DISTINCT user_id
    FROM \`jobplanet-korea-production.dw_jp.dim_resumes_snapshot\`
    WHERE partition_date >= DATE_SUB(CURRENT_DATE('Asia/Seoul'), INTERVAL 14 DAY)
      AND partition_date <  CURRENT_DATE('Asia/Seoul')
      AND is_main = TRUE AND is_anomaly = FALSE AND status = 2
      AND user_id IS NOT NULL
  ),
  base AS (
    SELECT
      r.review_type,
      r.company.name                    AS company_name,
      r.city.level1_name                AS city_name,
      co.industry_level1.name           AS industry,
      CAST(co.geocoding.lat AS FLOAT64) AS company_lat,
      CAST(co.geocoding.lng AS FLOAT64) AS company_lng,
      co.headquarter_city.name          AS company_city,
      COALESCE(
        r.general_review_detail.overall_rating,
        r.interview_review_detail.overall_rating,
        r.benefit_review_detail.average_rating
      )                                 AS rating,
      ${titleColumn}                    AS review_title,
      CASE WHEN vr.user_id IS NOT NULL THEN r.experience_year END AS experience_year,
      DATE_DIFF(CURRENT_DATE('Asia/Seoul'), u.birth_date, YEAR) AS user_age
    FROM \`jobplanet-korea-production.dw_jp.dim_reviews_upsert\` r
    LEFT JOIN \`jobplanet-korea-production.dw_jp.dim_companies_upsert\` co
      ON r.company.id = co.company_id
    LEFT JOIN valid_resume vr ON r.user_id = vr.user_id
    LEFT JOIN \`jobplanet-korea-production.dw_jp.dim_users\` u ON r.user_id = u.user_id
    WHERE DATE(r.approved_ts, 'Asia/Seoul') = (SELECT active_date FROM last_active)
      AND r.review_status.en_name = 'Approved'
      AND r.approved_ts IS NOT NULL
  )
  SELECT
    review_type, company_name, city_name, industry,
    company_lat, company_lng, company_city, rating, review_title,
    CASE
      WHEN user_age IS NULL OR user_age < 18 THEN NULL
      WHEN user_age <= 24 THEN '20-24세'
      WHEN user_age <= 29 THEN '25-29세'
      WHEN user_age <= 34 THEN '30-34세'
      WHEN user_age <= 39 THEN '35-39세'
      WHEN user_age <= 44 THEN '40-44세'
      ELSE '45세 이상'
    END AS age_bucket,
    CASE
      WHEN experience_year IS NULL THEN NULL
      WHEN experience_year <= 0 THEN '신입'
      WHEN experience_year <= 2 THEN '1~2년'
      WHEN experience_year <= 7 THEN '4~7년'
      ELSE '8년 이상'
    END AS career_bucket,
    (SELECT active_date FROM last_active) AS base_date
  FROM base
`;
}

// 이달 리뷰탭 조회 순위. 기업명과 순위만 가져온다(PV/UV 수치는 가져오지 않음).
const TOP_VIEWED_QUERY = `
  WITH top_companies AS (
    SELECT event_property.company_id AS company_id, COUNT(*) AS pv_cnt
    FROM \`jobplanet-korea-production.cleaned_event.amplitude_events\`
    WHERE DATE(event_time, 'Asia/Seoul') >= DATE_TRUNC(CURRENT_DATE('Asia/Seoul'), MONTH)
      AND DATE(event_time, 'Asia/Seoul') <  CURRENT_DATE('Asia/Seoul')
      AND event_type = 'view_companies_reviews'
      AND user_property.is_internal IS FALSE
      AND is_marketing_event IS FALSE
      AND is_experiment_event IS FALSE
      AND event_property.company_id IS NOT NULL
    GROUP BY 1
    ORDER BY pv_cnt DESC
    LIMIT ${TOP_VIEWED_LIMIT}
  ),
  company_info AS (
    SELECT DISTINCT
      target_company_id,
      FIRST_VALUE(company_name) OVER w AS company_name
    FROM \`jobplanet-korea-production.datalab_dis.review_consume_analysis\`
    WHERE target_company_id IN (SELECT company_id FROM top_companies)
    WINDOW w AS (PARTITION BY target_company_id ORDER BY event_date DESC)
  )
  SELECT
    ROW_NUMBER() OVER (ORDER BY t.pv_cnt DESC) AS rank,
    c.company_name
  FROM top_companies t
  LEFT JOIN company_info c ON t.company_id = c.target_company_id
  ORDER BY rank
`;

function toNumberOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function dateValue(v) {
  if (v == null) return null;
  return typeof v === 'object' && 'value' in v ? v.value : String(v);
}

function shuffle(arr, random = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function groupStats(rows, key, labels) {
  const acc = Object.fromEntries(labels.map(l => [l, { count: 0, ratingSum: 0, ratingCount: 0 }]));
  for (const r of rows) {
    const g = acc[r[key]];
    if (!g) continue;
    g.count++;
    if (r._rating != null) { g.ratingSum += r._rating; g.ratingCount++; }
  }
  return labels.map(label => {
    const g = acc[label];
    return {
      label,
      count: g.count,
      avgRating: g.ratingCount >= MIN_GROUP_FOR_AVG ? Math.round((g.ratingSum / g.ratingCount) * 100) / 100 : null,
    };
  });
}

// BigQuery 결과 행 → 외부 공개 JSON. 여기서 만든 객체만 밖으로 나간다.
function buildSnapshot(feedRows, topViewedRows, options, { now = new Date(), random = Math.random } = {}) {
  const rows = feedRows.map(r => {
    const type = REVIEW_TYPES.includes(r.review_type) ? r.review_type : null;
    const raw = toNumberOrNull(r.rating);
    const rating = type && !UNRATED_TYPES.has(type) && raw != null
      ? Math.round(Math.max(1, Math.min(5, raw)))
      : null;
    return { ...r, _type: type, _rating: rating };
  });

  const ratingDist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const typeCounts = Object.fromEntries(REVIEW_TYPES.map(t => [t, 0]));
  let ratingSum = 0;
  let ratedCount = 0;
  for (const r of rows) {
    if (r._type) typeCounts[r._type]++;
    if (r._rating != null) { ratingDist[r._rating]++; ratingSum += r._rating; ratedCount++; }
  }

  const cards = shuffle(rows, random).map(r => {
    const card = {
      type: r._type,
      company: r.company_name || null,
      industry: r.industry || null,
      lat: toNumberOrNull(r.company_lat),
      lng: toNumberOrNull(r.company_lng),
      regionHint: r.company_city || r.city_name || null,
      rating: r._rating,
    };
    if (options.showReviewText) card.title = r.review_title || null;
    return card;
  });

  const snapshot = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    baseDate: rows.length > 0 ? dateValue(rows[0].base_date) : null,
    summary: {
      reviewCount: rows.length,
      ratedCount,
      avgRating: ratedCount > 0 ? Math.round((ratingSum / ratedCount) * 100) / 100 : null,
      ratingDist,
      typeCounts,
    },
    ageGroups: groupStats(rows, 'age_bucket', AGE_BUCKETS),
    careerGroups: groupStats(rows, 'career_bucket', CAREER_BUCKETS),
    cards,
  };

  if (options.showTopViewed) {
    snapshot.topViewed = (topViewedRows || [])
      .filter(r => r.company_name)
      .map(r => ({ rank: Number(r.rank), company: r.company_name }));
  }

  return snapshot;
}

async function generatePublicSnapshot(bq, options = readOptions()) {
  const jobs = [bq.query({ query: buildFeedQuery(options), location: 'asia-northeast3' })];
  if (options.showTopViewed) {
    jobs.push(bq.query({ query: TOP_VIEWED_QUERY, location: 'asia-northeast1' }));
  }
  const [[feedRows], topResult] = await Promise.all(jobs);
  return buildSnapshot(feedRows, topResult ? topResult[0] : [], options);
}

module.exports = {
  buildFeedQuery,
  buildSnapshot,
  generatePublicSnapshot,
  readOptions,
  TOP_VIEWED_QUERY,
  AGE_BUCKETS,
  CAREER_BUCKETS,
};
