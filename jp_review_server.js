const express = require('express');
require('dotenv').config({ quiet: true });
const { BigQuery } = require('@google-cloud/bigquery');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3333;
const HTML_PATH = path.join(__dirname, 'public');

const ALLOWED_IPV4_CIDRS = [
  '101.2.200.18/32',
  '101.2.200.50/32',
  '121.156.104.151/32',
  '121.156.104.155/32',
  '211.60.110.192/32',
  '211.60.110.192/29',
  // Do not add 211.60.110.192/0: /0 would allow every IPv4 address.
  '211.60.110.193/32',
  '211.60.110.194/32',
  '211.60.110.195/32',
  '211.60.110.196/32',
  '211.60.110.197/32',
  '211.60.110.198/32',
];

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;

  return parts.reduce((acc, part) => {
    if (!/^\d+$/.test(part)) return null;
    const value = Number(part);
    if (value < 0 || value > 255) return null;
    return ((acc << 8) | value) >>> 0;
  }, 0);
}

function isIpInCidr(ip, cidr) {
  const [range, prefixText = '32'] = cidr.split('/');
  const ipInt = ipv4ToInt(ip);
  const rangeInt = ipv4ToInt(range);
  const prefix = Number(prefixText);

  if (ipInt === null || rangeInt === null || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

function getClientIp(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  const firstForwardedIp = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  return (firstForwardedIp || req.ip || req.socket.remoteAddress || '').split(',')[0].trim();
}

function isAllowedClientIp(ip) {
  if (!ip || ip.includes(':')) return false;
  return ALLOWED_IPV4_CIDRS.some(cidr => isIpInCidr(ip, cidr));
}

const KEY_PATH = path.join(__dirname, 'service-account.json');
const bqOptions = { projectId: 'jobplanet-korea-production' };
if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  bqOptions.credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
} else if (fs.existsSync(KEY_PATH)) {
  bqOptions.keyFilename = KEY_PATH;
}
const bq = new BigQuery(bqOptions);

app.use((req, res, next) => {
  const shouldEnforceIpAllowlist = process.env.VERCEL === '1' || process.env.IP_ALLOWLIST_ENFORCE === 'true';
  if (!shouldEnforceIpAllowlist) {
    next();
    return;
  }

  const clientIp = getClientIp(req);
  if (isAllowedClientIp(clientIp)) {
    next();
    return;
  }

  console.warn(`[IP_BLOCK] ${req.method} ${req.url} ip=${clientIp || 'unknown'}`);
  res.status(403).send('Forbidden');
});

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.use(express.static(HTML_PATH));

app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.url}`);
  next();
});

// ① 통계용: 일별 승인 건수 30일
const STATS_QUERY = `
  SELECT
    DATE_SUB(partition_date, INTERVAL 1 DAY)   AS approved_date,
    COUNTIF(review_type = 'general_review')     AS general_review_cnt,
    COUNTIF(review_type = 'premium_review')     AS premium_review_cnt,
    COUNTIF(review_type = 'benefit_review')     AS benefit_review_cnt,
    COUNTIF(review_type = 'interview_review')   AS interview_review_cnt,
    COUNTIF(review_type = 'salary_review')      AS salary_review_cnt,
    COUNT(review_id)                            AS total_cnt
  FROM \`jobplanet-korea-production.dw_jp.dim_reviews_snapshot\`
  WHERE partition_date BETWEEN DATE_SUB(CURRENT_DATE('Asia/Seoul'), INTERVAL 31 DAY)
    AND CURRENT_DATE('Asia/Seoul')
    AND DATE(approved_ts, 'Asia/Seoul') = DATE_SUB(partition_date, INTERVAL 1 DAY)
    AND review_status.en_name = 'Approved'
    AND approved_ts IS NOT NULL
  GROUP BY 1
  ORDER BY 1
`;

