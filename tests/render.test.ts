import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  renderHorizontalBars,
  renderTable,
  renderTimeseriesSvg,
  writeSvgToFile,
} from '../src/render.js';

test('renderTable prints deterministic aligned output', () => {
  const output = renderTable(
    ['event', 'count'],
    [
      ['screen:home', 12],
      ['click:cta', 4],
    ],
  );

  const lines = output.split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0] ?? '', /event\s+\|\s+count/);
  assert.match(lines[2] ?? '', /screen:home\s+\|\s+12/);
  assert.match(lines[3] ?? '', /click:cta\s+\|\s+4/);
});

test('renderHorizontalBars scales bars and handles empty input', () => {
  assert.equal(renderHorizontalBars([]), '(no data)');

  const output = renderHorizontalBars(
    [
      { label: 'A', value: 10 },
      { label: 'B', value: 5 },
    ],
    { width: 10 },
  );

  const lines = output.split('\n');
  const firstBar = lines[0]?.match(/█+/)?.[0].length ?? 0;
  const secondBar = lines[1]?.match(/█+/)?.[0].length ?? 0;
  assert.ok(firstBar > secondBar);
});

test('renderTimeseriesSvg creates escaped svg content', () => {
  const svg = renderTimeseriesSvg({
    title: 'A&B <overview>',
    points: [
      { ts: '2025-01-01T00:00:00.000Z', value: 1 },
      { ts: '2025-01-02T00:00:00.000Z', value: 3 },
    ],
  });

  assert.match(svg, /<svg/);
  assert.match(svg, /A&amp;B &lt;overview&gt;/);
  assert.match(svg, /<path d="M /);
});

test('renderTimeseriesSvg supports empty data state', () => {
  const svg = renderTimeseriesSvg({
    title: 'Empty',
    points: [],
  });

  assert.match(svg, /No data/);
});

test('writeSvgToFile persists svg to disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'prodinfos-cli-render-'));
  const file = join(dir, 'chart.svg');
  const expected = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';

  try {
    await writeSvgToFile(file, expected);
    const actual = await readFile(file, 'utf8');
    assert.equal(actual, expected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
