// /api/config 와 /api/admin/announcements 응답에서 사용하는 DTO.
// 서버 (src/utils/announcements.ts) 의 Announcement 와 클라이언트가 공유.

/** 일반 사용자에게 노출되는 공지 정보 (배너 렌더용). */
export interface AnnouncementDTO {
    id: number;
    title: string;
    announcedTime: number;
    /** 클릭 시 이동할 URL. 텍스트 전용 배너이면 null. */
    url: string | null;
    /** "mdi mdi-bullhorn" 같은 아이콘 class 문자열. null = 기본 아이콘. */
    icon: string | null;
    /** 블로그 포스트 연동 공지인 경우의 포스트 ID. 외부 링크 / 텍스트 전용은 null.
     *  블로그 페이지의 "공지로 발행 / 취소" 토글 동기화에 사용된다. */
    postId: number | null;
}

/** 관리자 콘솔 전용 — postId 메타와 연결된 블로그 포스트 상태까지 포함. */
export interface AnnouncementAdminDTO extends AnnouncementDTO {
    postId: number | null;
    postTitle?: string | null;
    /** 연결된 블로그 포스트가 soft-delete 된 경우 true. */
    postDeleted?: boolean;
}

export interface AnnouncementListResponse {
    announcements: AnnouncementAdminDTO[];
}

export interface AnnouncementCreateRequest {
    title: string;
    url?: string | null;
    postId?: number | null;
    icon?: string | null;
}

export interface AnnouncementUpdateRequest {
    title?: string;
    icon?: string | null;
}

export interface AnnouncementReorderRequest {
    order: number[];
}

export interface AnnouncementMoveRequest {
    direction: 'up' | 'down';
}
