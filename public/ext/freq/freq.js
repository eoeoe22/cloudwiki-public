/**
 * freq 익스텐션 — REW 주파수 응답 그래프 렌더러
 * 
 * 이 파일은 ENABLED_EXTENSIONS에 "freq"가 포함된 경우에만
 * common.js의 loadConfig()에서 동적으로 로드됩니다.
 * 
 * 로드 시 window._extensionRenderers에 자동 등록됩니다.
 */
(function () {
    'use strict';

    /** REW 텍스트 데이터를 파싱하여 { freq[], spl[], phase[], meta{}, hasPhase } 반환 */
    function _parseFreqData(rawText) {
        const lines = rawText.split('\n');
        const freq = [], spl = [], phase = [];
        const meta = {};
        let hasPhase = false;

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            // 주석/메타데이터: '*'로 시작
            if (trimmed.startsWith('*')) {
                const content = trimmed.replace(/^\*\s*/, '');
                if (content.startsWith('Measurement:')) meta.measurement = content.replace('Measurement:', '').trim();
                if (content.startsWith('Source:')) meta.source = content.replace('Source:', '').trim();
                if (content.startsWith('Dated:')) meta.dated = content.replace('Dated:', '').trim();
                if (content.startsWith('Smoothing:')) meta.smoothing = content.replace('Smoothing:', '').trim();
                continue;
            }

            // 헤더 행 감지
            if (trimmed.match(/Freq.*SPL/i)) {
                if (trimmed.match(/Phase/i)) hasPhase = true;
                continue;
            }

            // 데이터 행: 세미콜론 또는 탭/공백 구분
            let parts;
            if (trimmed.includes(';')) {
                parts = trimmed.split(';').map(s => s.trim());
            } else {
                parts = trimmed.split(/[\t ]+/);
            }

            if (parts.length >= 2) {
                const f = parseFloat(parts[0]);
                const s = parseFloat(parts[1]);
                if (!isNaN(f) && !isNaN(s)) {
                    freq.push(f);
                    spl.push(s);
                    if (parts.length >= 3) {
                        const p = parseFloat(parts[2]);
                        if (!isNaN(p)) {
                            phase.push(p);
                            hasPhase = true;
                        }
                    }
                }
            }
        }

        return { freq, spl, phase, meta, hasPhase };
    }

    /** Chart.js 4.x 동적 로드 */
    function _loadChartJs() {
        return new Promise((resolve, reject) => {
            if (typeof Chart !== 'undefined') { resolve(); return; }
            if (document.getElementById('chartjs-script')) {
                const check = setInterval(() => {
                    if (typeof Chart !== 'undefined') { clearInterval(check); resolve(); }
                }, 100);
                return;
            }
            const script = document.createElement('script');
            script.id = 'chartjs-script';
            script.src = 'https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js';
            script.onload = resolve;
            script.onerror = reject;
            document.body.appendChild(script);
        });
    }

    /** freq 모듈 렌더러 */
    function renderFreqGraph(containerDiv, extData) {
        const parsed = _parseFreqData(extData.content);

        if (parsed.freq.length === 0) {
            containerDiv.innerHTML = '<div class="alert alert-warning">⚠️ 주파수 데이터를 파싱할 수 없습니다.</div>';
            return;
        }

        // 데이터 다운샘플링: 포인트 수가 너무 많으면 성능을 위해 간략화
        const MAX_POINTS = 2000;
        let { freq, spl, phase } = parsed;
        if (freq.length > MAX_POINTS) {
            const step = Math.ceil(freq.length / MAX_POINTS);
            freq = freq.filter((_, i) => i % step === 0);
            spl = spl.filter((_, i) => i % step === 0);
            if (phase.length > 0) phase = phase.filter((_, i) => i % step === 0);
        }

        // 컨테이너 구성
        const docTitle = extData.slug.substring(extData.slug.indexOf(':') + 1);
        const metaLabel = parsed.meta.measurement ? ` — ${parsed.meta.measurement}` : '';

        containerDiv.innerHTML = `
            <div class="wiki-freq-graph">
                <div class="wiki-freq-header">
                    <span class="wiki-freq-title">${escapeHtml(docTitle)}${escapeHtml(metaLabel)}</span>
                    <div class="wiki-freq-controls">
                        ${parsed.hasPhase ? '<button class="wiki-freq-toggle-phase" title="위상 표시/숨기기"><i class="bi bi-activity"></i> Phase</button>' : ''}
                    </div>
                </div>
                <div class="wiki-freq-canvas-wrap">
                    <canvas></canvas>
                </div>
                ${parsed.meta.source ? '<div class="wiki-freq-meta">' + escapeHtml(parsed.meta.source) + '</div>' : ''}
            </div>
        `;

        const canvas = containerDiv.querySelector('canvas');
        const phaseBtn = containerDiv.querySelector('.wiki-freq-toggle-phase');

        _loadChartJs().then(() => {
            const isDark = document.documentElement.getAttribute('data-bs-theme') === 'dark'
                || window.matchMedia('(prefers-color-scheme: dark)').matches;

            const gridColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)';
            const textColor = isDark ? '#b0b0b0' : '#555';
            const splColor = isDark ? '#60a5fa' : '#2563eb';
            const phaseColor = isDark ? '#f97316' : '#ea580c';

            const datasets = [
                {
                    label: 'SPL (dB)',
                    data: freq.map((f, i) => ({ x: f, y: spl[i] })),
                    borderColor: splColor,
                    backgroundColor: 'transparent',
                    borderWidth: 1.5,
                    pointRadius: 0,
                    tension: 0.1,
                    yAxisID: 'y',
                }
            ];

            const scales = {
                x: {
                    type: 'logarithmic',
                    title: { display: true, text: 'Frequency (Hz)', color: textColor },
                    min: Math.max(20, Math.min(...freq)),
                    max: Math.min(20000, Math.max(...freq)),
                    grid: { color: gridColor },
                    ticks: {
                        color: textColor,
                        callback: function(value) {
                            const allowed = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
                            if (allowed.includes(value)) {
                                return value >= 1000 ? (value / 1000) + 'k' : value;
                            }
                            return '';
                        },
                        maxRotation: 0,
                    },
                },
                y: {
                    type: 'linear',
                    title: { display: true, text: 'SPL (dB)', color: splColor },
                    grid: { color: gridColor },
                    ticks: { color: splColor },
                    position: 'left',
                },
            };

            // Phase 데이터셋 (기본 숨김)
            if (parsed.hasPhase && phase.length > 0) {
                datasets.push({
                    label: 'Phase (°)',
                    data: freq.map((f, i) => ({ x: f, y: phase[i] })),
                    borderColor: phaseColor,
                    backgroundColor: 'transparent',
                    borderWidth: 1,
                    pointRadius: 0,
                    tension: 0.1,
                    yAxisID: 'yPhase',
                    hidden: true,
                });
                scales.yPhase = {
                    type: 'linear',
                    title: { display: true, text: 'Phase (°)', color: phaseColor },
                    grid: { drawOnChartArea: false },
                    ticks: { color: phaseColor },
                    position: 'right',
                    display: false,
                };
            }

            const chart = new Chart(canvas, {
                type: 'line',
                data: { datasets },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: { duration: 300 },
                    interaction: {
                        mode: 'index',
                        intersect: false,
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                title: function(items) {
                                    if (items.length > 0) {
                                        const hz = items[0].parsed.x;
                                        return hz >= 1000 ? (hz / 1000).toFixed(2) + ' kHz' : hz.toFixed(1) + ' Hz';
                                    }
                                    return '';
                                }
                            }
                        },
                    },
                    scales,
                }
            });

            // Phase 토글 버튼
            if (phaseBtn) {
                let phaseVisible = false;
                phaseBtn.addEventListener('click', () => {
                    phaseVisible = !phaseVisible;
                    const phaseDataset = chart.data.datasets.find(d => d.yAxisID === 'yPhase');
                    if (phaseDataset) phaseDataset.hidden = !phaseVisible;
                    if (chart.options.scales.yPhase) chart.options.scales.yPhase.display = phaseVisible;
                    phaseBtn.classList.toggle('active', phaseVisible);
                    chart.update();
                });
            }
        }).catch(err => {
            console.error('Chart.js load failed:', err);
            containerDiv.innerHTML = '<div class="alert alert-danger">⚠️ 그래프 라이브러리 로드에 실패했습니다.</div>';
        });
    }

    // 전역 레지스트리에 등록
    if (!window._extensionRenderers) window._extensionRenderers = {};
    window._extensionRenderers['freq'] = renderFreqGraph;
})();
