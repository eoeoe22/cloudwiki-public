import { Hono } from 'hono';
import type { Env } from '../types';
import { requireAuth } from '../middleware/session';
import { sha256Hex } from '../utils/oauth';
import { createSession } from './auth/common';
import { ensureQrLoginMigration } from '../utils/qrLoginMigration';
import type {
    QrLoginStartResponse,
    QrLoginStatusResponse,
    QrLoginInfoResponse,
    QrLoginRedeemResponse,
    QrLoginStatus,
} from '../shared/api/qr-login';

/**
 * QR 로그인 라우트 (`/api/qr-login/*`).
 *
 * 게스트 기기(비로그인)가 QR 을 표시하고, 이미 로그인된 호스트 기기가 스캔·승인하면
 * 게스트 기기에 6시간짜리 임시 세션을 발급한다.
 *
 * 보안 모델:
 *  - token  : QR·승인 URL 에 노출되는 공개 식별자. 그 자체로는 권한이 없다(승인 페이지 열람만).
 *  - secret : 게스트만 보유(start 응답으로만 반환, 저장/QR 미포함). status/redeem 시 소유권 증명.
 *             token 을 관찰한 제3자가 세션을 가로채는 것을 막는다(redeem 은 secret 필수).
 *  - 승인은 로그인된(비차단) 호스트만 가능(requireAuth) + 승인 화면에 게스트 UA 노출(예상 밖 기기 탐지).
 *  - SameSite=Lax 쿠키 + 동일 출처 POST → CSRF 안전(전역 csrf 미들웨어도 Origin 검증).
 *  - 세션 쿠키는 redeem 을 호출한 주체(=게스트 기기)의 응답에 실리므로 정확히 게스트에 로그인된다.
 */

const qrLogin = new Hono<Env>();

// 핸드셰이크(QR) 만료 — 결과 세션(6h)과 별개로 짧게 유지한다.
const QR_LOGIN_TTL_SECONDS = 300; // 5분
const POLL_INTERVAL_MS = 2000;

interface QrRow {
    token: string;
    secret_hash: string;
    status: string;
    guest_ua: string | null;
    approved_user_id: number | null;
    created_at: number;
    expires_at: number;
    approved_at: number | null;
    consumed_at: number | null;
}

function randomHex(bytes: number): string {
    const arr = new Uint8Array(bytes);
    crypto.getRandomValues(arr);
    return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
}

function nowSec(): number {
    return Math.floor(Date.now() / 1000);
}

async function loadSession(db: D1Database, token: string): Promise<QrRow | null> {
    return db.prepare('SELECT * FROM qr_login_sessions WHERE token = ?').bind(token).first<QrRow>();
}

/** 저장된 상태를 만료 반영해 노출용 상태로 정규화한다(진행 중 상태만 expires 로 만료 처리). */
function effectiveStatus(row: QrRow, now: number): QrLoginStatus {
    if ((row.status === 'pending' || row.status === 'approved') && row.expires_at < now) {
        return 'expired';
    }
    return row.status as QrLoginStatus;
}

/**
 * POST /api/qr-login/start
 * 게스트(비로그인) 기기가 QR 로그인 핸드셰이크를 시작한다.
 */
qrLogin.post('/qr-login/start', async (c) => {
    await ensureQrLoginMigration(c.env.DB);
    const db = c.env.DB;
    const now = nowSec();

    // 만료분 정리(테이블 무한 증가 방지, best-effort). expires_at 인덱스 사용.
    await db.prepare('DELETE FROM qr_login_sessions WHERE expires_at < ?').bind(now).run();

    const token = randomHex(32);
    const secret = randomHex(32);
    const secretHash = await sha256Hex(secret);
    const guestUa = c.req.header('User-Agent') || null;
    const expiresAt = now + QR_LOGIN_TTL_SECONDS;

    await db
        .prepare(
            "INSERT INTO qr_login_sessions (token, secret_hash, status, guest_ua, created_at, expires_at) VALUES (?, ?, 'pending', ?, ?, ?)"
        )
        .bind(token, secretHash, guestUa, now, expiresAt)
        .run();

    const origin = new URL(c.req.url).origin;
    return c.json<QrLoginStartResponse>({
        token,
        secret,
        approve_url: `${origin}/qr-login/${token}`,
        expires_at: expiresAt,
        poll_interval_ms: POLL_INTERVAL_MS,
    });
});

