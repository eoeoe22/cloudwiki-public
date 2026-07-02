/**
 * /api/qr-login/* 요청·응답 DTO.
 *
 * QR 로그인 흐름:
 *  1. 게스트(비로그인) 기기가 POST /api/qr-login/start 로 핸드셰이크를 시작 → token(공개)+secret(비공개) 수령.
 *  2. 게스트가 token 이 담긴 승인 URL 을 QR 로 표시하고 GET /api/qr-login/status 로 폴링.
 *  3. 로그인된 호스트 기기가 QR 을 찍어 /qr-login/<token> 승인 페이지 접속 → GET /api/qr-login/info 로
 *     로그인될 계정(호스트 본인)과 게스트 기기 정보를 확인 → POST /api/qr-login/approve.
 *  4. 게스트가 status=approved 를 감지하면 POST /api/qr-login/redeem 으로 6시간 임시 세션 쿠키 수령.
 */

export type QrLoginStatus = 'pending' | 'approved' | 'consumed' | 'cancelled' | 'expired';

/** POST /api/qr-login/start 응답 */
export interface QrLoginStartResponse {
    /** 승인 URL·QR 에 노출되는 공개 토큰 */
    token: string;
    /** 게스트만 보유하는 비공개 secret. status/redeem 호출 시 소유권 증명에 사용(절대 저장/전송 금지) */
    secret: string;
    /** 호스트 기기가 스캔해 접속할 승인 페이지 절대 URL */
    approve_url: string;
    /** 핸드셰이크 만료 시각(unix 초) */
    expires_at: number;
    /** 권장 폴링 간격(ms) */
    poll_interval_ms: number;
}

/** POST /api/qr-login/status 요청 (secret 이 URL/로그에 남지 않도록 본문으로 전송) */
export interface QrLoginStatusRequest {
    token: string;
    secret: string;
}

/** POST /api/qr-login/status 응답 */
export interface QrLoginStatusResponse {
    status: QrLoginStatus;
}

/** GET /api/qr-login/info 응답 (호스트 승인 페이지용) */
export interface QrLoginInfoResponse {
    status: QrLoginStatus;
    /** 로그인될 계정(승인 페이지를 연 호스트 본인) */
    account: {
        id: number;
        name: string;
        picture: string | null;
    };
    /** 게스트 기기 정보 */
    guest: {
        user_agent: string | null;
        created_at: number;
        expires_at: number;
    };
}

/** POST /api/qr-login/redeem 응답 */
export interface QrLoginRedeemResponse {
    success: true;
}
