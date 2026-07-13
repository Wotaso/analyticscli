import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeCliDevice } from '../src/device-auth.js';

test('authorizeCliDevice opens verification URL and returns only the approved short-lived token', async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  const messages: string[] = [];
  const opened: string[] = [];
  const responses = [
    {
      deviceCode: 'device-code-that-is-at-least-thirty-two-characters',
      userCode: 'ABCDE-FGHIJ-KLMNO-PQRST',
      verificationUri: 'https://dash.analyticscli.com/cli',
      verificationUriComplete: 'https://dash.analyticscli.com/cli?code=ABCDE-FGHIJ-KLMNO-PQRST',
      expiresIn: 600,
      interval: 3,
    },
    { status: 'authorization_pending' },
    { status: 'authorized', accessToken: 'short-lived-admin-token' },
  ];

  let clock = 1_000;
  const token = await authorizeCliDevice({
    apiUrl: 'https://api.analyticscli.com',
    request: async (_method, path, body) => {
      calls.push({ path, body });
      return responses.shift()!;
    },
    openUrl: (url) => {
      opened.push(url);
      return { ok: true, code: 0, stdout: '', stderr: '', timedOut: false };
    },
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
    now: () => clock,
    writeStatus: (message) => messages.push(message),
  });

  assert.equal(token, 'short-lived-admin-token');
  assert.deepEqual(opened, ['https://dash.analyticscli.com/cli?code=ABCDE-FGHIJ-KLMNO-PQRST']);
  assert.deepEqual(
    calls.map((call) => call.path),
    ['/v1/auth/cli/device/start', '/v1/auth/cli/device/token', '/v1/auth/cli/device/token'],
  );
  assert.deepEqual(calls[1]?.body, {
    deviceCode: 'device-code-that-is-at-least-thirty-two-characters',
  });
  assert.match(messages.join('\n'), /Confirmation code: ABCDE-FGHIJ-KLMNO-PQRST/);
  assert.doesNotMatch(messages.join('\n'), /short-lived-admin-token/);
});

test('authorizeCliDevice respects --no-open style behavior', async () => {
  let openCalls = 0;
  let clock = 0;
  const responses = [
    {
      deviceCode: 'device-code-that-is-at-least-thirty-two-characters',
      userCode: 'ABCDE-FGHIJ-KLMNO-PQRST',
      verificationUri: 'https://dash.analyticscli.com/cli',
      verificationUriComplete: 'https://dash.analyticscli.com/cli?code=ABCDE-FGHIJ-KLMNO-PQRST',
      expiresIn: 600,
      interval: 3,
    },
    { status: 'authorized', accessToken: 'setup-token' },
  ];

  const token = await authorizeCliDevice({
    openBrowser: false,
    request: async () => responses.shift()!,
    openUrl: () => {
      openCalls += 1;
      return null;
    },
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
    now: () => clock,
    writeStatus: () => undefined,
  });

  assert.equal(token, 'setup-token');
  assert.equal(openCalls, 0);
});
