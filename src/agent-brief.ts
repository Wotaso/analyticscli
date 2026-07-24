export type AgentBriefFocus = 'auto' | 'mobile' | 'web' | 'all';

export type SchemaEventSummary = {
  eventName: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  properties: string[];
};

export type GenericQueryRow = {
  dimensions: Record<string, string>;
  value: number;
};

export type GenericQuerySnapshot = {
  metric: string;
  groupBy: string[];
  rows: GenericQueryRow[];
  timeRange: {
    since: string;
    until: string;
  };
  plan?: {
    mode?: string;
    source?: string;
    sourceUsed?: string;
    estimatedCost?: string;
    reason?: string;
  };
};

export type AgentBriefIdentitySelection = {
  eventNames: string[];
  excludedAggregateEventNames: string[];
  truncated: boolean;
};

export type AgentBriefFinding = {
  severity: 'critical' | 'warning' | 'info';
  code: string;
  title: string;
  evidence: string;
  recommendation: string;
};

export type AgentBrief = {
  kind: 'analyticscli.agent-brief';
  version: 1;
  generatedAt: string;
  projectId: string;
  dataMode: 'release' | 'debug';
  focus: Exclude<AgentBriefFocus, 'auto'>;
  requestedRange: string;
  observedRange: {
    since: string;
    until: string;
  };
  freshness: {
    latestEventAt: string | null;
    ageHours: number | null;
    status: 'fresh' | 'delayed' | 'stale' | 'empty';
  };
  activity: {
    eventCount: number;
    uniqueUsers: number;
    uniqueUsersSemantics: {
      label: 'unique_user_keys';
      scope: 'non_aggregate_discovered_events';
      verifiedPersonLevel: false;
      eventNames: string[];
      excludedAggregateEventNames: string[];
      selectionTruncated: boolean;
    };
    previousHalfEventCount: number;
    recentHalfEventCount: number;
    changePercent: number | null;
  };
  topEvents: SchemaEventSummary[];
  platforms: GenericQueryRow[];
  surfaces: GenericQueryRow[];
  dailyActivity: GenericQueryRow[];
  instrumentation: {
    detectedCapabilities: string[];
    missingCapabilities: string[];
    propertyCoverage: {
      runtimeEnv: boolean;
      appVersion: boolean;
      projectSurface: boolean;
      acquisition: boolean;
      revenue: boolean;
    };
  };
  activationFunnel?: unknown;
  retention?: unknown;
  findings: AgentBriefFinding[];
  recommendedQueries: string[];
  evidence: Array<{
    endpoint: string;
    purpose: string;
  }>;
  guardrails: string[];
};

const MOBILE_PLATFORM_PATTERN = /^(ios|android|react[-_ ]?native|expo)$/i;
const WEB_PLATFORM_PATTERN = /^(web|browser)$/i;
const MAX_IDENTITY_EVENT_NAMES = 50;

const isPrivacySafeAggregateEventName = (eventName: string): boolean => {
  const normalized = eventName.trim().toLowerCase();
  return normalized === 'landing_page_view' || normalized.startsWith('aggregate:');
};

export const selectAgentBriefIdentityEvents = (
  events: SchemaEventSummary[],
): AgentBriefIdentitySelection => {
  const uniqueEventNames = Array.from(new Set(
    events
      .map((event) => event.eventName.trim())
      .filter(Boolean),
  ));
  const excludedAggregateEventNames = uniqueEventNames
    .filter(isPrivacySafeAggregateEventName);
  const eligibleEventNames = uniqueEventNames
    .filter((eventName) => !isPrivacySafeAggregateEventName(eventName));

  return {
    eventNames: eligibleEventNames.slice(0, MAX_IDENTITY_EVENT_NAMES),
    excludedAggregateEventNames,
    truncated: eligibleEventNames.length > MAX_IDENTITY_EVENT_NAMES,
  };
};

const CAPABILITY_PATTERNS: Array<{
  name: string;
  pattern: RegExp;
}> = [
  { name: 'acquisition', pattern: /(landing|page)[_:-]?(view|visit)|utm|campaign|signup[_:-]?initiated/i },
  { name: 'activation', pattern: /onboarding|signup|project[_:-]?created|first[_:-]?(event|query|value)/i },
  { name: 'engagement', pattern: /screen|feature|action|session|app[_:-]?open|dashboard[_:-]?page/i },
  { name: 'monetization', pattern: /paywall|purchase|subscription|checkout|revenue|trial/i },
  { name: 'reliability', pattern: /crash|error|exception|failure|failed|sentry/i },
  { name: 'feedback', pattern: /feedback|survey|rating|review|nps/i },
  { name: 'agent-usage', pattern: /agent|cli[_:]|tool[_:-]?call|model[_:-]?run|prompt/i },
  { name: 'release-impact', pattern: /release|deploy|build|version|experiment|variant/i },
];

