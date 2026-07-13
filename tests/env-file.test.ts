import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeEnvValue } from '../src/env-file.js';

test('writeEnvValue creates and updates a protected env file without duplicating keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'analyticscli-env-file-'));
  const file = join(dir, '.env.local');

  await writeEnvValue(file, 'EXPO_PUBLIC_ANALYTICSCLI_PUBLISHABLE_API_KEY', 'pi_live_first');
  await writeEnvValue(file, 'OTHER_SETTING', 'kept');
  await writeEnvValue(file, 'EXPO_PUBLIC_ANALYTICSCLI_PUBLISHABLE_API_KEY', 'pi_live_second');

  const contents = await readFile(file, 'utf8');
  assert.equal(
    contents,
    'EXPO_PUBLIC_ANALYTICSCLI_PUBLISHABLE_API_KEY=pi_live_second\nOTHER_SETTING=kept\n',
  );
  if (process.platform !== 'win32') {
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
});

test('writeEnvValue rejects invalid environment variable names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'analyticscli-env-file-invalid-'));
  await assert.rejects(
    writeEnvValue(join(dir, '.env'), 'BAD-NAME', 'value'),
    /valid environment variable name/,
  );
});
