import { useEffect, useRef } from 'react';
import {
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
} from 'lightweight-charts';

// lightweight-charts v4 wrapper: candles + volume + EMA20 + trade overlays.
// Data contract: `bars` are app-shape candles ({time in ms, open, high, low,
// close, volume}); everything converts to seconds at the boundary because
// lightweight-charts timestamps are UTCTimestamp seconds.
// `datasetKey` (symbol:timeframe) drives the setData()+fitContent() reset —
// same key means the tail was merely updated and the view must not jump.

const toSec = (ms) => Math.floor((Number(ms) || 0) / 1000);

// Precision scaled to price magnitude so sub-cent memecoins stay readable.
const priceFormatFor = (price) => {
  const p = Math.abs(Number(price) || 0);
  if (p < 0.001) return { type: 'price', precision: 8, minMove: 0.00000001 };
  if (p < 0.01) return { type: 'price', precision: 6, minMove: 0.000001 };
  if (p < 1) return { type: 'price', precision: 5, minMove: 0.00001 };
  if (p < 100) return { type: 'price', precision: 3, minMove: 0.001 };
  return { type: 'price', precision: 2, minMove: 0.01 };
};

// engine.js calculateEMA only returns the latest value — the chart overlay
// needs the full curve, so seed the average on the first close (same
// convention as the engine) and walk the rest.
const emaCurve = (bars, period = 20) => {
  const k = 2 / (period + 1);
  let prev = null;
  return bars.map((b) => {
    prev = prev === null ? b.close : b.close * k + prev * (1 - k);
    return { time: toSec(b.time), value: prev };
  });
};

const MARKER_SHAPES = { WIN: 'arrowUp', LOSS: 'arrowDown' };

