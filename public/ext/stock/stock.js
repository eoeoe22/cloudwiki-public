/**
 * stock 익스텐션 — TradingView 주식 시세/차트 임베드
 *
 * 호출 형식:
 *   {{stock:005930.KS}}              — 기본 카드 (시세 + 미니 차트)
 *   {{stock:AAPL|chart}}             — TradingView 인터랙티브 차트
 *   {{stock:005930.KS|chart|h=300}}  — 높이 300px 차트
 *   {{stock:AAPL|mini}}              — 컴팩트 시세 위젯
 *
 * 티커 형식: Yahoo Finance (.KS/.KQ) 또는 TradingView 심볼(AAPL, NASDAQ:AAPL 등)
 */
(function () {
    'use strict';

    function _extractTicker(slug) {
        const idx = slug.indexOf(':');
        return idx >= 0 ? slug.substring(idx + 1).trim() : slug.trim();
    }

    // Yahoo Finance 형식 → TradingView 심볼 변환
    function _toTvSymbol(ticker) {
        if (/^\d{6}\.KS$/.test(ticker)) return 'KRX:' + ticker.slice(0, 6);
        if (/^\d{6}\.KQ$/.test(ticker)) return 'KOSDAQ:' + ticker.slice(0, 6);
        return ticker.toUpperCase();
    }

    function _isDark() {
        return document.documentElement.getAttribute('data-theme') === 'dark'
            || window.matchMedia('(prefers-color-scheme: dark)').matches;
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

    function renderStock(containerDiv, extData) {
        const ticker = _extractTicker(extData.slug);
        const tvSymbol = _toTvSymbol(ticker);
        const colorTheme = _isDark() ? 'dark' : 'light';

        const rawMode = (extData.args && extData.args['1']) || '';
        const mode = typeof rawMode === 'string' ? rawMode.trim().toLowerCase() : '';

        if (mode === 'chart') {
            const h = parseInt((extData.args && extData.args['h']) || '', 10) || 400;
            containerDiv.classList.add('wiki-stock-chart');
            containerDiv.style.height = h + 'px';

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

    if (!window._extensionRenderers) window._extensionRenderers = {};
    window._extensionRenderers['stock'] = renderStock;
})();