/**
 * POST /api/qr-login/status  body: { token, secret }
 * 게스트가 승인 상태를 폴링한다. secret 으로 소유권을 증명해야 한다.
 * secret 이 접근 로그에 남지 않도록 쿼리스트링이 아닌 POST 본문으로 받는다(단발성·5분 TTL 이지만 방어적).
 */
qrLogin.post('/qr-login/status', async (c) => {
    await ensureQrLoginMigration(c.env.DB);
    const body = await c.req
        .json<{ token?: string; secret?: string }>()
        .catch(() => ({} as { token?: string; secret?: string }));
    const token = body.token || '';
    const secret = body.secret || '';
    if (!token || !secret) {
        return c.json({ error: '유효하지 않은 요청입니다.' }, 400);
    }

    const row = await loadSession(c.env.DB, token);
    // 없음/삭제(만료 정리됨) → 게스트 관점에서 만료. secret 노출 없이 처리.
    if (!row) {
        return c.json<QrLoginStatusResponse>({ status: 'expired' });
    }
    const secretHash = await sha256Hex(secret);
    if (secretHash !== row.secret_hash) {
        return c.json({ error: '유효하지 않은 요청입니다.' }, 403);
    }

    return c.json<QrLoginStatusResponse>({ status: effectiveStatus(row, nowSec()) });
});

/**
 * GET /api/qr-login/info?token=
 * 호스트 승인 페이지용. 로그인될 계정(호스트 본인)과 게스트 기기 정보를 반환한다.
 */
qrLogin.get('/qr-login/info', requireAuth, async (c) => {
    await ensureQrLoginMigration(c.env.DB);
    const user = c.get('user')!;
    const token = c.req.query('token') || '';
    if (!token) {
        return c.json({ error: '유효하지 않은 요청입니다.' }, 400);
    }

    const row = await loadSession(c.env.DB, token);
    if (!row) {
        return c.json({ error: 'QR 코드를 찾을 수 없거나 만료되었습니다.' }, 404);
    }

    return c.json<QrLoginInfoResponse>({
        status: effectiveStatus(row, nowSec()),
        account: {
            id: user.id,
            name: user.name,
            picture: user.picture ?? null,
        },
        guest: {
            user_agent: row.guest_ua,
            created_at: row.created_at,
            expires_at: row.expires_at,
        },
    });
});

/**
 * POST /api/qr-login/approve  body: { token }
 * 로그인된(비차단) 호스트가 QR 을 승인한다. 승인 계정 = 호스트 본인.
 */
qrLogin.post('/qr-login/approve', requireAuth, async (c) => {
    await ensureQrLoginMigration(c.env.DB);
    const user = c.get('user')!;
    const body = await c.req.json<{ token?: string }>().catch(() => ({} as { token?: string }));
    const token = body.token || '';
    if (!token) {
        return c.json({ error: '유효하지 않은 요청입니다.' }, 400);
    }

    const now = nowSec();
    // pending + 미만료만 approved 로 전이(원자적 CAS 로 이중 승인/취소 경합 방지).
    const res = await c.env.DB.prepare(
        `UPDATE qr_login_sessions
         SET status = 'approved', approved_user_id = ?, approved_at = ?
         WHERE token = ? AND status = 'pending' AND expires_at >= ?`
    )
        .bind(user.id, now, token, now)
        .run();

    if (!res.meta.changes) {
        // 실패 원인 구분 안내
        const row = await loadSession(c.env.DB, token);
        if (!row) return c.json({ error: '만료되었거나 존재하지 않는 QR 코드입니다.' }, 404);
        if (row.expires_at < now) return c.json({ error: 'QR 코드가 만료되었습니다.' }, 410);
        if (row.status === 'cancelled') return c.json({ error: '취소된 요청입니다.' }, 409);
        return c.json({ error: '이미 처리된 요청입니다.' }, 409);
    }

    return c.json({ success: true });
});

/**
 * POST /api/qr-login/cancel  body: { token, secret? }
 * 호스트(승인 페이지) 또는 게스트(secret) 가 요청을 취소한다.
 */
