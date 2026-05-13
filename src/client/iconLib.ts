// 아이콘 목록 로더 + 필터 — edit/modals.ts 와 신규 iconPicker.ts 가 공유.
//
// 지연 로딩 + 모듈 내부 캐시: 한 번 가져오면 페이지가 살아있는 동안 재사용한다.
// 외부 CDN 응답을 그대로 파싱해서 BI/MDI 아이콘 이름 배열을 만든다.

let biIconList: string[] | null = null;
let mdiIconList: string[] | null = null;
let selectedIconsList: string[] | null = null;

export async function loadBiIcons(): Promise<string[]> {
    if (biIconList) return biIconList;
    try {
        const res = await fetch('https://cdn.jsdelivr.net/npm/bootstrap-icons@1.13.1/font/bootstrap-icons.json');
        const data = await res.json() as Record<string, unknown>;
        biIconList = Object.keys(data).sort();
    } catch (e) {
        console.error('BI icon list load failed:', e);
        biIconList = [];
    }
    return biIconList;
}

export async function loadMdiIcons(): Promise<string[]> {
    if (mdiIconList) return mdiIconList;
    try {
        const res = await fetch('https://cdn.jsdelivr.net/npm/@mdi/font@7.4.47/css/materialdesignicons.min.css');
        const css = await res.text();
        const matches = [...css.matchAll(/\.mdi-([\w-]+)::before/g)];
        mdiIconList = [...new Set(matches.map(m => m[1]))].sort();
    } catch (e) {
        console.error('MDI icon list load failed:', e);
        mdiIconList = [];
    }
    return mdiIconList;
}

export async function loadSelectedIcons(): Promise<string[]> {
    if (selectedIconsList) return selectedIconsList;
    try {
        const res = await fetch('/icons.json');
        selectedIconsList = await res.json() as string[];
    } catch (e) {
        console.error('icons.json load failed:', e);
        selectedIconsList = [];
    }
    return selectedIconsList;
}

// 아이콘 필터링 (우선순위: 정확일치 → startsWith → contains)
export function filterIcons(iconList: string[] | null | undefined, query: string): string[] {
    if (!iconList || iconList.length === 0) return [];
    if (!query || !query.trim()) return iconList;
    const q = query.toLowerCase().trim();
    const exact = iconList.filter(n => n === q);
    const sw = iconList.filter(n => n !== q && n.startsWith(q));
    const inc = iconList.filter(n => !n.startsWith(q) && n.includes(q));
    return [...exact, ...sw, ...inc];
}
