import assert from 'node:assert/strict';
import test from 'node:test';
import { mapStatusToExitCode, requestCollect } from '../src/http.js';

test('mapStatusToExitCode maps auth/client/server failures to expected exit codes', () => {
  assert.equal(mapStatusToExitCode(401), 3);
  assert.equal(mapStatusToExitCode(403), 3);
  assert.equal(mapStatusToExitCode(404), 2);
  assert.equal(mapStatusToExitCode(500), 4);
});

test('requestCollect sends payload with x-api-key and returns JSON response', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({ accepted: true }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;

  try {
    const payload = {
      projectId: '11111111-1111-4111-8111-111111111111',
      sentAt: new Date().toISOString(),
      events: [],
    };

    const result = await requestCollect('/v1/collect', payload, {
      endpoint: 'https://collector.prodinfos.com',
      apiKey: 'pi_write_key',
    });

    assert.deepEqual(result, { accepted: true });
    assert.equal(String(calls[0]?.input), 'https://collector.prodinfos.com/v1/collect');
    const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
    assert.equal(headers['x-api-key'], 'pi_write_key');
    assert.equal(headers['content-type'], 'application/json');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('requestCollect throws typed error with exit code and payload on API failures', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;

  try {
    await assert.rejects(
      requestCollect('/v1/collect', { events: [] }, { endpoint: 'https://collector.prodinfos.com', apiKey: 'x' }),
      (error: unknown) => {
        const typed = error as Error & { exitCode?: number; payload?: unknown };
        assert.equal(typed.message, 'Unauthorized');
        assert.equal(typed.exitCode, 3);
        assert.deepEqual(typed.payload, { error: { message: 'Unauthorized' } });
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('requestCollect handles non-JSON error responses gracefully', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response('server exploded', {
      status: 500,
      headers: { 'content-type': 'text/plain' },
    });
  }) as typeof globalThis.fetch;

  try {
    await assert.rejects(
      requestCollect('/v1/collect', { events: [] }, { endpoint: 'https://collector.prodinfos.com', apiKey: 'x' }),
      (error: unknown) => {
        const typed = error as Error & { exitCode?: number };
        assert.match(typed.message, /Request failed with status 500/);
        assert.equal(typed.exitCode, 4);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
