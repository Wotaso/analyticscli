import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAnalyticsMcpServer } from '../src/mcp-server.js';

test('AnalyticsCLI MCP exposes only annotated read-only tools and serves structured results', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://api.analyticscli.com/v1/projects');
    assert.equal(init?.method, 'GET');
    return new Response(JSON.stringify({ items: [{ id: 'project-1', name: 'Example' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const server = createAnalyticsMcpServer({
    token: 'test-readonly-token',
    maxToolCalls: 2,
  });
  const client = new Client({ name: 'analyticscli-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      [
        'analytics_agent_brief',
        'analytics_funnel',
        'analytics_generic_query',
        'analytics_projects_list',
        'analytics_retention',
        'analytics_schema_events',
      ],
    );
    for (const tool of listed.tools) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
      assert.equal(tool.annotations?.idempotentHint, true);
      assert.equal(tool.annotations?.openWorldHint, false);
    }

    const result = await client.callTool({
      name: 'analytics_projects_list',
      arguments: {},
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(
      (result.structuredContent as {
        result: { items: Array<{ id: string }> };
        meta: { readOnly: boolean; call: number; maxToolCalls: number };
      }).result.items,
      [{ id: 'project-1', name: 'Example' }],
    );
    assert.equal(
      (result.structuredContent as { meta: { readOnly: boolean } }).meta.readOnly,
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await client.close();
    await server.close();
  }
});

test('AnalyticsCLI MCP enforces its per-process query budget', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ items: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const server = createAnalyticsMcpServer({
    token: 'test-readonly-token',
    maxToolCalls: 1,
  });
  const client = new Client({ name: 'analyticscli-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const first = await client.callTool({
      name: 'analytics_projects_list',
      arguments: {},
    });
    assert.equal(first.isError, undefined);

    const exhausted = await client.callTool({
      name: 'analytics_projects_list',
      arguments: {},
    });
    assert.equal(exhausted.isError, true);
    assert.match(
      String((exhausted.content[0] as { text?: string }).text),
      /query budget exhausted/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await client.close();
    await server.close();
  }
});

test('agent brief excludes privacy-safe aggregate events from unique-user queries', async () => {
  const originalFetch = globalThis.fetch;
  const genericBodies: Array<{
    metric: string;
    groupBy: string[];
    filters?: { eventNames?: string[] };
  }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === '/v1/schema/events') {
      return new Response(JSON.stringify({
        items: [
          {
            eventName: 'landing_page_view',
            count: 120,
            firstSeen: '2026-07-09T00:00:00.000Z',
            lastSeen: new Date().toISOString(),
            properties: ['runtimeEnv'],
          },
          {
            eventName: 'signup_initiated',
            count: 4,
            firstSeen: '2026-07-10T00:00:00.000Z',
            lastSeen: new Date().toISOString(),
            properties: ['runtimeEnv'],
          },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    assert.equal(url.pathname, '/v1/query/generic');
    const body = JSON.parse(String(init?.body)) as {
      metric: string;
      groupBy: string[];
      filters?: { eventNames?: string[] };
    };
    genericBodies.push(body);
    const rows = body.metric === 'unique_users'
      ? [{ dimensions: {}, value: 3 }]
      : body.groupBy.includes('platform')
        ? [{ dimensions: { platform: 'web' }, value: 124 }]
        : body.groupBy.includes('projectSurface')
          ? [{ dimensions: { projectSurface: 'landing' }, value: 124 }]
          : body.groupBy.includes('day')
            ? [{ dimensions: { day: '2026-07-22 00:00:00' }, value: 124 }]
            : [{ dimensions: {}, value: 124 }];
    return new Response(JSON.stringify({
      metric: body.metric,
      groupBy: body.groupBy,
      rows,
      timeRange: {
        since: '2026-07-09T00:00:00.000Z',
        until: '2026-07-23T00:00:00.000Z',
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const server = createAnalyticsMcpServer({
    token: 'test-readonly-token',
    maxToolCalls: 1,
  });
  const client = new Client({ name: 'analyticscli-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const result = await client.callTool({
      name: 'analytics_agent_brief',
      arguments: {
        projectId: '11111111-1111-4111-8111-111111111111',
        last: '14d',
        dataMode: 'release',
        focus: 'web',
        limit: 25,
      },
    });

    assert.equal(result.isError, undefined);
    const uniqueUsersBody = genericBodies.find((body) => body.metric === 'unique_users');
    assert.deepEqual(uniqueUsersBody?.filters?.eventNames, ['signup_initiated']);
    const brief = (result.structuredContent as {
      result: {
        activity: {
          uniqueUsers: number;
          uniqueUsersSemantics: { excludedAggregateEventNames: string[] };
        };
      };
    }).result;
    assert.equal(brief.activity.uniqueUsers, 3);
    assert.deepEqual(
      brief.activity.uniqueUsersSemantics.excludedAggregateEventNames,
      ['landing_page_view'],
    );
  } finally {
    globalThis.fetch = originalFetch;
    await client.close();
    await server.close();
  }
});