const REQUIRED_BY_FOCUS: Record<Exclude<AgentBriefFocus, 'auto'>, string[]> = {
  mobile: ['activation', 'engagement', 'monetization', 'reliability'],
  web: ['acquisition', 'activation', 'engagement'],
  all: ['acquisition', 'activation', 'engagement', 'monetization', 'reliability'],
};

const parseTimestamp = (value: string | undefined): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  const utcParsed = Date.parse(`${value.replace(' ', 'T')}Z`);
  return Number.isFinite(utcParsed) ? utcParsed : null;
};

const round = (value: number, digits = 2): number =>
  Number(value.toFixed(digits));

const inferFocus = (
  requested: AgentBriefFocus,
  platformRows: GenericQueryRow[],
): Exclude<AgentBriefFocus, 'auto'> => {
  if (requested !== 'auto') return requested;

  const platforms = platformRows
    .map((row) => row.dimensions.platform ?? '')
    .filter((value) => value && value !== '(unknown)');
  const hasMobile = platforms.some((platform) => MOBILE_PLATFORM_PATTERN.test(platform));
  const hasWeb = platforms.some((platform) => WEB_PLATFORM_PATTERN.test(platform));

  if (hasMobile && hasWeb) return 'all';
  if (hasMobile) return 'mobile';
  if (hasWeb) return 'web';
  return 'all';
};

const totalRows = (snapshot: GenericQuerySnapshot): number =>
  snapshot.rows.reduce((sum, row) => sum + (Number.isFinite(row.value) ? row.value : 0), 0);

const propertyCoverage = (events: SchemaEventSummary[]) => {
  const properties = new Set(events.flatMap((event) => event.properties ?? []));
  return {
    runtimeEnv: properties.has('runtimeEnv'),
    appVersion: events.some((event) => event.properties.includes('appVersion')),
    projectSurface: events.some((event) => event.properties.includes('projectSurface')),
    acquisition: [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'referrer',
      'referrer_host',
      'landing_path',
    ].some((property) => properties.has(property)),
    revenue: [
      'price',
      'amount',
      'currency',
      'productId',
      'revenue',
      'transactionId',
    ].some((property) => properties.has(property)),
  };
};

const buildRecommendedQueries = (input: {
  projectId: string;
  last: string;
  events: SchemaEventSummary[];
  detectedCapabilities: string[];
}): string[] => {
  const quote = (value: string): string => JSON.stringify(value);
  const names = new Set(input.events.map((event) => event.eventName));
  const commands = [
    `analyticscli --format json schema events --project ${input.projectId} --last ${input.last} --limit 100`,
    `analyticscli --format json generic --project ${input.projectId} --metric event_count --group-by eventName --last ${input.last} --limit 50`,
  ];

  const funnelCandidates = [
    ['landing_page_view', 'signup_initiated', 'auth_signup_succeeded'],
    ['app_open', 'onboarding:start', 'onboarding:complete'],
    ['onboarding:start', 'paywall:viewed', 'purchase:completed'],
  ];
  const funnel = funnelCandidates
    .map((candidate) => candidate.filter((eventName) => names.has(eventName)))
    .find((candidate) => candidate.length >= 2);
  if (funnel) {
    commands.push(
      `analyticscli --format json funnel --project ${input.projectId} --steps ${quote(funnel.join(','))} --within user --last ${input.last}`,
    );
  }

  if (input.detectedCapabilities.includes('acquisition')) {
    commands.push(
      `analyticscli --format json acquisition --project ${input.projectId} --last ${input.last}`,
    );
  }

  const retentionAnchor = ['onboarding:start', 'signup_completed', 'app_open']
    .find((eventName) => names.has(eventName));
  if (retentionAnchor) {
    commands.push(
      `analyticscli --format json retention --project ${input.projectId} --anchor-event ${quote(retentionAnchor)} --days 1,7,30 --identity-quality stable --last ${input.last}`,
    );
  }

  return commands;
};

