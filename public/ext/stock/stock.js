/**
 * stock 익스텐션 — TradingView 주식 시세/차트 임베드
 *
 * 호출 형식:
 *   {{stock:AAPL}}        — 기본 카드 (시세 + 미니 차트)
 *   {{stock:AAPL|chart}}  — TradingView 인터랙티브 차트
 *   {{stock:AAPL|mini}}   — 컴팩트 시세 위젯
 *
 * 티커 형식: TradingView 심볼 (AAPL, NASDAQ:AAPL 등)
 */
(function () {
    'use strict';

    function _extractTicker(slug) {
        const idx = slug.indexOf(':');
        return idx >= 0 ? slug.substring(idx + 1).trim() : slug.trim();
    }

    function _toTvSymbol(ticker) {
        return ticker.toUpperCase();
    }

    function _embedTvWidget(containerEl, widgetName, options) {
        const wrap = document.createElement('div');
        wrap.className = 'tradingview-widget-container';

        const inner = document.createElement('div');
        inner.className = 'tradingview-widget-container__widget';
        wrap.appendChild(inner);

        const script = document.createElement('script');
        script.type = 'text/javascript';
        script.src = `https://s3.tradingview.com/external-embedding/embed-widget-${widgetName}.js`;
        script.async = true;
        script.textContent = JSON.stringify(options);
        wrap.appendChild(script);

        containerEl.appendChild(wrap);
    }

    function renderStock(containerDiv, extData, ctx) {
        const ticker = _extractTicker(extData.slug);
        const tvSymbol = _toTvSymbol(ticker);
        const colorTheme = ctx.theme.isDark() ? 'dark' : 'light';

        const rawMode = (extData.args && extData.args['1']) || '';
        const mode = typeof rawMode === 'string' ? rawMode.trim().toLowerCase() : '';

        if (mode === 'chart') {
            containerDiv.classList.add('wiki-stock-chart');
            containerDiv.style.height = '400px';

            _embedTvWidget(containerDiv, 'advanced-chart', {
                autosize: true,
                symbol: tvSymbol,
                interval: 'D',
                timezone: 'Asia/Seoul',
                theme: colorTheme,
                style: '1',
                locale: 'kr',
                allow_symbol_change: false,
                calendar: false,
                support_host: 'https://www.tradingview.com',
            });

        } else if (mode === 'mini') {
            containerDiv.classList.add('wiki-stock-mini');

            _embedTvWidget(containerDiv, 'single-quote', {
                symbol: tvSymbol,
                width: '100%',
                colorTheme,
                isTransparent: false,
                locale: 'kr',
            });

        } else {
            containerDiv.classList.add('wiki-stock-card');

            _embedTvWidget(containerDiv, 'symbol-overview', {
                symbols: [[ticker, tvSymbol + '|1D']],
                chartOnly: false,
                width: '100%',
                height: 300,
                locale: 'kr',
                colorTheme,
                autosize: false,
                showVolume: false,
                showMA: false,
                hideDateRanges: false,
                hideMarketStatus: false,
                hideSymbolLogo: false,
                scalePosition: 'right',
                scaleMode: 'Normal',
                fontFamily: '-apple-system, BlinkMacSystemFont, Trebuchet MS, Roboto, Ubuntu, sans-serif',
                fontSize: '10',
                noTimeScale: false,
                valuesTracking: '1',
                changeMode: 'price-and-percent',
                chartType: 'area',
                lineWidth: 2,
                lineType: 0,
                dateRanges: ['1d|1', '1m|30', '3m|60', '12m|1D', '60m|1W', 'all|1M'],
            });
        }
    }

    /** 정리 훅 — 주입한 TradingView 위젯 컨테이너 제거(SPA/테마 재렌더 시 잔여 위젯·스크립트 정리). */
    function destroyStock(containerDiv) {
        if (!containerDiv) return;
        const wrap = containerDiv.querySelector('.tradingview-widget-container');
        if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
    }

    // SDK 등록. TradingView 위젯은 in-place 리컬러가 불가하므로 onThemeChange 미정의 →
    // SDK 가 테마 변경 시 destroy+재임베드로 새 colorTheme 을 적용한다.
    //
    // 익스텐션 렌더는 항상 render.ts(= window.defineExtension/ctx 제공) 가 로드된 페이지에서만
    // 일어나므로, SDK 가 없는 페이지(렌더가 일어나지 않음)에서는 등록하지 않는다. ctx 없이
    // 레거시 (el,data) 시그니처로 등록하면 ctx 기반 렌더러가 호출 시 throw 하므로 폴백을 두지 않는다.
    if (typeof window.defineExtension === 'function') {
        window.defineExtension({ name: 'stock' }, { render: renderStock, destroy: destroyStock });
    }
})();