qrLogin.post('/qr-login/cancel', async (c) => {
    await ensureQrLoginMigration(c.env.DB);
    const body = await c.req
        .json<{ token?: string; secret?: string }>()
        .catch(() => ({} as { token?: string; secret?: string }));
    const token = body.token || '';
    if (!token) {
        return c.json({ error: '유효하지 않은 요청입니다.' }, 400);
    }

    const row = await loadSession(c.env.DB, token);
    if (!row) {
        return c.json({ success: true }); // 이미 없음 → 멱등 성공
    }

    // 소유권: 게스트 secret 일치 또는 로그인된 사용자(QR 을 스캔해 token 을 보유한 호스트).
    let allowed = false;
    if (body.secret) {
        const h = await sha256Hex(body.secret);
        if (h === row.secret_hash) allowed = true;
    }
    if (!allowed && c.get('user')) allowed = true;
    if (!allowed) {
        return c.json({ error: '권한이 없습니다.' }, 403);
    }

    await c.env.DB.prepare(
        "UPDATE qr_login_sessions SET status = 'cancelled' WHERE token = ? AND status IN ('pending', 'approved')"
    )
        .bind(token)
        .run();

    return c.json({ success: true });
});

/**
 * POST /api/qr-login/redeem  body: { token, secret }
 * 게스트가 승인된 요청을 소진해 6시간짜리 임시 세션 쿠키를 발급받는다.
 */
qrLogin.post('/qr-login/redeem', async (c) => {
    await ensureQrLoginMigration(c.env.DB);
    const db = c.env.DB;
    const body = await c.req
        .json<{ token?: string; secret?: string }>()
        .catch(() => ({} as { token?: string; secret?: string }));
    const token = body.token || '';
    const secret = body.secret || '';
    if (!token || !secret) {
        return c.json({ error: '유효하지 않은 요청입니다.' }, 400);
    }

    const row = await loadSession(db, token);
    if (!row) {
        return c.json({ error: '만료되었거나 존재하지 않는 요청입니다.' }, 404);
    }
    const secretHash = await sha256Hex(secret);
    if (secretHash !== row.secret_hash) {
        return c.json({ error: '유효하지 않은 요청입니다.' }, 403);
    }

    const now = nowSec();
    if (row.expires_at < now) {
        return c.json({ error: '만료된 요청입니다.' }, 410);
    }
    if (row.status !== 'approved') {
        if (row.status === 'cancelled') return c.json({ error: '취소된 요청입니다.' }, 409);
        if (row.status === 'consumed') return c.json({ error: '이미 사용된 요청입니다.' }, 409);
        return c.json({ error: '아직 승인되지 않았습니다.' }, 409);
    }

    const approvedUserId = row.approved_user_id;
    if (!approvedUserId) {
        return c.json({ error: '승인 정보가 유효하지 않습니다.' }, 500);
    }

    // 승인 계정이 여전히 유효한지 확인(승인 후 탈퇴/차단 방지). CAS 소진 전에 읽는다.
    const acct = await db
        .prepare('SELECT id, role, banned_until FROM users WHERE id = ?')
        .bind(approvedUserId)
        .first<{ id: number; role: string; banned_until: number | null }>();
    if (!acct || acct.role === 'deleted') {
        return c.json({ error: '계정을 사용할 수 없습니다.' }, 403);
    }
    if (acct.banned_until && acct.banned_until > now) {
        return c.json({ error: '차단된 계정입니다.' }, 403);
    }

    // 원자적 approved → consumed (이중 redeem 으로 세션이 2개 발급되는 경합 방지).
    const upd = await db
        .prepare("UPDATE qr_login_sessions SET status = 'consumed', consumed_at = ? WHERE token = ? AND status = 'approved'")
        .bind(now, token)
        .run();
    if (!upd.meta.changes) {
        return c.json({ error: '이미 사용된 요청입니다.' }, 409);
    }

    // 6시간짜리 임시 세션 발급 — createSession(remember=false) = SESSION_TTL_DEFAULT(6h).
    // 요청 주체가 게스트 기기이므로 세션 user_agent 는 게스트 UA 로 기록되고 쿠키도 게스트 응답에 실린다.
    await createSession(c, approvedUserId, false);

    return c.json<QrLoginRedeemResponse>({ success: true });
});

export default qrLogin;
