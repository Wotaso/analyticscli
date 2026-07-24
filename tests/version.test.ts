import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CLI_VERSION } from '../src/constants.js';

test('CLI runtime version follows the package manifest used by Changesets', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };

  assert.equal(CLI_VERSION, manifest.version);
});
