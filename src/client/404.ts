/**
 * 에러 페이지(/error) 클라이언트 스크립트.
 *
 * - URL ?reason= 쿼리 파라미터를 화면에 표시
 * - 카드 폭발/펼침 애니메이션 트리거 및 클릭 시 카드 던지기 인터랙션
 *
 * 마이그레이션 노트:
 *   기존 public/js/404.js를 ES 모듈로 이전한 첫 번째 사례. Vite 파이프라인 도입의 POC.
 *   외부 라이브러리 의존성이 없는 단일 파일이라 모듈 경계가 자연스럽게 떨어진다.
 */

function setReasonFromQuery(): void {
    const errorReasonNode = document.getElementById('error-reason');
    if (!errorReasonNode) return;

    const reason = new URLSearchParams(window.location.search).get('reason');
    if (reason) {
        errorReasonNode.textContent = reason;
    }
}

function randomIntFromInterval(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1) + min);
}

function initStackAnimations(): void {
    const stackContainer = document.querySelector<HTMLElement>('.stack-container');
    const cardNodes = document.querySelectorAll<HTMLElement>('.card-container');
    const perspecNodes = document.querySelectorAll<HTMLElement>('.perspec');
    const perspec = document.querySelector<HTMLElement>('.perspec');
    const card = document.querySelector<HTMLElement>('.card');

    if (!stackContainer || !perspec || !card) return;

    let counter = stackContainer.children.length;

    // 틸트 애니메이션 후 폭발 애니메이션 트리거
    card.addEventListener('animationend', () => {
        perspecNodes.forEach((elem) => {
            elem.classList.add('explode');
        });
    });

    // 폭발 애니메이션 후 카드 인터랙션 활성화
    perspec.addEventListener('animationend', (e) => {
        if (e.animationName !== 'explode') return;

        cardNodes.forEach((elem) => {
            elem.classList.add('pokeup');

            elem.addEventListener('click', () => {
                const updown = [800, -800];
                const randomY = updown[Math.floor(Math.random() * updown.length)];
                const randomX = Math.floor(Math.random() * 1000) - 1000;
                elem.style.transform = `translate(${randomX}px, ${randomY}px) rotate(-540deg)`;
                elem.style.transition = 'transform 1s ease, opacity 2s';
                elem.style.opacity = '0';
                counter--;
                if (counter === 0) {
                    stackContainer.style.width = '0';
                    stackContainer.style.height = '0';
                }
            });

            const codeUl = elem.querySelector<HTMLUListElement>('.code ul');
            if (!codeUl) return;

            const numLines = randomIntFromInterval(5, 10);
            const lineNodes: HTMLLIElement[] = [];

            for (let index = 0; index < numLines; index++) {
                const lineLength = randomIntFromInterval(25, 97);
                const node = document.createElement('li');
                node.classList.add(`node-${index}`);
                node.style.setProperty('--linelength', `${lineLength}%`);
                codeUl.appendChild(node);
                lineNodes.push(node);
            }

            // 라인을 순서대로 그리기
            lineNodes.forEach((node, index) => {
                if (index === 0) {
                    node.classList.add('writeLine');
                } else {
                    lineNodes[index - 1].addEventListener('animationend', () => {
                        node.classList.add('writeLine');
                    });
                }
            });
        });
    });
}

document.addEventListener('DOMContentLoaded', setReasonFromQuery);
initStackAnimations();
