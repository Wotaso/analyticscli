import { writeFile } from 'node:fs/promises';

export type TimeseriesPoint = {
  ts: string;
  value: number;
};

const repeat = (char: string, length: number): string => {
  return length > 0 ? char.repeat(length) : '';
};

export const renderTable = (headers: string[], rows: Array<Array<string | number>>): string => {
  const normalizedRows = rows.map((row) => row.map((cell) => String(cell)));
  const widths = headers.map((header, index) => {
    const rowWidth = Math.max(...normalizedRows.map((row) => row[index]?.length ?? 0), 0);
    return Math.max(header.length, rowWidth);
  });

  const formatRow = (row: string[]): string => {
    return row
      .map((cell, index) => cell.padEnd(widths[index] ?? cell.length, ' '))
      .join(' | ');
  };

  const divider = widths.map((width) => repeat('-', width)).join('-|-');
  const lines = [formatRow(headers), divider, ...normalizedRows.map((row) => formatRow(row))];
  return lines.join('\n');
};

export const renderHorizontalBars = (
  rows: Array<{ label: string; value: number }>,
  options?: { width?: number; unit?: string },
): string => {
  if (rows.length === 0) {
    return '(no data)';
  }

  const width = options?.width ?? 40;
  const unit = options?.unit ?? '';
  const maxValue = Math.max(...rows.map((row) => row.value), 1);
  const labelWidth = Math.max(...rows.map((row) => row.label.length));

  return rows
    .map((row) => {
      const normalized = Math.max(1, Math.round((row.value / maxValue) * width));
      const bar = repeat('█', normalized);
      return `${row.label.padEnd(labelWidth, ' ')} | ${bar} ${row.value}${unit}`;
    })
    .join('\n');
};

const escapeXml = (value: string): string => {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
};

export const renderTimeseriesSvg = (input: {
  title: string;
  points: TimeseriesPoint[];
  width?: number;
  height?: number;
}): string => {
  const width = input.width ?? 960;
  const height = input.height ?? 420;
  const margin = 48;
  const innerWidth = width - margin * 2;
  const innerHeight = height - margin * 2;

  if (input.points.length === 0) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="${width / 2}" y="${height / 2}" text-anchor="middle" fill="#111827" font-size="16">No data</text>
</svg>`;
  }

  const values = input.points.map((point) => point.value);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const valueRange = Math.max(1, maxValue - minValue);

  const points = input.points.map((point, index) => {
    const x = margin + (index / Math.max(1, input.points.length - 1)) * innerWidth;
    const y = margin + (1 - (point.value - minValue) / valueRange) * innerHeight;
    return { x, y, raw: point };
  });

  const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="${margin}" y="${margin - 16}" fill="#111827" font-size="18" font-family="system-ui, sans-serif">${escapeXml(input.title)}</text>
  <line x1="${margin}" y1="${height - margin}" x2="${width - margin}" y2="${height - margin}" stroke="#9ca3af" stroke-width="1"/>
  <line x1="${margin}" y1="${margin}" x2="${margin}" y2="${height - margin}" stroke="#9ca3af" stroke-width="1"/>
  <path d="${path}" fill="none" stroke="#16a34a" stroke-width="3"/>
  ${points
    .map(
      (point) =>
        `<circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="3" fill="#15803d"><title>${escapeXml(
          `${point.raw.ts}: ${point.raw.value}`,
        )}</title></circle>`,
    )
    .join('')}
  <text x="${margin}" y="${height - margin + 24}" fill="#4b5563" font-size="12">min: ${minValue}</text>
  <text x="${width - margin}" y="${height - margin + 24}" text-anchor="end" fill="#4b5563" font-size="12">max: ${maxValue}</text>
</svg>`;
};

export const writeSvgToFile = async (path: string, svg: string): Promise<void> => {
  await writeFile(path, svg, 'utf8');
};
