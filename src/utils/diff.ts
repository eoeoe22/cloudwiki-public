// 라인 단위 diff 통계 계산 — git --stat 의 +N/-M 와 같은 의미.
// LCS 길이를 2-row DP 로 구해 added = newLines - LCS, removed = oldLines - LCS 로 산출한다.
// 각 라인을 사전(intern) 으로 정수 ID 화해 비교를 O(1) 로 만든다 — O(M*N) 시간, O(min(M,N)) 공간.
//
// 주의: 두 본문 모두 LF 기준으로 split 한다. 호출자가 필요하면 CRLF→LF 정규화 후 넘긴다.
//
// 입력이 너무 커서 DP 가 Workers CPU 예산을 위협할 수 있을 때는 null 을 반환한다 — 호출자는
// 통계 마커/필드를 생략하면 된다 (commit 자체는 영향받지 않는다).

export interface LineDiffStats {
    added: number;
    removed: number;
}

// 한 쪽 본문이 이 줄 수를 넘거나, M×N 셀 수가 한도를 넘으면 DP 를 건너뛴다.
// 5000 라인 × 5000 라인 = 25M 셀 한도 — 보수적으로 잡아 일반 위키 본문은 거의 모두 통과시키되
// 비정상적으로 큰 본문에서 commit 핫패스가 막히지 않도록 한다.
const DIFF_MAX_LINES_PER_SIDE = 5000;
const DIFF_MAX_DP_CELLS = 25_000_000;

// 라인 분할: 각 라인에 자체 종결자(\n)을 그대로 붙여 분할한다.
// 마지막 라인이 \n 으로 끝나지 않으면 그 라인만 종결자 없이 남으며, 비교 시 "a" 와 "a\n" 가
// 서로 다른 라인으로 잡혀 git 의 "\ No newline at end of file" 표시(=1 삽입 + 1 삭제) 와
// 정확히 같은 카운트가 산출된다. 빈 본문은 0 라인으로 둔다 — "" → "a\n" 는 +1 (git 와 동일).
function splitLines(text: string): string[] {
    if (text.length === 0) return [];
    const result: string[] = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10 /* '\n' */) {
            result.push(text.substring(start, i + 1));
            start = i + 1;
        }
    }
    if (start < text.length) {
        result.push(text.substring(start));
    }
    return result;
}

export function computeLineDiffStats(oldText: string, newText: string): LineDiffStats | null {
    const oldLines = splitLines(oldText);
    const newLines = splitLines(newText);

    if (oldLines.length === 0) return { added: newLines.length, removed: 0 };
    if (newLines.length === 0) return { added: 0, removed: oldLines.length };

    // 큰 본문은 DP 비용이 급격히 커지므로 통계를 포기한다 — null 반환으로 호출자가 마커/응답
    // 필드를 생략하도록 한다. commit 자체는 차단하지 않는다.
    if (oldLines.length > DIFF_MAX_LINES_PER_SIDE || newLines.length > DIFF_MAX_LINES_PER_SIDE) return null;
    if (oldLines.length * newLines.length > DIFF_MAX_DP_CELLS) return null;

    // 짧은 쪽을 j 축에 두면 메모리 사용량이 줄어든다.
    let a = oldLines;
    let b = newLines;
    let swapped = false;
    if (a.length < b.length) {
        const tmp = a; a = b; b = tmp;
        swapped = true;
    }

    const dict = new Map<string, number>();
    const intern = (s: string): number => {
        let id = dict.get(s);
        if (id === undefined) {
            id = dict.size;
            dict.set(s, id);
        }
        return id;
    };
    const aIds = new Int32Array(a.length);
    const bIds = new Int32Array(b.length);
    for (let i = 0; i < a.length; i++) aIds[i] = intern(a[i]);
    for (let j = 0; j < b.length; j++) bIds[j] = intern(b[j]);

    const m = aIds.length;
    const n = bIds.length;
    let prev = new Int32Array(n + 1);
    let curr = new Int32Array(n + 1);
    for (let i = 1; i <= m; i++) {
        const ai = aIds[i - 1];
        for (let j = 1; j <= n; j++) {
            if (ai === bIds[j - 1]) {
                curr[j] = prev[j - 1] + 1;
            } else {
                const left = curr[j - 1];
                const up = prev[j];
                curr[j] = left >= up ? left : up;
            }
        }
        const t = prev; prev = curr; curr = t;
    }
    const lcs = prev[n];

    const longRemoved = m - lcs;
    const longAdded = n - lcs;
    return swapped
        ? { added: longRemoved, removed: longAdded }
        : { added: longAdded, removed: longRemoved };
}