export const compileAgentBrief = (input: {
  projectId: string;
  requestedRange: string;
  requestedFocus: AgentBriefFocus;
  includeDebug: boolean;
  now?: Date;
  schemaEvents: SchemaEventSummary[];
  eventCounts: GenericQuerySnapshot;
  uniqueUsers: GenericQuerySnapshot;
  identitySelection: AgentBriefIdentitySelection;
  platforms: GenericQuerySnapshot;
  surfaces: GenericQuerySnapshot;
  dailyActivity: GenericQuerySnapshot;
  activationFunnel?: unknown;
  retention?: unknown;
}): AgentBrief => {
  const now = input.now ?? new Date();
  const focus = inferFocus(input.requestedFocus, input.platforms.rows);
  const eventNames = input.schemaEvents.map((event) => event.eventName);
  const detectedCapabilities = CAPABILITY_PATTERNS
    .filter(({ pattern }) => eventNames.some((eventName) => pattern.test(eventName)))
    .map(({ name }) => name);
  const requiredCapabilities = REQUIRED_BY_FOCUS[focus];
  const missingCapabilities = requiredCapabilities.filter(
    (capability) => !detectedCapabilities.includes(capability),
  );
  const coverage = propertyCoverage(input.schemaEvents);

  const latestTimestamp = input.schemaEvents
    .map((event) => parseTimestamp(event.lastSeen))
    .filter((value): value is number => value !== null)
    .sort((left, right) => right - left)[0] ?? null;
  const ageHours = latestTimestamp === null
    ? null
    : Math.max(0, (now.getTime() - latestTimestamp) / (60 * 60 * 1000));
  const freshnessStatus: AgentBrief['freshness']['status'] =
    ageHours === null ? 'empty' : ageHours <= 6 ? 'fresh' : ageHours <= 24 ? 'delayed' : 'stale';

  const dailyRows = [...input.dailyActivity.rows].sort((left, right) =>
    (left.dimensions.day ?? '').localeCompare(right.dimensions.day ?? ''),
  );
  const splitIndex = Math.max(1, Math.floor(dailyRows.length / 2));
  const previousHalfEventCount = dailyRows
    .slice(0, splitIndex)
    .reduce((sum, row) => sum + row.value, 0);
  const recentHalfEventCount = dailyRows
    .slice(splitIndex)
    .reduce((sum, row) => sum + row.value, 0);
  const changePercent =
    previousHalfEventCount <= 0
      ? recentHalfEventCount > 0
        ? 100
        : null
      : round(((recentHalfEventCount - previousHalfEventCount) / previousHalfEventCount) * 100);

  const findings: AgentBriefFinding[] = [];
  if (freshnessStatus === 'empty') {
    findings.push({
      severity: 'critical',
      code: 'NO_RELEASE_EVENTS',
      title: 'No events are visible in the selected data mode',
      evidence: `Schema discovery returned 0 events for ${input.requestedRange}.`,
      recommendation: 'Validate the publishable key, runtimeEnv, collector response, and Debug/Release selection before drawing product conclusions.',
    });
  } else if (freshnessStatus === 'stale') {
    findings.push({
      severity: 'critical',
      code: 'STALE_INGESTION',
      title: 'The latest event is stale',
      evidence: `Latest event is ${round(ageHours ?? 0, 1)} hours old.`,
      recommendation: 'Check SDK delivery, app release traffic, collector health, and ingest alerts before acting on trends.',
    });
  } else if (freshnessStatus === 'delayed') {
    findings.push({
      severity: 'warning',
      code: 'DELAYED_INGESTION',
      title: 'Event freshness is delayed',
      evidence: `Latest event is ${round(ageHours ?? 0, 1)} hours old.`,
      recommendation: 'Confirm whether this matches expected traffic and release cadence.',
    });
  }

  if (missingCapabilities.length > 0) {
    findings.push({
      severity: 'warning',
      code: 'INSTRUMENTATION_GAPS',
      title: 'The event taxonomy cannot answer all core product questions',
      evidence: `Missing ${missingCapabilities.join(', ')} coverage for focus=${focus}.`,
      recommendation: 'Add outcome-oriented events for the missing lifecycle stages, then verify them in Debug before relying on Release analysis.',
    });
  }

  if (!coverage.runtimeEnv) {
    findings.push({
      severity: 'warning',
      code: 'MISSING_RUNTIME_ENV',
      title: 'Release and debug traffic may be hard to separate',
      evidence: 'No discovered event exposes runtimeEnv in the selected window.',
      recommendation: 'Upgrade the SDK or add runtimeEnv consistently while preserving existing event names.',
    });
  }

  if (focus !== 'mobile' && detectedCapabilities.includes('acquisition') && !coverage.acquisition) {
    findings.push({
      severity: 'warning',
      code: 'MISSING_ACQUISITION_CONTEXT',
      title: 'Acquisition events lack campaign or referrer context',
      evidence: 'Acquisition-like events exist, but no UTM, referrer, or landing-path properties were discovered.',
      recommendation: 'Capture privacy-safe first-touch acquisition fields and verify referrer_host plus landing_path in the schema.',
    });
  }

  if (detectedCapabilities.includes('monetization') && !coverage.revenue) {
    findings.push({
      severity: 'warning',
      code: 'MISSING_REVENUE_CONTEXT',
      title: 'Monetization events lack normalized revenue properties',
      evidence: 'Paywall/purchase/subscription events exist without discovered price, currency, product, or revenue properties.',
      recommendation: 'Add normalized productId, amount, currency, and transaction outcome fields; do not send raw receipt payloads.',
    });
  }

  const totalEventCount = totalRows(input.eventCounts);
  const uniqueUserCount = totalRows(input.uniqueUsers);
  if (input.identitySelection.excludedAggregateEventNames.length > 0) {
    findings.push({
      severity: 'info',
      code: 'AGGREGATE_IDENTITY_EXCLUDED',
      title: 'Privacy-safe aggregate events were excluded from the identity metric',
      evidence:
        `${input.identitySelection.excludedAggregateEventNames.join(', ')} use event-scoped ` +
        'identities, so their pageviews are not counted as unique-user keys.',
      recommendation:
        'Use event_count for these aggregate events and reserve user funnels or retention for stable, consent-compatible identities.',
    });
  }

  if (input.identitySelection.truncated) {
    findings.push({
      severity: 'warning',
      code: 'IDENTITY_EVENT_SCOPE_TRUNCATED',
      title: 'The unique-user-key scope reached its event-name safety limit',
      evidence:
        `The identity query was limited to the first ${MAX_IDENTITY_EVENT_NAMES} ` +
        'non-aggregate event names discovered in the bounded schema window.',
      recommendation:
        'Query a smaller explicit set of lifecycle events before interpreting identity coverage.',
    });
  }

  if (totalEventCount > 0 && uniqueUserCount === 0) {
    findings.push({
      severity: 'warning',
      code: 'IDENTITY_NOT_MEASURABLE',
      title: 'User-level metrics are not currently measurable',
      evidence:
        `${totalEventCount} events were observed while the unique-user-key query across ` +
        `${input.identitySelection.eventNames.length} non-aggregate event names returned 0.`,
      recommendation: 'Review consent, stable anonymous identity, and identify() placement before using retention or user funnels.',
    });
  }

  if (findings.length === 0) {
    findings.push({
      severity: 'info',
      code: 'CONTEXT_HEALTHY',
      title: 'No blocking data-quality issue was detected',
      evidence: `${totalEventCount} events across ${input.schemaEvents.length} discovered event names.`,
      recommendation: 'Use the suggested bounded queries to validate the next product hypothesis.',
    });
  }

  return {
    kind: 'analyticscli.agent-brief',
    version: 1,
    generatedAt: now.toISOString(),
    projectId: input.projectId,
    dataMode: input.includeDebug ? 'debug' : 'release',
    focus,
    requestedRange: input.requestedRange,
    observedRange: input.eventCounts.timeRange,
    freshness: {
      latestEventAt: latestTimestamp === null ? null : new Date(latestTimestamp).toISOString(),
      ageHours: ageHours === null ? null : round(ageHours, 1),
      status: freshnessStatus,
    },
    activity: {
      eventCount: totalEventCount,
      uniqueUsers: uniqueUserCount,
      uniqueUsersSemantics: {
        label: 'unique_user_keys',
        scope: 'non_aggregate_discovered_events',
        verifiedPersonLevel: false,
        eventNames: input.identitySelection.eventNames,
        excludedAggregateEventNames: input.identitySelection.excludedAggregateEventNames,
        selectionTruncated: input.identitySelection.truncated,
      },
      previousHalfEventCount,
      recentHalfEventCount,
      changePercent,
    },
    topEvents: input.schemaEvents,
    platforms: input.platforms.rows,
    surfaces: input.surfaces.rows,
    dailyActivity: dailyRows,
    instrumentation: {
      detectedCapabilities,
      missingCapabilities,
      propertyCoverage: coverage,
    },
    ...(input.activationFunnel === undefined
      ? {}
      : { activationFunnel: input.activationFunnel }),
    ...(input.retention === undefined ? {} : { retention: input.retention }),
    findings,
    recommendedQueries: buildRecommendedQueries({
      projectId: input.projectId,
      last: input.requestedRange,
      events: input.schemaEvents,
      detectedCapabilities,
    }),
    evidence: [
      { endpoint: '/v1/schema/events', purpose: 'event taxonomy, property coverage, and freshness' },
      {
        endpoint: '/v1/query/generic',
        purpose: 'bounded event, non-aggregate actor-key, platform, surface, and daily summaries',
      },
      ...(input.activationFunnel === undefined
        ? []
        : [{ endpoint: '/v1/query/funnel', purpose: 'explicit activation sequence' }]),
      ...(input.retention === undefined
        ? []
        : [{ endpoint: '/v1/query/retention', purpose: 'explicit cohort retention' }]),
    ],
    guardrails: [
      'Release and Debug data are never mixed in this brief.',
      'Aggregate pageviews are excluded from unique-user keys; they are counts, not people.',
      'Unique-user keys are not verified people; use stable identity-quality queries for retention.',
      'Findings describe observed correlations and instrumentation quality, not causality.',
      'Every follow-up query should remain project-scoped, time-bounded, and read-only.',
    ],
  };
};
