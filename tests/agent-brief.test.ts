import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compileAgentBrief,
  selectAgentBriefIdentityEvents,
  type GenericQuerySnapshot,
  type SchemaEventSummary,
} from '../src/agent-brief.js';

const snapshot = (
  groupBy: string[],
  rows: GenericQuerySnapshot['rows'],
): GenericQuerySnapshot => ({
  metric: 'event_count',
  groupBy,
  rows,
  timeRange: {
    since: '2026-07-09T00:00:00.000Z',
    until: '2026-07-23T00:00:00.000Z',
  },
});

test('compileAgentBrief infers a web focus and flags missing acquisition context', () => {
  const schemaEvents: SchemaEventSummary[] = [
    {
      eventName: 'landing_page_view',
      count: 120,
      firstSeen: '2026-07-09T00:00:00.000Z',
      lastSeen: '2026-07-22T23:00:00.000Z',
      properties: ['runtimeEnv'],
    },
    {
      eventName: 'signup_initiated',
      count: 4,
      firstSeen: '2026-07-10T00:00:00.000Z',
      lastSeen: '2026-07-22T12:00:00.000Z',
      properties: ['runtimeEnv'],
    },
  ];

  const brief = compileAgentBrief({
    projectId: '11111111-1111-4111-8111-111111111111',
    requestedRange: '14d',
    requestedFocus: 'auto',
    includeDebug: false,
    now: new Date('2026-07-23T00:00:00.000Z'),
    schemaEvents,
    eventCounts: snapshot([], [{ dimensions: {}, value: 124 }]),
    uniqueUsers: {
      ...snapshot([], [{ dimensions: {}, value: 20 }]),
      metric: 'unique_users',
    },
    identitySelection: selectAgentBriefIdentityEvents(schemaEvents),
    platforms: snapshot(['platform'], [
      { dimensions: { platform: 'web' }, value: 124 },
    ]),
    surfaces: snapshot(['projectSurface'], [
      { dimensions: { projectSurface: 'landing' }, value: 124 },
    ]),
    dailyActivity: snapshot(['day'], [
      { dimensions: { day: '2026-07-21 00:00:00' }, value: 50 },
      { dimensions: { day: '2026-07-22 00:00:00' }, value: 74 },
    ]),
  });

  assert.equal(brief.focus, 'web');
  assert.equal(brief.dataMode, 'release');
  assert.equal(brief.activity.eventCount, 124);
  assert.equal(brief.activity.previousHalfEventCount, 50);
  assert.equal(brief.activity.recentHalfEventCount, 74);
  assert.equal(brief.activity.changePercent, 48);
  assert.equal(brief.freshness.status, 'fresh');
  assert.ok(brief.instrumentation.detectedCapabilities.includes('acquisition'));
  assert.ok(
    brief.findings.some((finding) => finding.code === 'MISSING_ACQUISITION_CONTEXT'),
  );
  assert.ok(
    brief.recommendedQueries.some((query) => query.includes(' funnel ')),
  );
});

test('compileAgentBrief treats no release events as a blocking data-quality issue', () => {
  const empty = snapshot([], [{ dimensions: {}, value: 0 }]);
  const brief = compileAgentBrief({
    projectId: '11111111-1111-4111-8111-111111111111',
    requestedRange: '7d',
    requestedFocus: 'mobile',
    includeDebug: true,
    now: new Date('2026-07-23T00:00:00.000Z'),
    schemaEvents: [],
    eventCounts: empty,
    uniqueUsers: { ...empty, metric: 'unique_users' },
    identitySelection: selectAgentBriefIdentityEvents([]),
    platforms: snapshot(['platform'], []),
    surfaces: snapshot(['projectSurface'], []),
    dailyActivity: snapshot(['day'], []),
  });

  assert.equal(brief.dataMode, 'debug');
  assert.equal(brief.freshness.status, 'empty');
  assert.equal(brief.findings[0]?.code, 'NO_RELEASE_EVENTS');
  assert.equal(brief.instrumentation.missingCapabilities.length, 4);
});

test('aggregate pageviews are excluded from agent-brief identity semantics', () => {
  const schemaEvents: SchemaEventSummary[] = [
    {
      eventName: 'landing_page_view',
      count: 100,
      firstSeen: '2026-07-09T00:00:00.000Z',
      lastSeen: '2026-07-22T23:00:00.000Z',
      properties: ['runtimeEnv'],
    },
    {
      eventName: 'aggregate:pricing_view',
      count: 20,
      firstSeen: '2026-07-09T00:00:00.000Z',
      lastSeen: '2026-07-22T23:00:00.000Z',
      properties: ['runtimeEnv'],
    },
    {
      eventName: 'signup_initiated',
      count: 4,
      firstSeen: '2026-07-10T00:00:00.000Z',
      lastSeen: '2026-07-22T12:00:00.000Z',
      properties: ['runtimeEnv'],
    },
  ];
  const identitySelection = selectAgentBriefIdentityEvents(schemaEvents);

  assert.deepEqual(identitySelection, {
    eventNames: ['signup_initiated'],
    excludedAggregateEventNames: ['landing_page_view', 'aggregate:pricing_view'],
    truncated: false,
  });

  const brief = compileAgentBrief({
    projectId: '11111111-1111-4111-8111-111111111111',
    requestedRange: '14d',
    requestedFocus: 'web',
    includeDebug: false,
    now: new Date('2026-07-23T00:00:00.000Z'),
    schemaEvents,
    eventCounts: snapshot([], [{ dimensions: {}, value: 124 }]),
    uniqueUsers: {
      ...snapshot([], [{ dimensions: {}, value: 3 }]),
      metric: 'unique_users',
    },
    identitySelection,
    platforms: snapshot(['platform'], [
      { dimensions: { platform: 'web' }, value: 124 },
    ]),
    surfaces: snapshot(['projectSurface'], []),
    dailyActivity: snapshot(['day'], []),
  });

  assert.equal(brief.activity.uniqueUsers, 3);
  assert.equal(brief.activity.uniqueUsersSemantics.verifiedPersonLevel, false);
  assert.deepEqual(
    brief.activity.uniqueUsersSemantics.excludedAggregateEventNames,
    ['landing_page_view', 'aggregate:pricing_view'],
  );
  assert.ok(
    brief.findings.some((finding) => finding.code === 'AGGREGATE_IDENTITY_EXCLUDED'),
  );
});
