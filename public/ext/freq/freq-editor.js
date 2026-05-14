/**
 * freq 익스텐션 — 에디터 훅 (스무딩 / 용량 절감 도구)
 *
 * 이 파일은 ENABLED_EXTENSIONS 에 "freq" 가 포함되고 사용자가 에디터 페이지
 * (/edit, /edit/:slug, /blog-edit) 에 진입했을 때만 common.ts 가 동적으로 로드한다.
 * 다른 페이지(열람/검색 등)에는 로드되지 않으므로 도구 코드가 일반 페이지의
 * 번들/실행 비용에 영향을 주지 않는다.
 *
 * 등록 인터페이스:
 *   window._extensionEditors['freq'] = {
 *       disableTextCounter: true,
 *       mount(toolbarEl, api),
 *   };
 *
 * - disableTextCounter: 에디터의 키스트로크별 문자/줄 카운터를 끈다.
 *   REW 데이터는 메가바이트 단위라 split/regex 가 모바일에서 버벅임을 유발한다.
 * - mount(toolbarEl, api): raw textarea 위쪽 도구막대 컨테이너에 버튼을 추가한다.
 *   api = { getValue(), setValue(s), slug, extName }.
 */
(function () {
    'use strict';

    // ── 파서: freq.js 의 _parseFreqData 와 동일한 규약 ──
    // 두 파일은 의도적으로 독립적이다. 렌더러(freq.js)와 에디터 훅이 분리되어
    // 각자의 책임만 갖도록 한다. 파일 형식 변경 시 양쪽을 함께 업데이트해야 한다.
    function parseFreqData(rawText) {
        const lines = (rawText || '').split('\n');
        const freq = [], spl = [], phase = [];
        const meta = { comments: [], format: 'rew' };
        let hasPhase = false;

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            if (trimmed.startsWith('*')) {
                const content = trimmed.replace(/^\*\s*/, '');
                meta.comments.push(content);
                if (content.startsWith('Measurement:')) meta.measurement = content.replace('Measurement:', '').trim();
                if (content.startsWith('Source:')) meta.source = content.replace('Source:', '').trim();
                if (content.startsWith('Dated:')) meta.dated = content.replace('Dated:', '').trim();
                if (content.startsWith('Smoothing:')) meta.smoothing = content.replace('Smoothing:', '').trim();
                continue;
            }

            if (/Freq.*SPL/i.test(trimmed)) {
                if (/Phase/i.test(trimmed)) hasPhase = true;
                continue;
            }
            if (/^frequency\b/i.test(trimmed) && !/^\d/.test(trimmed)) {
                meta.format = 'csv';
                if (/phase/i.test(trimmed)) hasPhase = true;
                continue;
            }

            let parts;
            if (trimmed.includes(';')) parts = trimmed.split(';').map(s => s.trim());
            else if (trimmed.includes(',')) parts = trimmed.split(',').map(s => s.trim());
            else parts = trimmed.split(/[\t ]+/);

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

    // ── 1/N 옥타브 스무딩 + 로그 균등 분포 다운샘플링 ──
    //
    // REW 측정 데이터(50,000+ 포인트)는 인접 빈 간 random 노이즈가 크다. 같은
    // 1/N 옥타브 밴드 내의 SPL 을 평균내면 청감과 일치하는 스무딩이 되며, 그 결과를
    // 로그축에 균등 분포한 N 개 포인트로 다운샘플링하면 파일 크기가 100배 가까이
    // 줄어든다.
    //
    // 위상 데이터는 unwrap 없이 평균하면 잘못된 결과가 나오므로 의도적으로 버린다.
    // 사용자에게 다이얼로그에서 안내한다.
    function smoothFreqResponse(parsed, octaveFraction, outputPoints) {
        const inFreq = parsed.freq;
        const inSpl = parsed.spl;
        const n = inFreq.length;
        if (n === 0) return { freq: [], spl: [] };
        if (n === 1) return { freq: [inFreq[0]], spl: [inSpl[0]] };

        // 입력 데이터가 주파수 순으로 정렬되어 있다고 가정 — REW export 는 항상 그러하다.
        // 그렇지 않은 경우를 대비해 한 번 검사하고 필요시 정렬한다.
        let sorted = true;
        for (let i = 1; i < n; i++) {
            if (inFreq[i] <= inFreq[i - 1]) { sorted = false; break; }
        }
        let f = inFreq, s = inSpl;
        if (!sorted) {
            const indices = inFreq.map((_, i) => i).sort((a, b) => inFreq[a] - inFreq[b]);
            f = indices.map(i => inFreq[i]);
            s = indices.map(i => inSpl[i]);
        }

        const fMin = f[0];
        const fMax = f[n - 1];
        if (fMin <= 0 || fMax <= 0 || fMin >= fMax) {
            return { freq: f.slice(), spl: s.slice() };
        }

        const halfBwLog = Math.LN2 / (2 * octaveFraction);
        const logFMin = Math.log(fMin);
        const logFMax = Math.log(fMax);

        const outFreq = [];
        const outSpl = [];

        // 두 포인터 스윕: outputPoints 가 단조 증가하므로 lo/hi 가 후진할 일이 없다.
        // 각 출력 빈에 해당하는 입력 윈도우는 O(n_total/outputPoints + bandwidth) 시간에 계산된다.
        let lo = 0;
        let hi = 0;
        for (let i = 0; i < outputPoints; i++) {
            const t = outputPoints === 1 ? 0 : i / (outputPoints - 1);
            const logF0 = logFMin + (logFMax - logFMin) * t;
            const f0 = Math.exp(logF0);
            const fLo = Math.exp(logF0 - halfBwLog);
            const fHi = Math.exp(logF0 + halfBwLog);

            while (lo < n && f[lo] < fLo) lo++;
            if (hi < lo) hi = lo;
            while (hi < n && f[hi] <= fHi) hi++;

            const count = hi - lo;
            if (count > 0) {
                let sum = 0;
                for (let j = lo; j < hi; j++) sum += s[j];
                outFreq.push(f0);
                outSpl.push(sum / count);
            } else {
                // 빈 윈도우 (밴드 폭이 입력 간격보다 좁은 경우)는 로그축 선형 보간.
                let bsLo = 0, bsHi = n - 1;
                while (bsHi - bsLo > 1) {
                    const mid = (bsLo + bsHi) >> 1;
                    if (f[mid] <= f0) bsLo = mid;
                    else bsHi = mid;
                }
                const f1 = f[bsLo], f2 = f[bsHi];
                let y;
                if (f1 === f2) y = s[bsLo];
                else {
                    const tt = (Math.log(f0) - Math.log(f1)) / (Math.log(f2) - Math.log(f1));
                    y = s[bsLo] + tt * (s[bsHi] - s[bsLo]);
                }
                outFreq.push(f0);
                outSpl.push(y);
            }
        }
        return { freq: outFreq, spl: outSpl };
    }

    // ── 직렬화: 원본 포맷(REW tab / CSV comma) 보존, 위상 제거, Smoothing 코멘트 갱신 ──
    function serializeFreqData(meta, freq, spl, smoothingNote) {
        const lines = [];

        // Smoothing 코멘트를 최상단에 배치해 스무딩 처리 여부를 즉시 식별할 수 있게 한다.
        // 기존 Smoothing 라인은 중복 방지를 위해 나머지 원본 코멘트에서 제거한다.
        lines.push('* Smoothing: ' + smoothingNote);
        const filteredComments = (meta.comments || []).filter(c => !/^Smoothing:/i.test(c));
        for (const c of filteredComments) lines.push('* ' + c);

        if (meta.format === 'csv') {
            lines.push('frequency,raw');
            for (let i = 0; i < freq.length; i++) {
                lines.push(freq[i].toFixed(4) + ',' + spl[i].toFixed(3));
            }
        } else {
            lines.push('* Freq(Hz) SPL(dB)');
            for (let i = 0; i < freq.length; i++) {
                lines.push(freq[i].toFixed(4) + '\t' + spl[i].toFixed(3));
            }
        }
        // 마지막에 줄바꿈을 하나 더 두면 일반 텍스트 에디터들과 호환성 좋음.
        lines.push('');
        return lines.join('\n');
    }

    // ── 스무딩 다이얼로그 ──
    function openSmoothingDialog(api) {
        if (typeof window.Swal === 'undefined') {
            console.warn('[freq-editor] Swal 가 로드되어 있지 않습니다.');
            return;
        }

        const currentValue = api.getValue();
        const parsed = parseFreqData(currentValue);

        if (parsed.freq.length === 0) {
            window.Swal.fire({
                icon: 'warning',
                title: '스무딩 대상 없음',
                text: '주파수 응답 데이터를 파싱할 수 없습니다.',
            });
            return;
        }

        const phaseWarning = parsed.hasPhase
            ? '<div class="text-warning small mt-2"><i class="bi bi-exclamation-triangle"></i> 스무딩 적용 후 위상(Phase) 데이터는 제거됩니다.</div>'
            : '';

        const existingSmoothing = parsed.meta.smoothing
            ? '<div class="text-muted small mt-1">기존 Smoothing: <code>' + escapeForHtml(parsed.meta.smoothing) + '</code></div>'
            : '';

        window.Swal.fire({
            title: '스무딩 적용',
            html: '<div class="text-start small">' +
                '<p class="mb-2">현재 데이터: <b>' + parsed.freq.length.toLocaleString() + '</b> 포인트 ' +
                '(약 ' + (currentValue.length / 1024).toFixed(1) + ' KB)</p>' +
                existingSmoothing +
                '<label class="form-label fw-bold mt-2 mb-1" for="freqSmoothOctaveSel">옥타브 분수</label>' +
                '<select id="freqSmoothOctaveSel" class="form-select form-select-sm">' +
                '<option value="48">1/48 옥타브 (가장 조밀)</option>' +
                '<option value="24" selected>1/24 옥타브 (REW 권장 기본값)</option>' +
                '<option value="12">1/12 옥타브 (반음)</option>' +
                '<option value="6">1/6 옥타브</option>' +
                '<option value="3">1/3 옥타브 (RTA)</option>' +
                '<option value="1">1 옥타브 (가장 부드러움)</option>' +
                '</select>' +
                '<label class="form-label fw-bold mt-3 mb-1" for="freqSmoothPointsInp">출력 포인트 수</label>' +
                '<input type="number" id="freqSmoothPointsInp" class="form-control form-control-sm" min="50" max="4000" step="10" value="400">' +
                '<small class="text-muted">로그 균등 분포로 생성됩니다. (50 ~ 4000)<br>리비전을 통해 스무딩 이전으로 복원이 가능합니다.</small>' +
                phaseWarning +
                '</div>',
            showCancelButton: true,
            confirmButtonText: '스무딩 적용',
            cancelButtonText: '취소',
            focusConfirm: false,
            preConfirm: () => {
                const octEl = document.getElementById('freqSmoothOctaveSel');
                const ptsEl = document.getElementById('freqSmoothPointsInp');
                const oct = octEl ? parseInt(octEl.value, 10) : NaN;
                const pts = ptsEl ? parseInt(ptsEl.value, 10) : NaN;
                if (!Number.isFinite(oct) || oct <= 0) {
                    window.Swal.showValidationMessage('옥타브 분수를 선택하세요.');
                    return false;
                }
                if (!Number.isFinite(pts) || pts < 50 || pts > 4000) {
                    window.Swal.showValidationMessage('출력 포인트 수는 50~4000 범위입니다.');
                    return false;
                }
                return { oct, pts };
            },
        }).then(result => {
            if (!result.isConfirmed || !result.value) return;
            const { oct, pts } = result.value;
            const smoothed = smoothFreqResponse(parsed, oct, pts);
            const note = '1/' + oct + ' oct, ' + smoothed.freq.length + ' pts (cloudwiki)';
            const newText = serializeFreqData(parsed.meta, smoothed.freq, smoothed.spl, note);
            const oldBytes = currentValue.length;
            const newBytes = newText.length;
            api.setValue(newText);
            // 편집 요약에 스무딩 정보 반영: 400ms 디바운스로 refreshAutoSummary 가 먼저
            // 실행된 뒤 600ms 시점에 덮어쓴다. 다만 그 사이 사용자가 summaryInput 에
            // 직접 타이핑하면 수동 입력 보존을 위해 덮어쓰지 않는다.
            // (refreshAutoSummary 의 프로그램적 .value 대입은 input 이벤트를 발생시키지
            //  않으므로 userTouched 플래그는 실제 키입력에만 반응한다.)
            var summaryEl = document.getElementById('summaryInput');
            var userTouchedSummary = false;
            var onSummaryUserInput = function () { userTouchedSummary = true; };
            if (summaryEl) summaryEl.addEventListener('input', onSummaryUserInput);
            setTimeout(function () {
                if (!summaryEl) return;
                summaryEl.removeEventListener('input', onSummaryUserInput);
                if (userTouchedSummary) return;
                summaryEl.value = '데이터 스무딩 (1/' + oct + ' oct, ' + smoothed.freq.length + ' pts)';
                summaryEl.dispatchEvent(new Event('input'));
            }, 600);
            const reductionPct = oldBytes > 0 ? ((1 - newBytes / oldBytes) * 100) : 0;
            window.Swal.fire({
                icon: 'success',
                title: '스무딩 적용 완료',
                html: '<div class="text-start small">' +
                    '<p class="mb-1">포인트: <b>' + parsed.freq.length.toLocaleString() + '</b> → <b>' + smoothed.freq.length.toLocaleString() + '</b></p>' +
                    '<p class="mb-0">크기: <b>' + (oldBytes / 1024).toFixed(1) + ' KB</b> → <b>' + (newBytes / 1024).toFixed(1) + ' KB</b> ' +
                    '(' + (reductionPct >= 0 ? '−' : '+') + Math.abs(reductionPct).toFixed(1) + '%)</p>' +
                    '</div>',
                timer: 3500,
                showConfirmButton: false,
            });
        });
    }

    // 매우 단순한 HTML 이스케이프 — Swal 내용에 사용자 텍스트(기존 Smoothing 값)를 끼울 때 필요.
    function escapeForHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ── 도구막대 mount ──
    function mount(toolbarEl, api) {
        if (!toolbarEl) return;
        toolbarEl.innerHTML = '';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wiki-ext-toolbar-btn';
        btn.innerHTML = '<i class="bi bi-graph-down-arrow"></i> 데이터 스무딩';
        btn.title = '1/N 옥타브 스무딩';
        btn.addEventListener('click', () => openSmoothingDialog(api));

        toolbarEl.appendChild(btn);
    }

    // 전역 레지스트리에 등록
    if (!window._extensionEditors) window._extensionEditors = {};
    window._extensionEditors['freq'] = {
        mount,
        disableTextCounter: true,
    };
})();