// ② 피드용: 최근 승인일 기준 리뷰 (월요일/연휴엔 직전 영업일 자동 탐색)
const FEED_QUERY = `
  WITH last_active AS (
    SELECT MAX(active_date) AS active_date
    FROM (
      SELECT
        DATE(approved_ts, 'Asia/Seoul') AS active_date,
        COUNT(*) AS cnt
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
  )
  SELECT
    r.review_type,
    FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', r.approved_ts) AS approved_ts,
    r.company.name                                          AS company_name,
    r.city.level1_name                                      AS city_name,
    r.occupation.level1_name                                AS occupation,
    CASE WHEN vr.user_id IS NOT NULL THEN r.experience_year ELSE NULL END AS experience_year,
    co.industry_level1.name                                 AS industry,
    co.nice_company_type.ko_name                            AS company_size,
    CAST(co.geocoding.lat AS FLOAT64)                       AS company_lat,
    CAST(co.geocoding.lng AS FLOAT64)                       AS company_lng,
    co.headquarter_city.name                                AS company_city,
    COALESCE(
      r.general_review_detail.overall_rating,
      r.interview_review_detail.overall_rating,
      r.benefit_review_detail.average_rating
    )                                                       AS rating,
    COALESCE(
      NULLIF(TRIM(r.general_review_detail.company_one_line_review), ''),
      NULLIF(SUBSTR(TRIM(r.interview_review_detail.interview_process_summary), 1, 50), ''),
      r.benefit_review_detail.benefit_category.name,
      NULLIF(TRIM(r.salary_review_detail.salary_negotiation_experience_opinion), ''),
      NULLIF(TRIM(r.premium_review_detail.questions[SAFE_OFFSET(0)].answers[SAFE_OFFSET(0)].answer_text), '')
    )                                                       AS review_title,
    (SELECT active_date FROM last_active)                   AS feed_date,
    DATE_DIFF(CURRENT_DATE('Asia/Seoul'), u.birth_date, YEAR) AS user_age
  FROM \`jobplanet-korea-production.dw_jp.dim_reviews_upsert\` r
  LEFT JOIN \`jobplanet-korea-production.dw_jp.dim_companies_upsert\` co
    ON r.company.id = co.company_id
  LEFT JOIN valid_resume vr ON r.user_id = vr.user_id
  LEFT JOIN \`jobplanet-korea-production.dw_jp.dim_users\` u ON r.user_id = u.user_id
  WHERE DATE(r.approved_ts, 'Asia/Seoul') = (SELECT active_date FROM last_active)
    AND r.review_status.en_name = 'Approved'
    AND r.approved_ts IS NOT NULL
  ORDER BY r.approved_ts ASC
`;

// ③ 5분 폴링용: dim_reviews_upsert에서 최근 10분 승인 리뷰
const LIVE_QUERY = `
  SELECT
    r.review_type,
    r.review_id,
    FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', r.approved_ts) AS approved_ts,
    r.company.name                                          AS company_name,
    r.city.level1_name                                      AS city_name,
    r.occupation.level1_name                                AS occupation,
    r.experience_year                                       AS experience_year,
    CAST(co.geocoding.lat AS FLOAT64)                       AS company_lat,
    CAST(co.geocoding.lng AS FLOAT64)                       AS company_lng,
    co.headquarter_city.name                                AS company_city,
    COALESCE(
      r.general_review_detail.overall_rating,
      r.interview_review_detail.overall_rating,
      r.benefit_review_detail.average_rating
    )                                                       AS rating,
    COALESCE(
      NULLIF(TRIM(r.general_review_detail.company_one_line_review), ''),
      NULLIF(SUBSTR(TRIM(r.interview_review_detail.interview_process_summary), 1, 50), ''),
      r.benefit_review_detail.benefit_category.name,
      NULLIF(TRIM(r.salary_review_detail.salary_negotiation_experience_opinion), ''),
      NULLIF(TRIM(r.premium_review_detail.questions[SAFE_OFFSET(0)].answers[SAFE_OFFSET(0)].answer_text), '')
    )                                                       AS review_title
  FROM \`jobplanet-korea-production.dw_jp.dim_reviews_upsert\` r
  LEFT JOIN \`jobplanet-korea-production.dw_jp.dim_companies_upsert\` co
    ON r.company.id = co.company_id
  WHERE r.approved_ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 10 MINUTE)
    AND r.review_status.en_name = 'Approved'
    AND r.approved_ts IS NOT NULL
  ORDER BY r.approved_ts ASC
  LIMIT 50
`;

// ④ 전체 누적 승인 리뷰 수
const TOTAL_COUNT_QUERY = `
  SELECT COUNT(*) AS total_approved
  FROM \`jobplanet-korea-production.dw_jp.dim_reviews_upsert\`
  WHERE review_status.en_name = 'Approved'
    AND approved_ts IS NOT NULL
`;

