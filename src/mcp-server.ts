import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  compileAgentBrief,
  selectAgentBriefIdentityEvents,
  type AgentBriefFocus,
  type GenericQuerySnapshot,
  type SchemaEventSummary,
} from './agent-brief.js';
import { CLI_VERSION } from './constants.js';
import { requestApi } from './http.js';
import { resolveProjectId } from './project-selection.js';

type McpServerOptions = {
  apiUrl?: string;
  token?: string;
  rootProjectId?: string;
  maxToolCalls: number;
};

type ApiOptions = {
  apiUrl?: string;
  token?: string;
};

const projectIdSchema = z.string().uuid().optional().describe(
  'Project UUID. When omitted, the locally selected AnalyticsCLI project is used.',
);
const durationSchema = z.string().regex(/^[1-9][0-9]*[mhd]$/).default('14d');
const dataModeSchema = z.enum(['release', 'debug']).default('release');
const genericMetricSchema = z.enum(['event_count', 'unique_sessions', 'unique_users']);
const genericDimensionSchema = z.enum([
  'eventName',
  'platform',
  'projectSurface',
  'appVersion',
  'utmSource',
  'utmMedium',
  'utmCampaign',
  'referrerHost',
  'landingPath',
  'country',
  'runtimeEnv',
  'day',
  'hour',
]);

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};

const toolSuccess = (
  result: unknown,
  meta: {
    tool: string;
    call: number;
    maxToolCalls: number;
    projectId?: string;
    dataMode?: 'release' | 'debug';
  },
) => {
  const structured = {
    result,
    meta: {
      ...meta,
      readOnly: true,
      generatedAt: new Date().toISOString(),
    },
  };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
};

const toolError = (error: unknown) => ({
  content: [{ type: 'text' as const, text: toErrorMessage(error) }],
  isError: true,
});

const validateBriefDuration = (last: string): string => {
  const match = /^([1-9][0-9]*)([mhd])$/.exec(last);
  if (!match) {
    throw new Error('last must be a duration such as 24h, 7d, or 30d');
  }
  const amount = Number(match[1]);
  const unit = match[2];
  const minutes = unit === 'd' ? amount * 1440 : unit === 'h' ? amount * 60 : amount;
  if (minutes > 31 * 1440) {
    throw new Error('Agent brief and schema discovery are bounded to a maximum 31-day lookback');
  }
  return last;
};

const loadAgentBrief = async (input: {
  apiOptions: ApiOptions;
  projectId: string;
  last: string;
  focus: AgentBriefFocus;
  dataMode: 'release' | 'debug';
  limit: number;
  funnel?: string[];
  retentionAnchor?: string;
  retentionActive?: string;
  retentionDays: number[];
}): Promise<ReturnType<typeof compileAgentBrief>> => {
  const includeDebug = input.dataMode === 'debug';
  const genericBody = (
    metric: 'event_count' | 'unique_users',
    groupBy: string[],
    eventNames?: string[],
  ) => ({
    projectId: input.projectId,
    metric,
    groupBy,
    limit: input.limit,
    orderBy: groupBy.includes('day') ? 'dimension_asc' : 'value_desc',
    last: input.last,
    includeDebug,
    ...(eventNames && eventNames.length > 0
      ? { filters: { eventNames } }
      : {}),
  });
  const schemaQuery = new URLSearchParams({
    projectId: input.projectId,
    limit: String(input.limit),
    last: input.last,
    includeDebug: String(includeDebug),
    orderBy: 'event_count_desc',
  });

  const schemaPayload = await requestApi(
    'GET',
    `/v1/schema/events?${schemaQuery.toString()}`,
    undefined,
    input.apiOptions,
  );
  const schemaEvents = (schemaPayload as { items?: SchemaEventSummary[] }).items ?? [];
  const identitySelection = selectAgentBriefIdentityEvents(schemaEvents);

  const [
    eventCounts,
    uniqueUsers,
    platforms,
    surfaces,
    dailyActivity,
    activationFunnel,
    retention,
  ] = await Promise.all([
    requestApi(
      'POST',
      '/v1/query/generic',
      genericBody('event_count', []),
      input.apiOptions,
    ),
    identitySelection.eventNames.length > 0
      ? requestApi(
          'POST',
          '/v1/query/generic',
          genericBody('unique_users', [], identitySelection.eventNames),
          input.apiOptions,
        )
      : Promise.resolve(undefined),
    requestApi(
      'POST',
      '/v1/query/generic',
      genericBody('event_count', ['platform']),
      input.apiOptions,
    ),
    requestApi(
      'POST',
      '/v1/query/generic',
      genericBody('event_count', ['projectSurface']),
      input.apiOptions,
    ),
    requestApi(
      'POST',
      '/v1/query/generic',
      genericBody('event_count', ['day']),
      input.apiOptions,
    ),
    input.funnel
      ? requestApi(
          'POST',
          '/v1/query/funnel',
          {
            projectId: input.projectId,
            steps: input.funnel,
            within: 'user',
            last: input.last,
            includeDebug,
          },
          input.apiOptions,
        )
      : Promise.resolve(undefined),
    input.retentionAnchor
      ? requestApi(
          'POST',
          '/v1/query/retention',
          {
            projectId: input.projectId,
            anchorEvent: input.retentionAnchor,
            activeEvent: input.retentionActive,
            days: input.retentionDays,
            maxAgeDays: Math.max(...input.retentionDays),
            identityQuality: 'stable',
            last: input.last,
            includeDebug,
          },
          input.apiOptions,
        )
      : Promise.resolve(undefined),
  ]);
  const eventCountSnapshot = eventCounts as GenericQuerySnapshot;
  const uniqueUserSnapshot = uniqueUsers === undefined
    ? {
        ...eventCountSnapshot,
        metric: 'unique_users',
        groupBy: [],
        rows: [{ dimensions: {}, value: 0 }],
      }
    : uniqueUsers as GenericQuerySnapshot;

  return compileAgentBrief({
    projectId: input.projectId,
    requestedRange: input.last,
    requestedFocus: input.focus,
    includeDebug,
    schemaEvents,
    eventCounts: eventCountSnapshot,
    uniqueUsers: uniqueUserSnapshot,
    identitySelection,
    platforms: platforms as GenericQuerySnapshot,
    surfaces: surfaces as GenericQuerySnapshot,
    dailyActivity: dailyActivity as GenericQuerySnapshot,
    activationFunnel,
    retention,
  });
};

