// @ts-nocheck — edit.html 의 인라인 classic <script>(에디터 플로팅 목차 토글 +
// SSR 문법 가이드 링크 설정)를 동작 보존 우선으로 이관한 모듈이다. common.ts 와 동일
// 사유(window.* 단정, DOM 캐스팅)로 1차 이관 단계에서는 타입 검사를 끈다.
//
// 이관 규칙: 이 블록은 common 전역을 bare 로 참조하지 않으며(window._cmView /
// window.CodeMirrorView 는 원본부터 window.* 접두), HTML onclick(edit-main.ts 가
// 생성하는 #editorTocFabBtn)에서 호출되는 toggleEditorFloatingToc 만 window 로 노출한다.

let _editorTocOutsideClickHandler = null;
function _closeEditorFloatingToc() {
    const panel = document.getElementById('editorTocFloatingPanel');
    if (!panel) return;
    panel.classList.remove('visible');
    if (_editorTocOutsideClickHandler) {
        document.removeEventListener('pointerdown', _editorTocOutsideClickHandler, true);
        _editorTocOutsideClickHandler = null;
    }
}
function toggleEditorFloatingToc() {
    const panel = document.getElementById('editorTocFloatingPanel');
    const floatingNav = document.getElementById('editorTocFloatingNav');
    if (!panel || !floatingNav) return;
    const isVisible = panel.classList.contains('visible');

    if (!isVisible) {
        const preview = document.getElementById('custom-wiki-preview');
        if (!preview) return;
        const headings = preview.querySelectorAll('h1, h2, h3, h4, h5, h6');
        if (!headings.length) return;

        const ul = document.createElement('ul');
        headings.forEach((h, i) => {
            if (!h.id) h.id = 'editor-toc-' + i;
            const level = parseInt(h.tagName[1]);
            const li = document.createElement('li');
            li.style.paddingLeft = ((level - 1) * 12) + 'px';
            const a = document.createElement('a');
            a.href = '#';
            a.dataset.hid = h.id;
            // numberHeadings가 삽입한 숫자 prefix(.wiki-heading-num)를 제거한 원문 텍스트 저장
            const numSpan = h.querySelector('.wiki-heading-num');
            const rawText = numSpan
                ? h.textContent.slice(numSpan.textContent.length).trim()
                : h.textContent.trim();
            a.dataset.rawText = rawText;
            a.textContent = h.textContent.trim();
            li.appendChild(a);
            ul.appendChild(li);
        });
        floatingNav.innerHTML = '';
        floatingNav.appendChild(ul);

        floatingNav.querySelectorAll('a[data-hid]').forEach(a => {
            a.addEventListener('click', e => {
                e.preventDefault();
                _closeEditorFloatingToc();
                const hid = a.getAttribute('data-hid');
                const rawText = a.dataset.rawText || '';

                // 1. 에디터(CM6) 스크롤
                const view = window._cmView;
                const cmView = window.CodeMirrorView;
                if (view && cmView && rawText) {
                    const doc = view.state.doc;
                    // 마크다운 문법 제거 유틸리티
                    const stripMd = (t) => t.replace(/(\*\*|__)(.*?)\1/g, '$2')
                        .replace(/(\*|_)(.*?)\1/g, '$2')
                        .replace(/~~(.*?)~~/g, '$2')
                        .replace(/==(.*?)==/g, '$2')
                        .replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1')
                        .replace(/`([^`]+)`/g, '$1')
                        // 헤딩 끝 {collapse} 토큰 제거: 프리뷰 DOM 은 render.ts _applyHeadingCollapseTokens
                        // 가 이미 토큰을 떼므로(targetText 에 토큰 없음), 소스 라인 매칭도 동일 규칙으로
                        // 맞춰야 `## 개요 {collapse}` 헤딩의 편집기 스크롤이 동작한다.
                        .replace(/\s*\{\s*collapse\s*\}\s*#*\s*$/, '').trim();
                    const targetText = stripMd(rawText);

                    for (let ln = 1; ln <= doc.lines; ln++) {
                        const line = doc.line(ln);
                        const m = line.text.match(/^(#{1,6})(.*)/);
                        if (m && stripMd(m[2]) === targetText) {
                            // idiomatic CM6 scrolling
                            view.dispatch({
                                effects: cmView.EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 10 })
                            });
                            break;
                        }
                    }
                }

                // 2. 프리뷰 스크롤 (현재 활성 탭은 변경하지 않음)
                //    모바일에서 에디터 탭을 보고 있을 때 FAB 목차로 이동 시
                //    강제로 프리뷰 탭으로 전환되는 문제를 피하기 위해 탭 전환 로직은 제거.
                //    단, 프리뷰 패널이 숨김 상태(display:none)면 getBoundingClientRect가
                //    0을 반환해 잘못된 오프셋이 계산되므로 보이는 경우에만 스크롤한다.
                requestAnimationFrame(() => {
                    const preview = document.getElementById('custom-wiki-preview');
                    if (!preview) return;
                    // offsetParent === null ⇒ display:none 등으로 렌더링되지 않음
                    if (preview.offsetParent === null) return;
                    const target = preview.querySelector('#' + CSS.escape(hid));
                    if (target) {
                        const pRect = preview.getBoundingClientRect();
                        const hRect = target.getBoundingClientRect();
                        preview.scrollTo({
                            top: preview.scrollTop + hRect.top - pRect.top - 10,
                            behavior: 'smooth'
                        });
                    }
                });
            });
        });
    }

    if (isVisible) {
        _closeEditorFloatingToc();
    } else {
        panel.classList.add('visible');
        const fabGroup = document.getElementById('editorScrollFabGroup');
        _editorTocOutsideClickHandler = (ev) => {
            if (panel.contains(ev.target)) return;
            if (fabGroup && fabGroup.contains(ev.target)) return;
            _closeEditorFloatingToc();
        };
        // 현재 클릭(FAB) 이벤트 이후에 리스너를 등록
        setTimeout(() => {
            if (panel.classList.contains('visible')) {
                document.addEventListener('pointerdown', _editorTocOutsideClickHandler, true);
            }
        }, 0);
    }
}

(function () {
    const el = document.getElementById('ssr-data');
    if (!el) return;
    try {
        const data = JSON.parse(el.textContent);
        if (data._wikiSyntax) {
            const link = document.getElementById('syntaxGuideLink');
            if (link) {
                link.href = '/w/' + encodeURIComponent(data._wikiSyntax);
                link.style.display = '';
            }
        }
    } catch (e) { }
})();

// HTML onclick(edit-main.ts 가 생성하는 #editorTocFabBtn)에서 호출되므로 window 로 노출한다.
window.toggleEditorFloatingToc = toggleEditorFloatingToc;