export const ChartPanel = ({
  bars = [],
  datasetKey = '',
  activeTrades = [],
  historyTrades = [],
}) => {
  const containerRef = useRef(null);
  const wrapRef = useRef(null); // E2E probe: data-bars/dataset render; price-line + marker counts stamped via effects
  const chartRef = useRef(null);
  const candleRef = useRef(null);
  const volRef = useRef(null);
  const emaRef = useRef(null);
  const linesRef = useRef([]);
  const datasetRef = useRef(null);

  // ── Chart lifecycle: create once, observe container, tear down on unmount ──
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#94a3b8',
        fontSize: 12,
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      },
      grid: {
        vertLines: { color: 'rgba(51, 65, 85, 0.22)' },
        horzLines: { color: 'rgba(51, 65, 85, 0.22)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: 'rgba(34, 211, 238, 0.45)', labelBackgroundColor: '#0e7490' },
        horzLine: { color: 'rgba(34, 211, 238, 0.45)', labelBackgroundColor: '#0e7490' },
      },
      rightPriceScale: { borderColor: 'rgba(51, 65, 85, 0.6)' },
      timeScale: {
        borderColor: 'rgba(51, 65, 85, 0.6)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
      },
      localization: { locale: 'en-US' },
    });
    chartRef.current = chart;

    candleRef.current = chart.addCandlestickSeries({
      upColor: '#10b981',
      downColor: '#ef4444',
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444',
      borderVisible: false,
    });

    volRef.current = chart.addHistogramSeries({
      priceScaleId: 'vol',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    emaRef.current = chart.addLineSeries({
      color: 'rgba(34, 211, 238, 0.85)',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    const resize = () => {
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
      }
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volRef.current = null;
      emaRef.current = null;
      linesRef.current = [];
      datasetRef.current = null;
    };
  }, []);

  // ── Data plane: full reset on dataset switch, tail update otherwise ───────
  useEffect(() => {
    const chart = chartRef.current;
    const candle = candleRef.current;
    if (!chart || !candle || !bars.length) return;

    const candleData = bars.map((b) => ({
      time: toSec(b.time),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    }));
    const volData = bars.map((b) => ({
      time: toSec(b.time),
      value: b.volume || 0,
      color: b.close >= b.open ? 'rgba(16, 185, 129, 0.35)' : 'rgba(239, 68, 68, 0.35)',
    }));

    candle.applyOptions({ priceFormat: priceFormatFor(bars[bars.length - 1].close) });

    if (datasetRef.current !== datasetKey) {
      datasetRef.current = datasetKey;
      candle.setData(candleData);
      volRef.current.setData(volData);
      emaRef.current.setData(emaCurve(bars, 20));
      chart.timeScale().fitContent();
    } else {
      candle.update(candleData[candleData.length - 1]);
      volRef.current.update(volData[volData.length - 1]);
      const tail = emaCurve(bars, 20);
      emaRef.current.update(tail[tail.length - 1]);
    }
  }, [bars, datasetKey]);

  // ── Trade overlays: entry/stop/target lines for the charted symbol ────────
  useEffect(() => {
    const candle = candleRef.current;
    if (!candle) return;

    linesRef.current.forEach((line) => candle.removePriceLine(line));
    linesRef.current = [];

    for (const t of activeTrades) {
      const entry = Number(t.entry);
      const stop = Number(t.stopLoss);
      const target = Number(t.target);
      if (Number.isFinite(entry)) {
        linesRef.current.push(candle.createPriceLine({
          price: entry,
          color: 'rgba(255, 255, 255, 0.75)',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'ENTRY',
        }));
      }
      if (Number.isFinite(stop)) {
        linesRef.current.push(candle.createPriceLine({
          price: stop,
          color: '#ef4444',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'STOP',
        }));
      }
      if (Number.isFinite(target)) {
        linesRef.current.push(candle.createPriceLine({
          price: target,
          color: '#10b981',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'TARGET',
        }));
      }
    }
    wrapRef.current?.setAttribute('data-price-lines', String(linesRef.current.length));
  }, [activeTrades]);

  // ── Markers: fill / win / loss / flat events snapped onto bar times ───────
  useEffect(() => {
    const candle = candleRef.current;
    if (!candle || !bars.length) return;

    const times = bars.map((b) => toSec(b.time));
    const first = times[0];
    const last = times[times.length - 1];
    const snap = (ms) => {
      const s = toSec(ms);
      if (!Number.isFinite(s) || s < first) return null;
      if (s >= last) return last;
      let best = first;
      for (const t of times) {
        if (t <= s) best = t;
        else break;
      }
      return best;
    };

    const markers = [];
    for (const t of historyTrades) {
      if (t.openedAt) {
        const time = snap(t.openedAt);
        if (time !== null) markers.push({ time, position: 'belowBar', color: '#22d3ee', shape: 'arrowUp', text: 'FILL' });
      }
      if (t.closedAt) {
        const time = snap(t.closedAt);
        if (time === null) continue;
        if (t.status === 'WIN') {
          markers.push({ time, position: 'aboveBar', color: '#10b981', shape: MARKER_SHAPES.WIN, text: `+$${Number(t.usdPnl || 0).toFixed(2)}` });
        } else if (t.status === 'LOSS') {
          markers.push({ time, position: 'belowBar', color: '#ef4444', shape: MARKER_SHAPES.LOSS, text: `$${Number(t.usdPnl || 0).toFixed(2)}` });
        } else {
          markers.push({ time, position: 'aboveBar', color: '#94a3b8', shape: 'circle', text: t.status });
        }
      }
    }
    markers.sort((a, b) => a.time - b.time);
    candle.setMarkers(markers);
    wrapRef.current?.setAttribute('data-markers', String(markers.length));
  }, [historyTrades, bars]);

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full"
      data-chart-panel
      data-bars={bars.length}
      data-dataset={datasetKey}
    >
      <div ref={containerRef} className="absolute inset-0" />
      {!bars.length && (
        <div className="absolute inset-0 grid place-items-center text-[12px] uppercase tracking-[0.3em] text-slate-400">
          No candle data for this market
        </div>
      )}
    </div>
  );
};
