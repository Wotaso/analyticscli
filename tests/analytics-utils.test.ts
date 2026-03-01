import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeRateTrendFromTimeseriesPoints,
  computeTrendFromTimeseriesPoints,
  formatTrendSummary,
  resolveTrendInterval,
} from '../src/analytics-utils.js';

test('computeTrendFromTimeseriesPoints reports up/down/flat directions', () => {
  const up = computeTrendFromTimeseriesPoints([
    { ts: '2026-01-01T00:00:00.000Z', value: 10 },
    { ts: '2026-01-02T00:00:00.000Z', value: 15 },
  ]);
  assert.equal(up?.direction, 'up');
  assert.equal(up?.percentChange, 50);

  const down = computeTrendFromTimeseriesPoints([
    { ts: '2026-01-01T00:00:00.000Z', value: 20 },
    { ts: '2026-01-02T00:00:00.000Z', value: 10 },
  ]);
  assert.equal(down?.direction, 'down');
  assert.equal(down?.percentChange, -50);

  const flat = computeTrendFromTimeseriesPoints([
    { ts: '2026-01-01T00:00:00.000Z', value: 0 },
    { ts: '2026-01-02T00:00:00.000Z', value: 0 },
  ]);
  assert.equal(flat?.direction, 'flat');
  assert.equal(flat?.percentChange, 0);
});

test('computeRateTrendFromTimeseriesPoints calculates percent rate trend by timestamp', () => {
  const trend = computeRateTrendFromTimeseriesPoints(
    [
      { ts: '2026-01-01T00:00:00.000Z', value: 40 },
      { ts: '2026-01-02T00:00:00.000Z', value: 70 },
    ],
    [
      { ts: '2026-01-01T00:00:00.000Z', value: 100 },
      { ts: '2026-01-02T00:00:00.000Z', value: 100 },
    ],
    100,
  );

  assert.equal(trend?.startValue, 40);
  assert.equal(trend?.currentValue, 70);
  assert.equal(trend?.percentChange, 75);
  assert.equal(trend?.direction, 'up');
});

test('formatTrendSummary renders a compact readable summary', () => {
  const text = formatTrendSummary({
    startValue: 10,
    currentValue: 15,
    percentChange: 50,
    direction: 'up',
  });
  assert.match(text, /up \+50\.00%/);
});

test('resolveTrendInterval picks hourly for short windows and daily for long windows', () => {
  assert.equal(resolveTrendInterval('24h'), '1h');
  assert.equal(resolveTrendInterval('7d'), '1d');
  assert.equal(resolveTrendInterval('15m'), '1h');
});
