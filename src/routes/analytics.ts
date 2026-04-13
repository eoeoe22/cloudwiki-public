import { Hono } from 'hono';
import { requireAdmin } from '../middleware/session';
import { queryAnalytics } from '../utils/analytics';
import type { Env } from '../types';

const analyticsRoutes = new Hono<Env>();

analyticsRoutes.use('*', requireAdmin);

const DATASET = 'cloudwiki';

// Analytics API 자격 증명 확인 헬퍼
function getAnalyticsCredentials(c: any): { accountId: string; apiToken: string } | null {
    const accountId = (c.env.CF_ACCOUNT_ID || '').trim();
    const apiToken = (c.env.CF_API_TOKEN || '').trim();
    if (!accountId || !apiToken) return null;
    return { accountId, apiToken };
}

function credentialError(c: any) {
    const hasAccountId = !!(c.env.CF_ACCOUNT_ID || '').trim();
    const hasApiToken = !!(c.env.CF_API_TOKEN || '').trim();
    const missing: string[] = [];
    if (!hasAccountId) missing.push('CF_ACCOUNT_ID');
    if (!hasApiToken) missing.push('CF_API_TOKEN');
    return c.json({
        error: `Analytics API 자격 증명이 설정되지 않았습니다. 누락: [${missing.join(', ')}]. Cloudflare 대시보드 > Workers > Settings > Variables and Secrets에서 추가해주세요.`,
    }, 503);
}

/**
 * GET /analytics/overview?period=7d|30d|90d
 */
analyticsRoutes.get('/overview', async (c) => {
    const creds = getAnalyticsCredentials(c);
    if (!creds) return credentialError(c);

    const period = c.req.query('period') || '7d';
    const days = period === '90d' ? 90 : period === '30d' ? 30 : 7;

    const [summaryResult, dailyResult] = await Promise.all([
        queryAnalytics(creds.accountId, creds.apiToken, `
            SELECT
                count() as total_views,
                count(DISTINCT blob4) as unique_countries,
                sum(_sample_interval) as sampled_views
            FROM ${DATASET}
            WHERE blob1 = 'pageview'
              AND timestamp >= now() - toIntervalDay(${days})
            FORMAT JSON
        `),
        queryAnalytics(creds.accountId, creds.apiToken, `
            SELECT
                toDate(timestamp) as date,
                sum(_sample_interval) as views
            FROM ${DATASET}
            WHERE blob1 = 'pageview'
              AND timestamp >= now() - toIntervalDay(${days})
            GROUP BY date
            ORDER BY date
            FORMAT JSON
        `),
    ]);

    return c.json({
        summary: summaryResult?.data?.[0] || { total_views: 0, unique_countries: 0, sampled_views: 0 },
        daily: dailyResult?.data || [],
    });
});

/**
 * GET /analytics/pages?period=7d|30d|90d&limit=20
 */
analyticsRoutes.get('/pages', async (c) => {
    const creds = getAnalyticsCredentials(c);
    if (!creds) return credentialError(c);

    const period = c.req.query('period') || '7d';
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 20));
    const days = period === '90d' ? 90 : period === '30d' ? 30 : 7;

    const result = await queryAnalytics(creds.accountId, creds.apiToken, `
        SELECT
            blob2 as slug,
            sum(_sample_interval) as views
        FROM ${DATASET}
        WHERE blob1 = 'pageview'
          AND blob2 != ''
          AND timestamp >= now() - toIntervalDay(${days})
        GROUP BY slug
        ORDER BY views DESC
        LIMIT ${limit}
        FORMAT JSON
    `);

    return c.json({ pages: result?.data || [] });
});

/**
 * GET /analytics/trending?hours=1|6|24
 */
analyticsRoutes.get('/trending', async (c) => {
    const creds = getAnalyticsCredentials(c);
    if (!creds) return credentialError(c);

    const hours = Math.min(72, Math.max(1, Number(c.req.query('hours')) || 24));

    const result = await queryAnalytics(creds.accountId, creds.apiToken, `
        SELECT
            blob2 as slug,
            sum(_sample_interval) as views
        FROM ${DATASET}
        WHERE blob1 = 'pageview'
          AND blob2 != ''
          AND timestamp >= now() - toIntervalHour(${hours})
        GROUP BY slug
        ORDER BY views DESC
        LIMIT 20
        FORMAT JSON
    `);

    return c.json({ trending: result?.data || [] });
});

/**
 * GET /analytics/referrers?period=7d|30d|90d&limit=20
 */
analyticsRoutes.get('/referrers', async (c) => {
    const creds = getAnalyticsCredentials(c);
    if (!creds) return credentialError(c);

    const period = c.req.query('period') || '7d';
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 20));
    const days = period === '90d' ? 90 : period === '30d' ? 30 : 7;

    const result = await queryAnalytics(creds.accountId, creds.apiToken, `
        SELECT
            blob3 as referer,
            sum(_sample_interval) as views
        FROM ${DATASET}
        WHERE blob1 = 'pageview'
          AND blob3 != ''
          AND timestamp >= now() - toIntervalDay(${days})
        GROUP BY referer
        ORDER BY views DESC
        LIMIT ${limit}
        FORMAT JSON
    `);

    return c.json({ referrers: result?.data || [] });
});

/**
 * GET /analytics/countries?period=7d|30d|90d
 */
