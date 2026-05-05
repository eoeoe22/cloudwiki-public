// ── 편집 요약 자동 작성 ──
// summaryInput 입력 칸을 자동 prefix + 사용자 입력 형태로 유지한다.
// 형식: "<자동요약> / <사용자입력>" (둘 중 하나만 있으면 해당 부분만 표시)
//
// 자동요약 규칙:
//   - 섹션 편집 모드: "'<섹션 헤딩 텍스트>' 편집"
//   - 신규 문서:      "문서 생성"
//   - 기존 문서:      카테고리 추가/삭제, 관리자 전용(잠금) 변경을 합성
//
// 의존하는 외부(edit.js) 전역:
//   sectionMode, sectionRange, originalPageMeta, categoryTags
//   #summaryInput, #isLockedCheck DOM

let lastAutoSummaryPrefix = '';

function buildAutoEditSummary() {
    // 섹션 편집 모드: 헤딩 텍스트로 요약을 고정한다.
    // (섹션 모드에서는 카테고리/잠금 UI가 숨겨져 변경이 불가능하므로 합성하지 않는다.)
    if (typeof sectionMode !== 'undefined' && sectionMode &&
        typeof sectionRange !== 'undefined' && sectionRange && sectionRange.headingText) {
        return `'${sectionRange.headingText}' 편집`;
    }

    // 신규 문서: 카테고리/잠금은 생성에 포함되므로 '문서 생성'만 표시
    if (typeof originalPageMeta === 'undefined' || !originalPageMeta) return '문서 생성';

    const origCats = originalPageMeta.category
        ? originalPageMeta.category.split(',').map(c => c.trim()).filter(Boolean)
        : [];
    const currCats = (typeof categoryTags !== 'undefined' && Array.isArray(categoryTags))
        ? categoryTags.slice()
        : [];
    const added = currCats.filter(c => !origCats.includes(c));
    const removed = origCats.filter(c => !currCats.includes(c));

    const origLocked = originalPageMeta.is_locked ? 1 : 0;
    const lockEl = document.getElementById('isLockedCheck');
    const currLocked = lockEl && lockEl.checked ? 1 : 0;

    const parts = [];
    if (added.length) parts.push(`분류 ${added.map(c => `'${c}'`).join(', ')} 추가`);
    if (removed.length) parts.push(`분류 ${removed.map(c => `'${c}'`).join(', ')} 삭제`);
    if (origLocked !== currLocked) {
        parts.push(currLocked ? '관리자 전용 설정' : '관리자 전용 해제');
    }
    return parts.join(', ');
}

// 사용자가 직접 입력한 텍스트(자동 prefix 뒤 ' / ')는 보존한 채 prefix만 갱신.
function refreshAutoSummary() {
    const summaryEl = document.getElementById('summaryInput');
    if (!summaryEl) return;

    const newAutoSummary = buildAutoEditSummary();

    // 현재 값에서 직전 자동 prefix를 떼어내 사용자 입력 부분만 추출
    let userPart = summaryEl.value;
    if (lastAutoSummaryPrefix) {
        if (userPart.startsWith(lastAutoSummaryPrefix + ' / ')) {
            userPart = userPart.slice((lastAutoSummaryPrefix + ' / ').length);
        } else if (userPart === lastAutoSummaryPrefix) {
            userPart = '';
        }
    }

    let combined;
    if (newAutoSummary && userPart) {
        combined = `${newAutoSummary} / ${userPart}`;
    } else {
        combined = newAutoSummary || userPart;
    }
    if (combined.length > 255) combined = combined.slice(0, 255);

    summaryEl.value = combined;
    lastAutoSummaryPrefix = newAutoSummary;
}
