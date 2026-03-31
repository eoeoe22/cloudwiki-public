import type { Context } from 'hono';
import type { Env } from '../types';

/**
 * Analytics Engine 데이터 포인트 스키마:
 *
 * index1: slug (페이지 기준 샘플링)
 *
 * blob1: event_type ('pageview' | 'search' | 'error')
 * blob2: slug (문서 slug 또는 경로)
 * blob3: referer
 * blob4: country (CF-IPCountry)
 * blob5: device ('mobile' | 'desktop')
 * blob6: search_query (검색 이벤트 시)
 * blob7: user_agent
 * blob8: error_message (에러 이벤트 시)
 * blob9: path (요청 경로)
 *
 * double1: response_time_ms
 * double2: status_code
 */

function detectDevice(ua: string): string {
    const lower = ua.toLowerCase();
    if (/mobile|android|iphone|ipad|ipod|webos|opera mini/i.test(lower)) return 'mobile';
    return 'desktop';
}

export function trackPageView(c: Context<Env>, slug: string, responseTimeMs: number = 0) {
    try {
        const analytics = c.env.ANALYTICS;
        if (!analytics) return;

        const req = c.req.raw;
        const ua = req.headers.get('user-agent') || '';
        const referer = req.headers.get('referer') || '';
        const country = (req.cf as any)?.country || '';

        analytics.writeDataPoint({
            indexes: [slug],
            blobs: [
                'pageview',  // blob1: event_type
                slug,        // blob2: slug
                referer,     // blob3: referer
                country,     // blob4: country
                detectDevice(ua), // blob5: device
                '',          // blob6: search_query
                ua,          // blob7: user_agent
                '',          // blob8: error_message
                `/w/${slug}`, // blob9: path
            ],
            doubles: [
                responseTimeMs, // double1: response_time_ms
                200,            // double2: status_code
            ],
        });
    } catch {
        // Analytics Engine 미설정 시 무시
    }
}

export function trackSearch(c: Context<Env>, query: string, resultCount: number, responseTimeMs: number = 0) {
    try {
        const analytics = c.env.ANALYTICS;
        if (!analytics) return;

        const req = c.req.raw;
        const ua = req.headers.get('user-agent') || '';
        const referer = req.headers.get('referer') || '';
        const country = (req.cf as any)?.country || '';

        analytics.writeDataPoint({
            indexes: ['_search'],
            blobs: [
                'search',    // blob1: event_type
                '',          // blob2: slug
                referer,     // blob3: referer
                country,     // blob4: country
                detectDevice(ua), // blob5: device
                query,       // blob6: search_query
                ua,          // blob7: user_agent
                '',          // blob8: error_message
                '/search',   // blob9: path
            ],
            doubles: [
                responseTimeMs, // double1: response_time_ms
                resultCount,    // double2: result_count
            ],
        });
    } catch {
        // Analytics Engine 미설정 시 무시
    }
}

export function trackError(c: Context<Env>, path: string, statusCode: number, errorMessage: string, responseTimeMs: number = 0) {
    try {
        const analytics = c.env.ANALYTICS;
        if (!analytics) return;

        const req = c.req.raw;
        const ua = req.headers.get('user-agent') || '';
        const referer = req.headers.get('referer') || '';
        const country = (req.cf as any)?.country || '';

        analytics.writeDataPoint({
            indexes: ['_error'],
            blobs: [
                'error',       // blob1: event_type
                '',            // blob2: slug
                referer,       // blob3: referer
                country,       // blob4: country
                detectDevice(ua), // blob5: device
                '',            // blob6: search_query
                ua,            // blob7: user_agent
                errorMessage.substring(0, 512), // blob8: error_message (최대 512자)
                path,          // blob9: path
            ],
            doubles: [
                responseTimeMs, // double1: response_time_ms
                statusCode,     // double2: status_code
            ],
        });
    } catch {
        // Analytics Engine 미설정 시 무시
    }
}

/**
 * Analytics Engine SQL API를 통해 쿼리 실행
 */
export async function queryAnalytics(accountId: string, apiToken: string, sql: string): Promise<any> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiToken}`,
        },
        body: sql,
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Analytics query failed (${response.status}): ${text}`);
    }

    const text = await response.text();

    // Analytics Engine SQL API는 FORMAT JSON 사용 시 JSON 반환
    try {
        return JSON.parse(text);
    } catch {
        return { raw: text };
    }
}