analyticsRoutes.get('/countries', async (c) => {
    const creds = getAnalyticsCredentials(c);
    if (!creds) return credentialError(c);

    const period = c.req.query('period') || '7d';
    const days = period === '90d' ? 90 : period === '30d' ? 30 : 7;

    const result = await queryAnalytics(creds.accountId, creds.apiToken, `
        SELECT
            blob4 as country,
            sum(_sample_interval) as views
        FROM ${DATASET}
        WHERE blob1 = 'pageview'
          AND blob4 != ''
          AND timestamp >= now() - toIntervalDay(${days})
        GROUP BY country
        ORDER BY views DESC
        LIMIT 50
        FORMAT JSON
    `);

    return c.json({ countries: result?.data || [] });
});

/**
 * GET /analytics/devices?period=7d|30d|90d
 */
analyticsRoutes.get('/devices', async (c) => {
    const creds = getAnalyticsCredentials(c);
    if (!creds) return credentialError(c);

    const period = c.req.query('period') || '7d';
    const days = period === '90d' ? 90 : period === '30d' ? 30 : 7;

    const result = await queryAnalytics(creds.accountId, creds.apiToken, `
        SELECT
            blob5 as device,
            sum(_sample_interval) as views
        FROM ${DATASET}
        WHERE blob1 = 'pageview'
          AND timestamp >= now() - toIntervalDay(${days})
        GROUP BY device
        ORDER BY views DESC
        FORMAT JSON
    `);

    return c.json({ devices: result?.data || [] });
});

/**
 * GET /analytics/searches?period=7d|30d|90d&limit=30
 */
analyticsRoutes.get('/searches', async (c) => {
    const creds = getAnalyticsCredentials(c);
    if (!creds) return credentialError(c);

    const period = c.req.query('period') || '7d';
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 30));
    const days = period === '90d' ? 90 : period === '30d' ? 30 : 7;

    const result = await queryAnalytics(creds.accountId, creds.apiToken, `
        SELECT
            blob6 as query,
            sum(_sample_interval) as count
        FROM ${DATASET}
        WHERE blob1 = 'search'
          AND blob6 != ''
          AND timestamp >= now() - toIntervalDay(${days})
        GROUP BY query
        ORDER BY count DESC
        LIMIT ${limit}
        FORMAT JSON
    `);

    return c.json({ searches: result?.data || [] });
});

/**
 * GET /analytics/errors?period=7d|30d|90d&limit=30
 */
analyticsRoutes.get('/errors', async (c) => {
    const creds = getAnalyticsCredentials(c);
    if (!creds) return credentialError(c);

    const period = c.req.query('period') || '7d';
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 30));
    const days = period === '90d' ? 90 : period === '30d' ? 30 : 7;

    const result = await queryAnalytics(creds.accountId, creds.apiToken, `
        SELECT
            blob9 as path,
            blob8 as error_message,
            double2 as status_code,
            sum(_sample_interval) as count
        FROM ${DATASET}
        WHERE blob1 = 'error'
          AND timestamp >= now() - toIntervalDay(${days})
        GROUP BY path, error_message, status_code
        ORDER BY count DESC
        LIMIT ${limit}
        FORMAT JSON
    `);

    return c.json({ errors: result?.data || [] });
});

/**
 * GET /analytics/performance?period=7d|30d|90d
 */
analyticsRoutes.get('/performance', async (c) => {
    const creds = getAnalyticsCredentials(c);
    if (!creds) return credentialError(c);

    const period = c.req.query('period') || '7d';
    const days = period === '90d' ? 90 : period === '30d' ? 30 : 7;

    const [avgResult, dailyResult] = await Promise.all([
        queryAnalytics(creds.accountId, creds.apiToken, `
            SELECT
                avg(double1) as avg_response_ms,
                quantile(0.95)(double1) as p95_response_ms,
                quantile(0.99)(double1) as p99_response_ms
            FROM ${DATASET}
            WHERE blob1 = 'pageview'
              AND timestamp >= now() - toIntervalDay(${days})
            FORMAT JSON
        `),
        queryAnalytics(creds.accountId, creds.apiToken, `
            SELECT
                toDate(timestamp) as date,
                avg(double1) as avg_response_ms
            FROM ${DATASET}
            WHERE blob1 = 'pageview'
              AND timestamp >= now() - toIntervalDay(${days})
            GROUP BY date
            ORDER BY date
            FORMAT JSON
        `),
    ]);

    return c.json({
        summary: avgResult?.data?.[0] || { avg_response_ms: 0, p95_response_ms: 0, p99_response_ms: 0 },
        daily: dailyResult?.data || [],
    });
});

/**
 * GET /analytics/page/:slug?period=7d|30d|90d
 */
analyticsRoutes.get('/page/:slug', async (c) => {
    const creds = getAnalyticsCredentials(c);
    if (!creds) return credentialError(c);

    const slug = c.req.param('slug');
    const period = c.req.query('period') || '7d';
    const days = period === '90d' ? 90 : period === '30d' ? 30 : 7;

    const safeSlug = slug.replace(/'/g, "\\'");

    const [totalResult, dailyResult] = await Promise.all([
        queryAnalytics(creds.accountId, creds.apiToken, `
            SELECT
                sum(_sample_interval) as views
            FROM ${DATASET}
            WHERE blob1 = 'pageview'
              AND blob2 = '${safeSlug}'
              AND timestamp >= now() - toIntervalDay(${days})
            FORMAT JSON
        `),
        queryAnalytics(creds.accountId, creds.apiToken, `
            SELECT
                toDate(timestamp) as date,
                sum(_sample_interval) as views
            FROM ${DATASET}
            WHERE blob1 = 'pageview'
              AND blob2 = '${safeSlug}'
              AND timestamp >= now() - toIntervalDay(${days})
            GROUP BY date
            ORDER BY date
            FORMAT JSON
        `),
    ]);

    return c.json({
        slug,
        total: totalResult?.data?.[0]?.views || 0,
        daily: dailyResult?.data || [],
    });
});

export default analyticsRoutes;
