#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const run = spawnSync('node', ['--experimental-test-coverage', '--import', 'tsx', '--test', 'tests/**/*.test.ts'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  shell: false,
});

if (run.stdout) {
  process.stdout.write(run.stdout);
}
if (run.stderr) {
  process.stderr.write(run.stderr);
}

if (run.status !== 0) {
  process.exit(run.status ?? 1);
}

const parseCoverageRows = (rawOutput) => {
  const rows = new Map();
  const lines = rawOutput.split(/\r?\n/);
  let currentGroup = '';

  for (const line of lines) {
    const normalized = line.replace(/^[#ℹ]\s?/, '').trimEnd();

    const groupMatch = normalized.match(/^(.+?)\s+\|\s*\|\s*\|\s*\|\s*$/);
    if (groupMatch) {
      const group = groupMatch[1].trim().replace(/\\/g, '/');
      currentGroup = group && group !== 'all files' ? group : '';
      continue;
    }

    const match = normalized.match(
      /^(.+?)\s+\|\s+([0-9]+(?:\.[0-9]+)?)\s+\|\s+([0-9]+(?:\.[0-9]+)?)\s+\|\s+([0-9]+(?:\.[0-9]+)?)\s+\|/,
    );
    if (!match) {
      continue;
    }

    let file = match[1].trim().replace(/\\/g, '/');
    if (file !== 'all files' && !file.includes('/') && currentGroup) {
      file = `${currentGroup}/${file}`;
    }

    rows.set(file, {
      line: Number(match[2]),
      branch: Number(match[3]),
      funcs: Number(match[4]),
    });
  }

  return rows;
};

const coverageRows = parseCoverageRows(`${run.stdout ?? ''}\n${run.stderr ?? ''}`);
const failures = [];

const sourceRows = Array.from(coverageRows.entries())
  .filter(([file]) => file.startsWith('src/'))
  .map(([, metrics]) => metrics);

if (sourceRows.length === 0) {
  failures.push('No source coverage rows (`src/*`) were found in coverage output.');
}

const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
if (sourceRows.length > 0) {
  const sourceOverall = {
    line: average(sourceRows.map((row) => row.line)),
    branch: average(sourceRows.map((row) => row.branch)),
    funcs: average(sourceRows.map((row) => row.funcs)),
  };

  if (sourceOverall.line < 70) {
    failures.push(`source overall line coverage ${sourceOverall.line.toFixed(2)} < 70`);
  }
  if (sourceOverall.branch < 60) {
    failures.push(`source overall branch coverage ${sourceOverall.branch.toFixed(2)} < 60`);
  }
  if (sourceOverall.funcs < 55) {
    failures.push(`source overall function coverage ${sourceOverall.funcs.toFixed(2)} < 55`);
  }
}

const requiredFiles = [
  { file: 'src/analytics-utils.ts', line: 65, branch: 50, funcs: 45 },
  { file: 'src/render.ts', line: 95, branch: 80, funcs: 100 },
  { file: 'src/constants.ts', line: 90, branch: 20, funcs: 100 },
  { file: 'src/http.ts', line: 50, branch: 60, funcs: 55 },
  { file: 'src/config-store.ts', line: 45, branch: 30, funcs: 20 },
  { file: 'src/shell.ts', line: 50, branch: 90, funcs: 25 },
];

for (const requirement of requiredFiles) {
  const row = coverageRows.get(requirement.file);
  if (!row) {
    failures.push(`Missing coverage row for required file: ${requirement.file}`);
    continue;
  }

  if (row.line < requirement.line) {
    failures.push(`${requirement.file} line coverage ${row.line.toFixed(2)} < ${requirement.line}`);
  }
  if (row.branch < requirement.branch) {
    failures.push(`${requirement.file} branch coverage ${row.branch.toFixed(2)} < ${requirement.branch}`);
  }
  if (row.funcs < requirement.funcs) {
    failures.push(`${requirement.file} function coverage ${row.funcs.toFixed(2)} < ${requirement.funcs}`);
  }
}

if (failures.length > 0) {
  process.stderr.write('\nCoverage gate failed for profile "cli":\n');
  for (const failure of failures) {
    process.stderr.write(`- ${failure}\n`);
  }
  process.exit(1);
}

process.stdout.write('\nCoverage gate passed for profile "cli".\n');