// ⑤ MTD 쿼리: 이번달 + 전월 동기 (승인 건수 + 평균 평점)
const MTD_QUERY = `
  WITH base AS (
    SELECT
      DATE_SUB(partition_date, INTERVAL 1 DAY) AS approved_date,
      review_id,
      COALESCE(
        general_review_detail.overall_rating,
        interview_review_detail.overall_rating,
        benefit_review_detail.average_rating
      ) AS rating
    FROM \`jobplanet-korea-production.dw_jp.dim_reviews_snapshot\`
    WHERE partition_date BETWEEN
      DATE_ADD(DATE_TRUNC(DATE_SUB(CURRENT_DATE('Asia/Seoul'), INTERVAL 1 MONTH), MONTH), INTERVAL 1 DAY)
      AND DATE_SUB(CURRENT_DATE('Asia/Seoul'), INTERVAL 1 DAY)
    AND DATE(approved_ts, 'Asia/Seoul') = DATE_SUB(partition_date, INTERVAL 1 DAY)
    AND review_status.en_name = 'Approved'
    AND approved_ts IS NOT NULL
  )
  SELECT
    FORMAT_DATE('%Y-%m', DATE_TRUNC(approved_date, MONTH)) AS ym,
    COUNT(*)                                                AS approved_cnt,
    ROUND(AVG(rating), 2)                                   AS avg_rating
  FROM base
  WHERE
    DATE_TRUNC(approved_date, MONTH) = DATE_TRUNC(CURRENT_DATE('Asia/Seoul'), MONTH)
    OR (
      DATE_TRUNC(approved_date, MONTH) = DATE_TRUNC(DATE_SUB(CURRENT_DATE('Asia/Seoul'), INTERVAL 1 MONTH), MONTH)
      AND EXTRACT(DAY FROM approved_date) < EXTRACT(DAY FROM CURRENT_DATE('Asia/Seoul'))
    )
  GROUP BY 1
  ORDER BY 1
`;

// ⑤ 이달의 기업 TOP 50 — MTD 리뷰탭PV 순위 + 어제 대비 up/down (asia-northeast1)
const TOP50_QUERY = `
  WITH mtd_pv AS (
    SELECT
      event_property.company_id AS company_id,
      COUNT(*)                  AS pv_cnt,
      COUNT(DISTINCT user_id)   AS uv_cnt
    FROM \`jobplanet-korea-production.cleaned_event.amplitude_events\`
    WHERE DATE(event_time, 'Asia/Seoul') >= DATE_TRUNC(CURRENT_DATE('Asia/Seoul'), MONTH)
      AND DATE(event_time, 'Asia/Seoul') <  CURRENT_DATE('Asia/Seoul')
      AND event_type = 'view_companies_reviews'
      AND user_property.is_internal IS FALSE
      AND is_marketing_event IS FALSE
      AND is_experiment_event IS FALSE
      AND event_property.company_id IS NOT NULL
    GROUP BY 1
  ),
  yesterday_pv AS (
    SELECT
      event_property.company_id AS company_id,
      COUNT(*)                  AS pv_cnt
    FROM \`jobplanet-korea-production.cleaned_event.amplitude_events\`
    WHERE DATE(event_time, 'Asia/Seoul') >= DATE_TRUNC(CURRENT_DATE('Asia/Seoul'), MONTH)
      AND DATE(event_time, 'Asia/Seoul') <  DATE_SUB(CURRENT_DATE('Asia/Seoul'), INTERVAL 1 DAY)
      AND event_type = 'view_companies_reviews'
      AND user_property.is_internal IS FALSE
      AND is_marketing_event IS FALSE
      AND is_experiment_event IS FALSE
      AND event_property.company_id IS NOT NULL
    GROUP BY 1
  ),
  ranked_today AS (
    SELECT company_id, pv_cnt, uv_cnt,
      ROW_NUMBER() OVER (ORDER BY pv_cnt DESC) AS rank_today
    FROM mtd_pv
  ),
  ranked_yesterday AS (
    SELECT company_id,
      ROW_NUMBER() OVER (ORDER BY pv_cnt DESC) AS rank_yesterday
    FROM yesterday_pv
  ),
  company_info AS (
    SELECT DISTINCT
      target_company_id,
      FIRST_VALUE(company_name)         OVER w AS company_name,
      FIRST_VALUE(company_type_name)    OVER w AS company_type_name,
      FIRST_VALUE(industry_level1_name) OVER w AS industry_level1_name,
      FIRST_VALUE(review_cnt)           OVER w AS review_cnt,
      FIRST_VALUE(total_score)          OVER w AS total_score
    FROM \`jobplanet-korea-production.datalab_dis.review_consume_analysis\`
    WHERE target_company_id IN (SELECT company_id FROM ranked_today WHERE rank_today <= 50)
    WINDOW w AS (PARTITION BY target_company_id ORDER BY event_date DESC)
  )
  SELECT
    rt.rank_today                                                      AS rank,
    rt.company_id,
    ci.company_name,
    ci.company_type_name,
    ci.industry_level1_name,
    rt.pv_cnt,
    rt.uv_cnt,
    ci.review_cnt,
    ROUND(ci.total_score, 2)                                           AS avg_score,
    ry.rank_yesterday,
    CAST(ry.rank_yesterday AS INT64) - CAST(rt.rank_today AS INT64)   AS rank_change
  FROM ranked_today rt
  LEFT JOIN ranked_yesterday ry ON rt.company_id = ry.company_id
  LEFT JOIN company_info ci     ON rt.company_id = ci.target_company_id
  WHERE rt.rank_today <= 50
  ORDER BY rt.rank_today
`;

