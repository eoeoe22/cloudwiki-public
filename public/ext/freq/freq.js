/**
 * freq 익스텐션 — REW 주파수 응답 그래프 렌더러
 *
 * 이 파일은 ENABLED_EXTENSIONS에 "freq"가 포함된 경우에만
 * common.js의 loadConfig()에서 동적으로 로드됩니다.
 *
 * 로드 시 window._extensionRenderers에 자동 등록됩니다.
 *
 * 호출 형식:
 *   {{freq:제목}}                 — 단일 그래프
 *   {{freq:제목1|freq:제목2}}     — 제목2를 타겟 응답으로 사용 (비교/보정 옵션)
 */
(function () {
    'use strict';

    /** REW 텍스트 데이터를 파싱하여 { freq[], spl[], phase[], meta{}, hasPhase } 반환 */
    function _parseFreqData(rawText) {
        const lines = rawText.split('\n');
        const freq = [], spl = [], phase = [];
        const meta = { comments: [], format: 'rew' };
        let hasPhase = false;

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            // 주석/메타데이터: '*'로 시작
            if (trimmed.startsWith('*')) {
                const content = trimmed.replace(/^\*\s*/, '');
                meta.comments.push(content);
                if (content.startsWith('Measurement:')) meta.measurement = content.replace('Measurement:', '').trim();
                if (content.startsWith('Source:')) meta.source = content.replace('Source:', '').trim();
                if (content.startsWith('Dated:')) meta.dated = content.replace('Dated:', '').trim();
                if (content.startsWith('Smoothing:')) meta.smoothing = content.replace('Smoothing:', '').trim();
                continue;
            }

            // 헤더 행 감지: REW 형식("Freq ... SPL")과 CSV 형식("frequency,raw" 등)
            if (trimmed.match(/Freq.*SPL/i)) {
                if (trimmed.match(/Phase/i)) hasPhase = true;
                continue;
            }
            if (/^frequency\b/i.test(trimmed) && !/^\d/.test(trimmed)) {
                meta.format = 'csv';
                if (/phase/i.test(trimmed)) hasPhase = true;
                continue;
            }

            // 데이터 행: 세미콜론, 콤마, 또는 탭/공백 구분
            let parts;
            if (trimmed.includes(';')) {
                parts = trimmed.split(';').map(s => s.trim());
            } else if (trimmed.includes(',')) {
                parts = trimmed.split(',').map(s => s.trim());
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

    /** 정렬된 (freqs, spls)에 대해 query 주파수에서의 SPL을 로그축 선형 보간으로 반환. 범위 밖이면 null. */
    function _interpolateAt(freqs, spls, q) {
        const n = freqs.length;
        if (n === 0 || q < freqs[0] || q > freqs[n - 1]) return null;
        let lo = 0, hi = n - 1;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (freqs[mid] <= q) lo = mid;
            else hi = mid;
        }
        const f0 = freqs[lo], f1 = freqs[hi];
        if (f1 === f0) return spls[lo];
        const t = (Math.log(q) - Math.log(f0)) / (Math.log(f1) - Math.log(f0));
        return spls[lo] + t * (spls[hi] - spls[lo]);
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

        // ── 타겟(2번째 인자) 처리 ──
        // {{freq:A|freq:B}} 형태에서 args["1"] = "freq:B" 가 들어온다.
        // render.js 의 _resolveTransclusionsCore 가 secondary[B] 에 미리 fetch한 결과를 넣어둠.
        const rawTargetArg = extData.args && extData.args['1'];
        const targetArg = (typeof rawTargetArg === 'string') ? rawTargetArg.trim() : '';
        let targetSlug = null;
        let targetParsed = null;
        let targetError = null;
        if (targetArg) {
            targetSlug = targetArg;
            const titleAfterPrefix = targetArg.startsWith('freq:') ? targetArg.substring(5).trim() : '';
            if (!targetArg.startsWith('freq:') || !titleAfterPrefix) {
                // freq: 네임스페이스가 아닌 문서 — 유효한 주파수응답 데이터가 아님
                targetError = `"${targetArg}" 은(는) 유효한 주파수응답 데이터가 아닙니다. (freq: 문서만 타겟으로 사용 가능)`;
            } else {
                const sec = (extData.secondary && extData.secondary[targetSlug]) || null;
                if (!sec) {
                    targetError = `타겟 응답(${titleAfterPrefix})을 불러올 수 없습니다.`;
                } else if (sec.disabled) {
                    targetError = `타겟 응답(${titleAfterPrefix})의 익스텐션이 비활성화되어 있습니다.`;
                } else if (sec.error) {
                    targetError = `타겟 응답(${titleAfterPrefix}): ${sec.error}`;
                } else if (typeof sec.content === 'string') {
                    const tp = _parseFreqData(sec.content);
                    if (tp.freq.length === 0) {
                        targetError = `타겟 응답(${titleAfterPrefix}) 데이터를 파싱할 수 없습니다.`;
                    } else {
                        targetParsed = tp;
                    }
                } else {
                    targetError = `타겟 응답(${titleAfterPrefix})이 유효하지 않습니다.`;
                }
            }
        }

        // 데이터 다운샘플링: 포인트 수가 너무 많으면 성능을 위해 간략화
        const MAX_POINTS = 2000;
        const downsample = (arr, step) => arr.filter((_, i) => i % step === 0);
        let { freq, spl, phase } = parsed;
        if (freq.length > MAX_POINTS) {
            const step = Math.ceil(freq.length / MAX_POINTS);
            freq = downsample(freq, step);
            spl = downsample(spl, step);
            if (phase.length > 0) phase = downsample(phase, step);
        }

        let targetFreq = null, targetSpl = null;
        if (targetParsed) {
            targetFreq = targetParsed.freq;
            targetSpl = targetParsed.spl;
            if (targetFreq.length > MAX_POINTS) {
                const step = Math.ceil(targetFreq.length / MAX_POINTS);
                targetFreq = downsample(targetFreq, step);
                targetSpl = downsample(targetSpl, step);
            }

            // 포맷이 다르면 (예: 1차=REW 절대 SPL vs 타겟=CSV 정규화 응답) 절대 레벨이
            // 크게 어긋나 오버레이/보정에서 스케일이 맞지 않는다.
            // 200~1000 Hz 평균을 기준 레벨로 잡고 타겟을 1차에 맞춰 시프트.
            if (parsed.meta.format !== targetParsed.meta.format) {
                const meanInBand = (xs, ys) => {
                    let sum = 0, count = 0;
                    for (let i = 0; i < xs.length; i++) {
                        if (xs[i] >= 200 && xs[i] <= 1000) { sum += ys[i]; count++; }
                    }
                    return count > 0 ? sum / count : null;
                };
                const pMean = meanInBand(freq, spl);
                const tMean = meanInBand(targetFreq, targetSpl);
                if (pMean !== null && tMean !== null) {
                    const shift = pMean - tMean;
                    targetSpl = targetSpl.map(v => v + shift);
                }
            }
        }

        // 컨테이너 구성
        const docTitle = extData.slug.substring(extData.slug.indexOf(':') + 1);
        const metaLabel = parsed.meta.measurement ? ` — ${parsed.meta.measurement}` : '';
        const targetTitle = (targetParsed && targetSlug && targetSlug.startsWith('freq:'))
            ? targetSlug.substring(5)
            : '';

        let compensateBtnHtml = '';
        let warningHtml = '';
        if (targetParsed) {
            compensateBtnHtml = `<button class="wiki-freq-mode-btn" data-mode="compensate" title="타겟 기준으로 보정 (편차 표시)"><i class="bi bi-rulers"></i> 보정</button>`;
        } else if (targetError) {
            warningHtml = `<div class="wiki-freq-target-warning">⚠️ ${escapeHtml(targetError)}</div>`;
        }

        const hasComments = parsed.meta.comments && parsed.meta.comments.length > 0;
        const infoBtnHtml = hasComments
            ? '<button type="button" class="wiki-freq-info-btn" title="주석 전체 보기"><i class="bi bi-info-circle"></i></button>'
            : '';

        containerDiv.innerHTML = `
            <div class="wiki-freq-graph">
                <div class="wiki-freq-header">
                    <span class="wiki-freq-title">${escapeHtml(docTitle)}${escapeHtml(metaLabel)}${infoBtnHtml}</span>
                    <div class="wiki-freq-controls">
                        ${compensateBtnHtml}
                        ${parsed.hasPhase ? '<button class="wiki-freq-toggle-phase" title="위상 표시/숨기기"><i class="bi bi-activity"></i> Phase</button>' : ''}
                    </div>
                </div>
                ${warningHtml}
                <div class="wiki-freq-canvas-wrap">
                    <canvas></canvas>
                </div>
            </div>
        `;

        const canvas = containerDiv.querySelector('canvas');
        const phaseBtn = containerDiv.querySelector('.wiki-freq-toggle-phase');
        const compensateBtn = containerDiv.querySelector('.wiki-freq-mode-btn[data-mode="compensate"]');
        const infoBtn = containerDiv.querySelector('.wiki-freq-info-btn');

        if (infoBtn && hasComments) {
            infoBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const commentsHtml = parsed.meta.comments
                    .map(c => escapeHtml(c))
                    .join('<br>');
                if (typeof Swal !== 'undefined') {
                    Swal.fire({
                        title: escapeHtml(docTitle),
                        html: `<div style="text-align:left; font-size:0.85rem; line-height:1.5; max-height:60vh; overflow:auto; font-family: var(--bs-font-monospace, monospace);">${commentsHtml}</div>`,
                        confirmButtonText: '닫기',
                        width: '600px',
                    });
                }
            });
        }

        _loadChartJs().then(() => {
            const isDark = document.documentElement.getAttribute('data-bs-theme') === 'dark'
                || window.matchMedia('(prefers-color-scheme: dark)').matches;

            const gridColor = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)';
            const textColor = isDark ? '#b0b0b0' : '#555';
            const splColor = isDark ? '#60a5fa' : '#2563eb';
            const phaseColor = isDark ? '#f97316' : '#ea580c';
            const targetColor = isDark ? '#94a3b8' : '#475569';

            // 상태: 보정 토글 / 위상 토글. 두 토글은 상호 배타 (한 번에 하나만 ON 가능).
            // 기본값: 둘 다 OFF → 타겟이 있으면 점선으로 항상 겹쳐 표시.
            let compensate = false;
            let phaseVisible = false;

            // 보정 모드용: primary - target 을 200~1000 Hz 평균으로 0 정렬
            const buildCompensated = () => {
                const diff = freq.map((f, i) => {
                    const t = _interpolateAt(targetFreq, targetSpl, f);
                    return t === null ? null : spl[i] - t;
                });
                let sum = 0, count = 0;
                for (let i = 0; i < freq.length; i++) {
                    if (diff[i] !== null && freq[i] >= 200 && freq[i] <= 1000) {
                        sum += diff[i];
                        count++;
                    }
                }
                if (count === 0) {
                    for (let i = 0; i < freq.length; i++) {
                        if (diff[i] !== null) { sum += diff[i]; count++; }
                    }
                }
                const offset = count > 0 ? sum / count : 0;
                return freq.map((f, i) => ({ x: f, y: diff[i] === null ? null : diff[i] - offset }));
            };

            const buildPrimaryData = () => {
                if (compensate && targetFreq) return buildCompensated();
                return freq.map((f, i) => ({ x: f, y: spl[i] }));
            };

            const datasets = [
                {
                    label: 'SPL (dB)',
                    data: buildPrimaryData(),
                    borderColor: splColor,
                    backgroundColor: 'transparent',
                    borderWidth: 1.5,
                    pointRadius: 0,
                    tension: 0.1,
                    yAxisID: 'y',
                    spanGaps: false,
                }
            ];

            // Target 데이터셋 — 기본 표시 (점선 겹쳐보기). 보정/위상 모드에서는 숨김.
            if (targetFreq) {
                datasets.push({
                    label: `Target (${targetTitle})`,
                    data: targetFreq.map((f, i) => ({ x: f, y: targetSpl[i] })),
                    borderColor: targetColor,
                    backgroundColor: 'transparent',
                    borderWidth: 1.2,
                    borderDash: [5, 4],
                    pointRadius: 0,
                    tension: 0.1,
                    yAxisID: 'y',
                    hidden: false,
                });
            }

            // x축 범위 — 두 곡선 모두 커버
            const xLow = Math.min(freq[0], targetFreq ? targetFreq[0] : freq[0]);
            const xHigh = Math.max(freq[freq.length - 1], targetFreq ? targetFreq[targetFreq.length - 1] : freq[freq.length - 1]);

            const scales = {
                x: {
                    type: 'logarithmic',
                    title: { display: true, text: 'Frequency (Hz)', color: textColor },
                    min: Math.max(20, xLow),
                    max: Math.min(20000, xHigh),
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
                        legend: {
                            display: !!targetFreq,
                            position: 'bottom',
                            labels: { color: textColor, boxWidth: 18, font: { size: 11 } },
                            onClick: () => {},
                        },
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

            // 보정/위상 토글 상태를 한 번에 적용.
            const applyState = () => {
                const primary = chart.data.datasets[0];
                primary.data = buildPrimaryData();
                primary.label = compensate ? 'SPL Δ (dB)' : 'SPL (dB)';
                chart.options.scales.y.title.text = compensate ? 'SPL Δ (dB)' : 'SPL (dB)';

                // 타겟 점선: 위상 모드에서는 숨김. 보정 모드에서는 평탄한 0 기준선.
                // 그 외에는 원본 타겟 응답을 점선으로 겹쳐 표시.
                const targetDs = chart.data.datasets.find(d => d.label && d.label.indexOf('Target (') === 0);
                if (targetDs) {
                    targetDs.hidden = phaseVisible;
                    if (compensate) {
                        targetDs.data = targetFreq.map(f => ({ x: f, y: 0 }));
                    } else {
                        targetDs.data = targetFreq.map((f, i) => ({ x: f, y: targetSpl[i] }));
                    }
                }

                // 위상 데이터셋
                const phaseDs = chart.data.datasets.find(d => d.yAxisID === 'yPhase');
                if (phaseDs) phaseDs.hidden = !phaseVisible;
                if (chart.options.scales.yPhase) chart.options.scales.yPhase.display = phaseVisible;

                if (compensateBtn) compensateBtn.classList.toggle('active', compensate);
                if (phaseBtn) phaseBtn.classList.toggle('active', phaseVisible);

                chart.update();
            };

            // 두 버튼은 상호 배타 — 한쪽을 켜면 다른 한쪽이 자동으로 꺼진다.
            if (compensateBtn) {
                compensateBtn.addEventListener('click', () => {
                    compensate = !compensate;
                    if (compensate) phaseVisible = false;
                    applyState();
                });
            }

            if (phaseBtn) {
                phaseBtn.addEventListener('click', () => {
                    phaseVisible = !phaseVisible;
                    if (phaseVisible) compensate = false;
                    applyState();
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