export const createAnalyticsMcpServer = (options: McpServerOptions): McpServer => {
  const server = new McpServer(
    {
      name: 'analyticscli',
      version: CLI_VERSION,
    },
    {
      instructions: [
        'AnalyticsCLI exposes read-only, project-scoped, time-bounded product analytics.',
        'Start with analytics_agent_brief or analytics_schema_events.',
        'Never interpret privacy-safe aggregate pageviews as people or retention identities.',
        'Keep Release and Debug data separate and cite the returned query plan/data-quality warnings.',
      ].join(' '),
    },
  );
  const apiOptions = {
    apiUrl: options.apiUrl,
    token: options.token,
  };
  let toolCalls = 0;

  const beginToolCall = (tool: string): { tool: string; call: number; maxToolCalls: number } => {
    toolCalls += 1;
    if (toolCalls > options.maxToolCalls) {
      throw new Error(
        `MCP query budget exhausted (${options.maxToolCalls} tool calls). Restart the server to begin a new bounded session.`,
      );
    }
    return {
      tool,
      call: toolCalls,
      maxToolCalls: options.maxToolCalls,
    };
  };

  const resolveScopedProject = async (explicitProjectId?: string): Promise<string> => {
    const resolved = await resolveProjectId({
      explicitProjectId,
      rootProjectId: options.rootProjectId,
      apiUrl: options.apiUrl,
      token: options.token,
      allowInteractiveSelection: false,
    });
    return resolved.projectId;
  };

  server.registerTool(
    'analytics_projects_list',
    {
      title: 'List AnalyticsCLI projects',
      description: 'List projects visible to the configured read-only token.',
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        const meta = beginToolCall('analytics_projects_list');
        const result = await requestApi('GET', '/v1/projects', undefined, apiOptions);
        return toolSuccess(result, meta);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'analytics_schema_events',
    {
      title: 'Discover event schema',
      description:
        'Discover bounded event names, counts, freshness, and property keys before constructing a query.',
      inputSchema: z.object({
        projectId: projectIdSchema,
        last: durationSchema,
        dataMode: dataModeSchema,
        limit: z.number().int().min(1).max(100).default(50),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ projectId: explicitProjectId, last, dataMode, limit }) => {
      try {
        const meta = beginToolCall('analytics_schema_events');
        const projectId = await resolveScopedProject(explicitProjectId);
        const boundedLast = validateBriefDuration(last);
        const query = new URLSearchParams({
          projectId,
          last: boundedLast,
          limit: String(limit),
          includeDebug: String(dataMode === 'debug'),
          orderBy: 'event_count_desc',
        });
        const result = await requestApi(
          'GET',
          `/v1/schema/events?${query.toString()}`,
          undefined,
          apiOptions,
        );
        return toolSuccess(result, { ...meta, projectId, dataMode });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'analytics_agent_brief',
    {
      title: 'Compile agent product brief',
      description:
        'Compile a bounded, evidence-first brief with freshness, activity, taxonomy, instrumentation gaps, optional activation funnel, optional stable-identity retention, and reproducible follow-up commands.',
      inputSchema: z.object({
        projectId: projectIdSchema,
        last: durationSchema,
        dataMode: dataModeSchema,
        focus: z.enum(['auto', 'mobile', 'web', 'all']).default('auto'),
        limit: z.number().int().min(1).max(100).default(25),
        funnel: z.array(z.string().min(1).max(100)).min(2).max(10).optional(),
        retentionAnchor: z.string().min(1).max(100).optional(),
        retentionActive: z.string().min(1).max(100).optional(),
        retentionDays: z.array(z.number().int().min(1).max(365)).min(1).max(10).default([1, 7, 30]),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({
      projectId: explicitProjectId,
      last,
      dataMode,
      focus,
      limit,
      funnel,
      retentionAnchor,
      retentionActive,
      retentionDays,
    }) => {
      try {
        const meta = beginToolCall('analytics_agent_brief');
        const projectId = await resolveScopedProject(explicitProjectId);
        const result = await loadAgentBrief({
          apiOptions,
          projectId,
          last: validateBriefDuration(last),
          focus,
          dataMode,
          limit,
          funnel,
          retentionAnchor,
          retentionActive,
          retentionDays,
        });
        return toolSuccess(result, { ...meta, projectId, dataMode });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'analytics_funnel',
    {
      title: 'Query conversion funnel',
      description:
        'Measure an explicit ordered sequence of 2–10 known events within a bounded session or user scope.',
      inputSchema: z.object({
        projectId: projectIdSchema,
        steps: z.array(z.string().min(1).max(100)).min(2).max(10),
        within: z.enum(['session', 'user']).default('session'),
        last: durationSchema.default('30d'),
        dataMode: dataModeSchema,
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ projectId: explicitProjectId, steps, within, last, dataMode }) => {
      try {
        const meta = beginToolCall('analytics_funnel');
        const projectId = await resolveScopedProject(explicitProjectId);
        const result = await requestApi(
          'POST',
          '/v1/query/funnel',
          {
            projectId,
            steps,
            within,
            last,
            includeDebug: dataMode === 'debug',
          },
          apiOptions,
        );
        return toolSuccess(result, { ...meta, projectId, dataMode });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'analytics_retention',
    {
      title: 'Query cohort retention',
      description:
        'Measure bounded retention from an explicit anchor. Stable identity is the default and quality warnings must be preserved.',
      inputSchema: z.object({
        projectId: projectIdSchema,
        anchorEvent: z.string().min(1).max(100),
        activeEvent: z.string().min(1).max(100).optional(),
        days: z.array(z.number().int().min(1).max(365)).min(1).max(30).default([1, 7, 30]),
        identityQuality: z.enum(['stable', 'all']).default('stable'),
        last: durationSchema.default('30d'),
        dataMode: dataModeSchema,
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({
      projectId: explicitProjectId,
      anchorEvent,
      activeEvent,
      days,
      identityQuality,
      last,
      dataMode,
    }) => {
      try {
        const meta = beginToolCall('analytics_retention');
        const projectId = await resolveScopedProject(explicitProjectId);
        const result = await requestApi(
          'POST',
          '/v1/query/retention',
          {
            projectId,
            anchorEvent,
            activeEvent,
            days,
            maxAgeDays: Math.max(...days),
            identityQuality,
            last,
            includeDebug: dataMode === 'debug',
          },
          apiOptions,
        );
        return toolSuccess(result, { ...meta, projectId, dataMode });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'analytics_generic_query',
    {
      title: 'Run bounded analytics query',
      description:
        'Run a policy-limited grouped query over documented dimensions. Raw SQL and arbitrary property access are not exposed.',
      inputSchema: z.object({
        projectId: projectIdSchema,
        metric: genericMetricSchema.default('event_count'),
        groupBy: z.array(genericDimensionSchema).max(3).default([]),
        eventNames: z.array(z.string().min(1).max(100)).min(1).max(50).optional(),
        platforms: z.array(z.string().min(1).max(64)).min(1).max(20).optional(),
        projectSurfaces: z.array(z.string().min(1).max(64)).min(1).max(20).optional(),
        countries: z.array(z.string().min(1).max(16)).min(1).max(20).optional(),
        last: durationSchema,
        dataMode: dataModeSchema,
        limit: z.number().int().min(1).max(100).default(50),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({
      projectId: explicitProjectId,
      metric,
      groupBy,
      eventNames,
      platforms,
      projectSurfaces,
      countries,
      last,
      dataMode,
      limit,
    }) => {
      try {
        const meta = beginToolCall('analytics_generic_query');
        const projectId = await resolveScopedProject(explicitProjectId);
        const filters = {
          ...(eventNames ? { eventNames } : {}),
          ...(platforms ? { platforms } : {}),
          ...(projectSurfaces ? { projectSurfaces } : {}),
          ...(countries ? { countries } : {}),
        };
        const result = await requestApi(
          'POST',
          '/v1/query/generic',
          {
            projectId,
            metric,
            groupBy,
            last,
            includeDebug: dataMode === 'debug',
            limit,
            orderBy: groupBy.includes('day') || groupBy.includes('hour')
              ? 'dimension_asc'
              : 'value_desc',
            ...(Object.keys(filters).length > 0 ? { filters } : {}),
          },
          apiOptions,
        );
        return toolSuccess(result, { ...meta, projectId, dataMode });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
};

export const startAnalyticsMcpServer = async (options: McpServerOptions): Promise<void> => {
  const server = createAnalyticsMcpServer(options);
  const transport = new StdioServerTransport();
  const shutdown = async () => {
    await server.close();
  };
  process.once('SIGINT', () => {
    void shutdown().finally(() => {
      process.exit(0);
    });
  });
  process.once('SIGTERM', () => {
    void shutdown().finally(() => {
      process.exit(0);
    });
  });
  await server.connect(transport);
};