// ⑥ 기업 리뷰탭 PV TOP 50 (이달, asia-northeast1)
const PV_QUERY = `
  WITH top_companies AS (
    SELECT
      event_property.company_id AS company_id,
      COUNT(*)                  AS pv_cnt,
      COUNT(DISTINCT user_id)   AS uv_cnt
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
    LIMIT 50
  ),
  company_info AS (
    SELECT DISTINCT
      target_company_id,
      FIRST_VALUE(company_name)         OVER w AS company_name,
      FIRST_VALUE(company_type_name)    OVER w AS company_type_name,
      FIRST_VALUE(industry_level1_name) OVER w AS industry_level1_name,
      FIRST_VALUE(review_cnt)           OVER w AS review_cnt,
      FIRST_VALUE(total_score)          OVER w AS total_score
    FROM \`jobplanet-korea-production.datalab_dis.review_consume_analysis\`
    WHERE target_company_id IN (SELECT company_id FROM top_companies)
    WINDOW w AS (PARTITION BY target_company_id ORDER BY event_date DESC)
  )
  SELECT
    t.company_id,
    c.company_name,
    c.company_type_name,
    c.industry_level1_name,
    t.pv_cnt,
    t.uv_cnt,
    c.review_cnt,
    ROUND(c.total_score, 2) AS avg_score
  FROM top_companies t
  LEFT JOIN company_info c ON t.company_id = c.target_company_id
  ORDER BY t.pv_cnt DESC
`;

let cache = null;
let cacheAt = 0;
const CACHE_TTL = 10 * 60 * 1000;

let liveCache = null;
let liveCacheAt = 0;
const LIVE_CACHE_TTL = 5 * 60 * 1000;

let mtdCache = null;
let mtdCacheAt = 0;
const MTD_CACHE_TTL = 60 * 60 * 1000; // 1시간

let pvCache = null;
let pvCacheAt = 0;
const PV_CACHE_TTL = 60 * 60 * 1000; // 1시간

app.get('/api/reviews', async (req, res) => {
  try {
    if (cache && Date.now() - cacheAt < CACHE_TTL) {
      return res.json(cache);
    }

    console.log('[BQ] querying stats + feed...');
    const [[statsRows], [feedRows], [totalRows]] = await Promise.all([
      bq.query({ query: STATS_QUERY,       location: 'asia-northeast3' }),
      bq.query({ query: FEED_QUERY,        location: 'asia-northeast3' }),
      bq.query({ query: TOTAL_COUNT_QUERY, location: 'asia-northeast3' }),
    ]);

    const totals = statsRows.reduce((acc, r) => ({
      general:   acc.general   + Number(r.general_review_cnt),
      premium:   acc.premium   + Number(r.premium_review_cnt),
      benefit:   acc.benefit   + Number(r.benefit_review_cnt),
      interview: acc.interview + Number(r.interview_review_cnt),
      salary:    acc.salary    + Number(r.salary_review_cnt),
      total:     acc.total     + Number(r.total_cnt),
    }), { general: 0, premium: 0, benefit: 0, interview: 0, salary: 0, total: 0 });

    const latest = statsRows.length > 0 ? statsRows[statsRows.length - 1] : null;

    const typeRatios = totals.total > 0 ? {
      general:   totals.general   / totals.total,
      premium:   totals.premium   / totals.total,
      benefit:   totals.benefit   / totals.total,
      interview: totals.interview / totals.total,
      salary:    totals.salary    / totals.total,
    } : { general: 0.4, premium: 0.2, benefit: 0.15, interview: 0.15, salary: 0.1 };

    // feed 기준 타입별 카운트 (snapshot 1일 지연 문제 우회)
    const feedTypeCounts = feedRows.reduce((acc, r) => {
      acc[r.review_type] = (acc[r.review_type] || 0) + 1;
      return acc;
    }, {});
    const feedDateVal = feedRows.length > 0
      ? (feedRows[0].feed_date?.value ?? feedRows[0].feed_date ?? null)
      : null;

    cache = {
      trend: statsRows.map(r => ({
        approved_date:        r.approved_date?.value ?? r.approved_date,
        general_review_cnt:   Number(r.general_review_cnt),
        premium_review_cnt:   Number(r.premium_review_cnt),
        benefit_review_cnt:   Number(r.benefit_review_cnt),
        interview_review_cnt: Number(r.interview_review_cnt),
        salary_review_cnt:    Number(r.salary_review_cnt),
        total_cnt:            Number(r.total_cnt),
      })),
      // latest는 feed 기준으로 계산 (dim_reviews_upsert → 당일 최신 반영)
      latest: feedRows.length > 0 ? {
        approved_date:        feedDateVal,
        general_review_cnt:   feedTypeCounts['general_review']   || 0,
        premium_review_cnt:   feedTypeCounts['premium_review']   || 0,
        benefit_review_cnt:   feedTypeCounts['benefit_review']   || 0,
        interview_review_cnt: feedTypeCounts['interview_review'] || 0,
        salary_review_cnt:    feedTypeCounts['salary_review']    || 0,
        total_cnt:            feedRows.length,
      } : null,
      totals,
      typeRatios,
      totalApproved: totalRows.length > 0 ? Number(totalRows[0].total_approved) : null,
      feedDate: feedRows.length > 0
        ? (feedRows[0].feed_date?.value ?? feedRows[0].feed_date ?? null)
        : null,
      feed: feedRows.map(r => ({
        review_type:      r.review_type,
        approved_ts:      r.approved_ts,
        company_name:     r.company_name || '(기업명 없음)',
        city_name:        r.city_name        || null,
        occupation:       r.occupation       || null,
        experience_year: r.experience_year != null ? Number(r.experience_year) : null,
        industry:        r.industry    || null,
        company_size:    r.company_size || null,
        company_lat:     r.company_lat != null ? Number(r.company_lat) : null,
        company_lng:     r.company_lng != null ? Number(r.company_lng) : null,
        company_city:    r.company_city || null,
        rating:          r.rating != null ? Number(r.rating) : null,
        review_title:    r.review_title || null,
        user_age:        r.user_age != null ? Number(r.user_age) : null,
      })),
      queriedAt: new Date().toISOString(),
    };
    cacheAt = Date.now();

    console.log(`[BQ] done — stats: ${statsRows.length}일, feed: ${feedRows.length}건, feedDate: ${feedDateVal}`);
    res.json(cache);
  } catch (err) {
    console.error('[BQ] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reviews/live', async (req, res) => {
  try {
    if (liveCache && Date.now() - liveCacheAt < LIVE_CACHE_TTL) {
      return res.json(liveCache);
    }

    console.log('[BQ] querying live reviews (last 10 min)...');
    const [rows] = await bq.query({ query: LIVE_QUERY, location: 'asia-northeast3' });

    liveCache = {
      reviews: rows.map(r => ({
        review_type:     r.review_type,
        review_id:       Number(r.review_id),
        approved_ts:     r.approved_ts,
        company_name:    r.company_name || '(기업명 없음)',
        city_name:       r.city_name    || null,
        occupation:      r.occupation   || null,
        experience_year: r.experience_year != null ? Number(r.experience_year) : null,
        company_lat:     r.company_lat != null ? Number(r.company_lat) : null,
        company_lng:     r.company_lng != null ? Number(r.company_lng) : null,
        company_city:    r.company_city || null,
        rating:          r.rating != null ? Number(r.rating) : null,
        review_title:    r.review_title || null,
      })),
      queriedAt: new Date().toISOString(),
    };
    liveCacheAt = Date.now();

    console.log(`[BQ] live: ${rows.length}건`);
    res.json(liveCache);
  } catch (err) {
    console.error('[BQ] live error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/mtd', async (req, res) => {
  try {
    if (mtdCache && Date.now() - mtdCacheAt < MTD_CACHE_TTL) {
      return res.json(mtdCache);
    }

    console.log('[BQ] querying MTD + TOP3...');
    const [[mtdRows], [top3Rows]] = await Promise.all([
      bq.query({ query: MTD_QUERY,   location: 'asia-northeast3' }),
      bq.query({ query: TOP50_QUERY, location: 'asia-northeast1' }),
    ]);

    // KST 기준 이번달 YM
    const kstNow = new Date(Date.now() + 9 * 3600 * 1000);
    const currYm = kstNow.toISOString().slice(0, 7);
    const curr = mtdRows.find(r => r.ym === currYm) ?? null;
    const prev = mtdRows.find(r => r.ym !== currYm) ?? null;

    mtdCache = {
      curr: curr ? {
        ym:           curr.ym,
        approved_cnt: Number(curr.approved_cnt),
        avg_rating:   curr.avg_rating != null ? Number(curr.avg_rating) : null,
      } : null,
      prev: prev ? {
        ym:           prev.ym,
        approved_cnt: Number(prev.approved_cnt),
        avg_rating:   prev.avg_rating != null ? Number(prev.avg_rating) : null,
      } : null,
      top50: top3Rows.map(r => ({
        rank:              Number(r.rank),
        company_id:        r.company_id != null ? Number(r.company_id) : null,
        company_name:      r.company_name || '(기업명 없음)',
        company_type_name: r.company_type_name || null,
        industry:          r.industry_level1_name || null,
        pv_cnt:            Number(r.pv_cnt),
        uv_cnt:            Number(r.uv_cnt),
        review_cnt:        r.review_cnt != null ? Number(r.review_cnt) : null,
        avg_score:         r.avg_score != null ? Number(r.avg_score) : null,
        rank_yesterday:    r.rank_yesterday != null ? Number(r.rank_yesterday) : null,
        rank_change:       r.rank_change != null ? Number(r.rank_change) : null,
      })),
      queriedAt: new Date().toISOString(),
    };
    mtdCacheAt = Date.now();

    console.log(`[BQ] MTD curr=${curr?.approved_cnt ?? 0}, prev=${prev?.approved_cnt ?? 0}, top3=${top3Rows.length}건`);
    res.json(mtdCache);
  } catch (err) {
    console.error('[BQ] mtd error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/pv', async (req, res) => {
  try {
    if (pvCache && Date.now() - pvCacheAt < PV_CACHE_TTL) {
      return res.json(pvCache);
    }

    console.log('[BQ] querying review tab PV (asia-northeast1)...');
    const [pvRows] = await bq.query({ query: PV_QUERY, location: 'asia-northeast1' });

    pvCache = {
      top50: pvRows.map(r => ({
        company_name: r.company_name || '(기업명 없음)',
        pv_cnt:       Number(r.pv_cnt),
        uv_cnt:       Number(r.uv_cnt),
      })),
      queriedAt: new Date().toISOString(),
    };
    pvCacheAt = Date.now();

    console.log(`[BQ] PV: ${pvRows.length}건`);
    res.json(pvCache);
  } catch (err) {
    console.error('[BQ] pv error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  const file = path.join(HTML_PATH, 'index.html');
  res.sendFile(file, err => {
    if (err) {
      console.error('[FILE] sendFile error:', err.message);
      res.status(500).send(`파일 로드 실패: ${err.message}`);
    }
  });
});

// 자정(KST) 캐시 자동 무효화: 클라이언트 리로드 전에 캐시를 미리 갱신한다.
function scheduleMidnightRefresh() {
  const now = Date.now();

  // KST 23:59:50 = UTC 14:59:50
  const next = new Date(now);
  next.setUTCHours(14, 59, 50, 0);
  if (next.getTime() <= now) {
    next.setUTCDate(next.getUTCDate() + 1);
  }

  const delay = next.getTime() - now;
  setTimeout(async () => {
    cache = null; cacheAt = 0;
    liveCache = null; liveCacheAt = 0;
    mtdCache = null; mtdCacheAt = 0;
    pvCache = null; pvCacheAt = 0;
    console.log('[MIDNIGHT] 캐시 무효화 완료 (KST 23:59:50) — BQ 프리워밍 시작');

    try {
      const [[statsRows], [feedRows], [totalRows]] = await Promise.all([
        bq.query({ query: STATS_QUERY,       location: 'asia-northeast3' }),
        bq.query({ query: FEED_QUERY,        location: 'asia-northeast3' }),
        bq.query({ query: TOTAL_COUNT_QUERY, location: 'asia-northeast3' }),
      ]);

      const totals = statsRows.reduce((acc, r) => ({
        general:   acc.general   + Number(r.general_review_cnt),
        premium:   acc.premium   + Number(r.premium_review_cnt),
        benefit:   acc.benefit   + Number(r.benefit_review_cnt),
        interview: acc.interview + Number(r.interview_review_cnt),
        salary:    acc.salary    + Number(r.salary_review_cnt),
        total:     acc.total     + Number(r.total_cnt),
      }), { general: 0, premium: 0, benefit: 0, interview: 0, salary: 0, total: 0 });

      const feedTypeCounts = feedRows.reduce((acc, r) => {
        acc[r.review_type] = (acc[r.review_type] || 0) + 1;
        return acc;
      }, {});
      const feedDateVal = feedRows.length > 0
        ? (feedRows[0].feed_date?.value ?? feedRows[0].feed_date ?? null)
        : null;
      const typeRatios = totals.total > 0 ? {
        general:   totals.general   / totals.total,
        premium:   totals.premium   / totals.total,
        benefit:   totals.benefit   / totals.total,
        interview: totals.interview / totals.total,
        salary:    totals.salary    / totals.total,
      } : { general: 0.4, premium: 0.2, benefit: 0.15, interview: 0.15, salary: 0.1 };

      cache = {
        trend: statsRows.map(r => ({
          approved_date:        r.approved_date?.value ?? r.approved_date,
          general_review_cnt:   Number(r.general_review_cnt),
          premium_review_cnt:   Number(r.premium_review_cnt),
          benefit_review_cnt:   Number(r.benefit_review_cnt),
          interview_review_cnt: Number(r.interview_review_cnt),
          salary_review_cnt:    Number(r.salary_review_cnt),
          total_cnt:            Number(r.total_cnt),
        })),
        latest: feedRows.length > 0 ? {
          approved_date:        feedDateVal,
          general_review_cnt:   feedTypeCounts['general_review']   || 0,
          premium_review_cnt:   feedTypeCounts['premium_review']   || 0,
          benefit_review_cnt:   feedTypeCounts['benefit_review']   || 0,
          interview_review_cnt: feedTypeCounts['interview_review'] || 0,
          salary_review_cnt:    feedTypeCounts['salary_review']    || 0,
          total_cnt:            feedRows.length,
        } : null,
        totals,
        typeRatios,
        totalApproved: totalRows.length > 0 ? Number(totalRows[0].total_approved) : null,
        feedDate: feedDateVal,
        feed: feedRows.map(r => ({
          review_type:      r.review_type,
          approved_ts:      r.approved_ts,
          company_name:     r.company_name || '(기업명 없음)',
          city_name:        r.city_name    || null,
          occupation:       r.occupation   || null,
          experience_year:  r.experience_year != null ? Number(r.experience_year) : null,
          industry:         r.industry     || null,
          company_size:     r.company_size || null,
          company_lat:      r.company_lat != null ? Number(r.company_lat) : null,
          company_lng:      r.company_lng != null ? Number(r.company_lng) : null,
          company_city:     r.company_city || null,
          rating:           r.rating != null ? Number(r.rating) : null,
          review_title:     r.review_title || null,
          user_age:         r.user_age != null ? Number(r.user_age) : null,
        })),
        queriedAt: new Date().toISOString(),
      };
      cacheAt = Date.now();
      console.log(`[MIDNIGHT] 프리워밍 완료 — feed: ${feedRows.length}건, feedDate: ${feedDateVal}`);
    } catch (err) {
      console.error('[MIDNIGHT] 프리워밍 실패 (클라이언트 요청 시 재조회):', err.message);
    }

    scheduleMidnightRefresh();
  }, delay);

  console.log(`[MIDNIGHT] 다음 캐시 무효화: ${new Date(next.getTime()).toISOString()} (${Math.round(delay / 60000)}분 후)`);
}

if (require.main === module) {
  scheduleMidnightRefresh();
  app.listen(PORT, () => {
    console.log(`\nJP Review Dashboard  →  http://localhost:${PORT}\n`);
  });
}

module.exports = app;
