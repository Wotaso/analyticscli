#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Command } from 'commander';
import {
  renderHorizontalBars,
  renderTable,
  renderTimeseriesSvg,
  writeSvgToFile,
} from './render.js';
import type { TimeseriesPoint } from './render.js';
import {
  CLI_ANON_ID,
  CLI_SESSION_ID,
  CLI_VERSION,
  ONBOARDING_CORE_EVENTS,
  ONBOARDING_START_EVENT,
  OPENCLAW_SKILL_PAGE_URL,
  PAYWALL_ANCHOR_EVENTS,
  PAYWALL_JOURNEY_EVENT_ORDER,
  PAYWALL_SKIP_EVENTS,
  PURCHASE_SUCCESS_EVENTS,
  SELF_TRACKING_ENABLED,
  SELF_TRACKING_ENDPOINT,
  env,
} from './constants.js';
import { configPath, persistAuthToken, readConfig, resolveAuthToken } from './config-store.js';
import {
  asTimeseriesPoints,
  computeRateTrendFromTimeseriesPoints,
  computeTrendFromTimeseriesPoints,
  formatOutput,
  formatTrendSummary,
  isOnboardingScreenEvent,
  normalizeOptionString,
  parseIntegerOption,
  parseJsonObjectOption,
  parseRetentionDaysOption,
  pickBetterAlias,
  print,
  resolveTrendInterval,
  resolveFlowSelectorOption,
  resolveProjectOption,
  toPercent,
} from './analytics-utils.js';
import {
  exchangeClerkJwtForReadonlyToken,
  mapStatusToExitCode,
  requestApi,
  requestCollect,
  requestCsvExport,
} from './http.js';
import { isCommandAvailable, openExternalUrl } from './shell.js';
import {
  maybeAutoRefreshSkills,
  parseSetupAgents,
  promptLoginMode,
  promptRequiredValue,
  promptYesNo,
  renderSetupTextSummary,
  runSetupFlow,
} from './setup.js';
import type { FlowSelectorPayload, OutputFormat, SetupAgent } from './types.js';

let activeCommandPath = 'unknown';
let activeCommandStartMs = Date.now();

const withErrorHandling = async (fn: () => Promise<void>): Promise<void> => {
  try {
    await fn();
  } catch (error) {
    const typed = error as Error & { exitCode?: number; payload?: unknown };
    await emitSelfTrackingEvent('cli:command_failed', {
      command: activeCommandPath,
      durationMs: Date.now() - activeCommandStartMs,
      exitCode: typed.exitCode ?? 4,
    });
    const payload = typed.payload ?? {
      error: {
        message: typed.message,
      },
    };

    process.stderr.write(`${JSON.stringify(payload)}\n`);
    process.exitCode = typed.exitCode ?? 4;
  }
};

const resolveCommandPath = (command: Command): string => {
  const names: string[] = [];
  let cursor: Command | null = command;

  while (cursor) {
    const name = cursor.name();
    if (name && name !== 'prodinfos') {
      names.unshift(name);
    }
    cursor = cursor.parent ?? null;
  }

  return names.join(' ') || 'unknown';
};

const emitSelfTrackingEvent = async (
  eventName: string,
  properties: Record<string, unknown>,
): Promise<void> => {
  if (!SELF_TRACKING_ENABLED) {
    return;
  }

  try {
    await fetch(`${SELF_TRACKING_ENDPOINT}/v1/collect`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': String(env.PRODINFOS_SELF_TRACKING_API_KEY),
      },
      body: JSON.stringify({
        projectId: String(env.PRODINFOS_SELF_TRACKING_PROJECT_ID),
        sentAt: new Date().toISOString(),
        events: [
          {
            eventId: `${eventName}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
            eventName,
            ts: new Date().toISOString(),
            sessionId: CLI_SESSION_ID,
            anonId: CLI_ANON_ID,
            properties: {
              ...properties,
              platform: env.PRODINFOS_SELF_TRACKING_PLATFORM,
              nodeVersion: process.version,
              cliVersion: CLI_VERSION,
            },
            platform: env.PRODINFOS_SELF_TRACKING_PLATFORM,
            appVersion: CLI_VERSION,
            type: 'track',
          },
        ],
      }),
    });
  } catch {
    // Self-tracking must never break CLI behavior.
  }
};

const includeDebugFlag = (): boolean => {
  const root = program.opts<{ includeDebug?: boolean }>();
  return Boolean(root.includeDebug);
};

const program = new Command();
program
  .name('prodinfos')
  .description('Agent-friendly Prodinfos CLI')
  .option('--api-url <url>', 'API base URL')
  .option('--token <token>', 'Override auth token for this call')
  .option('--format <format>', 'Output format json|text', 'json')
  .option('--include-debug', 'Include development/debug events in query/export commands', false)
  .option('--quiet', 'Reduce text output noise', false);

program.hook('preAction', async (_thisCommand, actionCommand) => {
  activeCommandPath = resolveCommandPath(actionCommand);
  activeCommandStartMs = Date.now();
  await maybeAutoRefreshSkills(activeCommandPath).catch(() => {
    // Auto-refresh is best effort.
  });
  await emitSelfTrackingEvent('cli:command_started', {
    command: activeCommandPath,
  });
});

program.hook('postAction', async (_thisCommand, actionCommand) => {
  await emitSelfTrackingEvent('cli:command_succeeded', {
    command: resolveCommandPath(actionCommand),
    durationMs: Date.now() - activeCommandStartMs,
  });
});

program
  .command('login')
  .description('Store CLI token or exchange Clerk JWT for a readonly token')
  .option('--token <token>', 'Direct readonly token')
  .option('--clerk-jwt <jwt>', 'Clerk JWT to exchange')
  .action(async (options: { token?: string; clerkJwt?: string }) => {
    await withErrorHandling(async () => {
      const root = program.opts<{
        apiUrl?: string;
        format: OutputFormat;
      }>();

      const config = await readConfig();
      const apiUrl = (root.apiUrl ?? config.apiUrl).replace(/\/$/, '');

      if (!options.token && !options.clerkJwt) {
        throw Object.assign(new Error('Provide --token or --clerk-jwt'), { exitCode: 2 });
      }

      const now = new Date().toISOString();

      if (options.token) {
        const persisted = await persistAuthToken(config, apiUrl, options.token);

        print(root.format, {
          ok: true,
          mode: 'direct_token',
          tokenStorage: persisted.storage,
          configPath,
          updatedAt: now,
        });
        return;
      }

      const exchanged = await exchangeClerkJwtForReadonlyToken(apiUrl, String(options.clerkJwt));
      const persisted = await persistAuthToken(config, apiUrl, exchanged.token);

      print(root.format, {
        ok: true,
        mode: 'clerk_exchange',
        tokenStorage: persisted.storage,
        configPath,
        tenantId: exchanged.tenantId,
        projectIds: exchanged.projectIds,
        updatedAt: now,
      });
    });
  });

program
  .command('setup')
  .description('One-time setup: install skills, login, and enable optional auto skill refresh')
  .option('--token <token>', 'Readonly token for login')
  .option('--clerk-jwt <jwt>', 'Clerk JWT to exchange for a readonly token')
  .option('--skip-login', 'Skip login step', false)
  .option('--skip-skills', 'Skip skill installation step', false)
  .option('--agents <targets>', 'all|codex|claude|openclaw (comma-separated)', 'all')
  .option('--no-auto-skill-update', 'Disable daily skill refresh on CLI execution')
  .action(
    async (options: {
      token?: string;
      clerkJwt?: string;
      skipLogin?: boolean;
      skipSkills?: boolean;
      agents?: string;
      autoSkillUpdate?: boolean;
    }) => {
      await withErrorHandling(async () => {
        const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();
        const agents = parseSetupAgents(String(options.agents ?? 'all'));
        const result = await runSetupFlow(root, {
          token: options.token,
          clerkJwt: options.clerkJwt,
          skipLogin: options.skipLogin,
          skipSkills: options.skipSkills,
          agents,
          autoSkillUpdate: options.autoSkillUpdate,
        });

        if (root.format === 'text') {
          print('text', renderSetupTextSummary('Setup complete.', result));
          return;
        }

        print(root.format, result);
      });
    },
  );

program
  .command('onboard')
  .description('Interactive onboarding: choose skill install targets and login method')
  .option('--token <token>', 'Readonly token for login')
  .option('--clerk-jwt <jwt>', 'Clerk JWT to exchange for a readonly token')
  .option('--no-auto-skill-update', 'Disable daily skill refresh on CLI execution')
  .action(
    async (options: {
      token?: string;
      clerkJwt?: string;
      autoSkillUpdate?: boolean;
    }) => {
      await withErrorHandling(async () => {
        const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();

        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          throw Object.assign(
            new Error('`onboard` requires an interactive terminal. Use `prodinfos setup` for non-interactive flows.'),
            { exitCode: 2 },
          );
        }

        const selectedAgents: SetupAgent[] = [];
        let token = options.token;
        let clerkJwt = options.clerkJwt;
        let skipLogin = false;
        let autoSkillUpdate = options.autoSkillUpdate;
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });

        try {
          process.stdout.write('Prodinfos onboarding\n');
          process.stdout.write('This flow installs skills and configures login.\n\n');

          const installCodexClaude = await promptYesNo(
            rl,
            'Install skill for Codex/Claude Code via `npx -y skills add prodinfos`?',
            true,
          );
          if (installCodexClaude) {
            selectedAgents.push('codex', 'claude');
          }

          const installOpenclaw = await promptYesNo(
            rl,
            'Install skill for OpenClaw via `openclaw skill add prodinfos`?',
            false,
          );
          if (installOpenclaw) {
            selectedAgents.push('openclaw');
            if (!isCommandAvailable('openclaw')) {
              process.stdout.write('\n`openclaw` is not installed on this machine.\n');
              const openSkillPage = await promptYesNo(
                rl,
                `Open OpenClaw skill page now (${OPENCLAW_SKILL_PAGE_URL})?`,
                true,
              );
              if (openSkillPage) {
                const openResult = openExternalUrl(OPENCLAW_SKILL_PAGE_URL);
                if (!openResult) {
                  process.stdout.write(`Could not auto-open browser. Open this URL manually: ${OPENCLAW_SKILL_PAGE_URL}\n`);
                } else if (!openResult.ok) {
                  process.stdout.write(
                    `Failed to open browser automatically. Open this URL manually: ${OPENCLAW_SKILL_PAGE_URL}\n`,
                  );
                }
              }
            }
          }

          if (!token && !clerkJwt) {
            const config = await readConfig();
            const hasExistingToken = Boolean(resolveAuthToken(config, root.token));
            const loginMode = await promptLoginMode(rl, hasExistingToken);

            if (loginMode === 'token') {
              token = await promptRequiredValue(rl, 'Enter readonly token:');
            } else if (loginMode === 'clerk') {
              clerkJwt = await promptRequiredValue(rl, 'Enter Clerk JWT:');
            } else if (loginMode === 'skip') {
              skipLogin = true;
            }
          }

          if (autoSkillUpdate !== false) {
            autoSkillUpdate = await promptYesNo(rl, 'Enable daily automatic skill refresh?', true);
          }
        } finally {
          rl.close();
        }

        const shouldSkipSkills = selectedAgents.length === 0;
        const result = await runSetupFlow(root, {
          token,
          clerkJwt,
          skipLogin,
          skipSkills: shouldSkipSkills,
          agents: shouldSkipSkills ? ['codex'] : selectedAgents,
          autoSkillUpdate,
        });

        if (root.format === 'text') {
          print('text', renderSetupTextSummary('Onboarding complete.', result));
          return;
        }

        print(root.format, result);
      });
    },
  );

const projects = program.command('projects').description('Project operations');

projects
  .command('list')
  .description('List projects in your token scope')
  .action(async () => {
    await withErrorHandling(async () => {
      const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();
      const payload = await requestApi('GET', '/v1/projects', undefined, {
        apiUrl: root.apiUrl,
        token: root.token,
      });
      print(root.format, payload);
    });
  });

projects
  .command('create')
  .description('Create a new project in your tenant')
  .requiredOption('--name <name>', 'Project name')
  .requiredOption('--slug <slug>', 'Project slug')
  .action(async (options) => {
    await withErrorHandling(async () => {
      const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();
      const payload = await requestApi(
        'POST',
        '/v1/projects',
        {
          name: options.name,
          slug: options.slug,
        },
        {
          apiUrl: root.apiUrl,
          token: root.token,
        },
      );

      const token = (payload as { token?: unknown }).token;
      if (typeof token === 'string') {
        const current = await readConfig();
        await persistAuthToken(current, (root.apiUrl ?? current.apiUrl).replace(/\/$/, ''), token);
      }

      print(root.format, payload);
    });
  });

const keys = program.command('keys').description('Project public API key helpers');

keys
  .command('list')
  .description('Show the project public API key metadata')
  .requiredOption('--project <id>', 'Project ID')
  .action(async (options) => {
    await withErrorHandling(async () => {
      const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();
      const payload = await requestApi(
        'GET',
        `/v1/projects/${encodeURIComponent(options.project)}/api-keys`,
        undefined,
        {
          apiUrl: root.apiUrl,
          token: root.token,
        },
      );
      print(root.format, payload);
    });
  });

const schema = program.command('schema').description('Data schema helpers');

schema
  .command('events')
  .description('List discovered events and known properties')
  .requiredOption('--project <id>', 'Project ID')
  .option('--limit <n>', 'Result limit', '100')
  .action(async (options) => {
    await withErrorHandling(async () => {
      const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();
      const limit = Number(options.limit);
      const qs = new URLSearchParams({
        projectId: options.project,
        limit: String(limit),
        includeDebug: String(includeDebugFlag()),
      });

      const payload = await requestApi('GET', `/v1/schema/events?${qs.toString()}`, undefined, {
        apiUrl: root.apiUrl,
        token: root.token,
      });
      print(root.format, payload);
    });
  });

const getCommand = program.command('get').description('Curated analytics snapshots');

getCommand
  .command('onboarding-journey')
  .description('Get onboarding -> paywall -> purchase journey metrics for new users')
  .requiredOption('--project <id>', 'Project ID')
  .option('--within <scope>', 'session|user', 'user')
  .option('--last <duration>', 'Time range like 30d', '30d')
  .option('--events-limit <n>', 'Schema events scan limit', '500')
  .option('--with-trends', 'Include first-vs-latest trend block for top funnel KPIs', false)
  .option('--app-version <version>', 'Filter by appVersion')
  .option('--flow-id <id>', 'Filter by onboardingFlowId')
  .option('--flow-version <version>', 'Filter by onboardingFlowVersion')
  .option('--variant <name>', 'Filter by experimentVariant (A/B variant)')
  .option('--paywall-id <id>', 'Filter by paywallId')
  .action(async (options) => {
    await withErrorHandling(async () => {
      const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();
      const flowSelection = resolveFlowSelectorOption(options).flow;
      const includeTrends = Boolean(options.withTrends);
      const trendInterval = resolveTrendInterval(String(options.last));

      const queryConversion = async (from: string, to: string) => {
        return (await requestApi(
          'POST',
          '/v1/query/conversion_after',
          {
            ...resolveProjectOption(options.project),
            from,
            to,
            within: options.within,
            last: options.last,
            includeDebug: includeDebugFlag(),
            ...(flowSelection ? { flow: flowSelection } : {}),
          },
          {
            apiUrl: root.apiUrl,
            token: root.token,
          },
        )) as {
          totalFrom: number;
          totalConverted: number;
          conversionRate: number;
        };
      };

      const trendTimeseriesCache = new Map<string, Promise<TimeseriesPoint[]>>();
      const queryUniqueUserSeries = (eventName: string) => {
        const existing = trendTimeseriesCache.get(eventName);
        if (existing) {
          return existing;
        }

        const pending = requestApi(
          'POST',
          '/v1/query/timeseries',
          {
            ...resolveProjectOption(options.project),
            metric: 'unique_users',
            event: eventName,
            interval: trendInterval,
            last: options.last,
            includeDebug: includeDebugFlag(),
            ...(flowSelection ? { flow: flowSelection } : {}),
          },
          {
            apiUrl: root.apiUrl,
            token: root.token,
          },
        ).then((payload) => asTimeseriesPoints(payload));

        trendTimeseriesCache.set(eventName, pending);
        return pending;
      };

      const schemaQuery = new URLSearchParams({
        projectId: options.project,
        limit: String(Number(options.eventsLimit)),
        includeDebug: String(includeDebugFlag()),
      });
      const schemaPayload = (await requestApi(
        'GET',
        `/v1/schema/events?${schemaQuery.toString()}`,
        undefined,
        {
          apiUrl: root.apiUrl,
          token: root.token,
        },
      )) as {
        items?: Array<{ eventName?: string }>;
      };

      const [
        completionFromStart,
        startToPaywallShown,
        startToPaywallEntry,
        startToSkipPrimary,
        startToSkipFallback,
        startToPurchasePrimary,
        startToPurchaseFallback,
      ] = await Promise.all([
        queryConversion(ONBOARDING_START_EVENT, 'onboarding:complete'),
        queryConversion(ONBOARDING_START_EVENT, PAYWALL_ANCHOR_EVENTS[0]),
        queryConversion(ONBOARDING_START_EVENT, PAYWALL_ANCHOR_EVENTS[1]),
        queryConversion(ONBOARDING_START_EVENT, PAYWALL_SKIP_EVENTS[0]),
        queryConversion(ONBOARDING_START_EVENT, PAYWALL_SKIP_EVENTS[1]),
        queryConversion(ONBOARDING_START_EVENT, PURCHASE_SUCCESS_EVENTS[0]),
        queryConversion(ONBOARDING_START_EVENT, PURCHASE_SUCCESS_EVENTS[1]),
      ]);

      const discoveredEventNames = (schemaPayload.items ?? [])
        .map((item) => (typeof item.eventName === 'string' ? item.eventName : ''))
        .filter(Boolean);

      const discoveredOnboardingScreens = discoveredEventNames
        .filter((eventName) => isOnboardingScreenEvent(eventName))
        .slice(0, 12);

      const discoveredJourneyEvents = discoveredEventNames.filter(
        (eventName) =>
          eventName.startsWith('paywall:') ||
          eventName.startsWith('subscription:') ||
          eventName === 'purchase:success' ||
          eventName === 'paywall:dismissed',
      );

      const eventCandidates = [...new Set([
        ...ONBOARDING_CORE_EVENTS,
        ...discoveredOnboardingScreens,
        ...PAYWALL_JOURNEY_EVENT_ORDER,
        ...PAYWALL_SKIP_EVENTS,
        ...PURCHASE_SUCCESS_EVENTS,
        ...discoveredJourneyEvents,
      ])].filter((eventName) => eventName !== ONBOARDING_START_EVENT);

      const eventConversions = await Promise.all(
        eventCandidates.map(async (eventName) => {
          const result = await queryConversion(ONBOARDING_START_EVENT, eventName);
          return {
            eventName,
            users: result.totalConverted,
          };
        }),
      );

      const paywallAnchorByStart =
        startToPaywallShown.totalConverted >= startToPaywallEntry.totalConverted
          ? {
              eventName: PAYWALL_ANCHOR_EVENTS[0],
              users: startToPaywallShown.totalConverted,
            }
          : {
              eventName: PAYWALL_ANCHOR_EVENTS[1],
              users: startToPaywallEntry.totalConverted,
            };

      const [
        anchorToSkipPrimary,
        anchorToSkipFallback,
        anchorToPurchasePrimary,
        anchorToPurchaseFallback,
      ] = await Promise.all([
        queryConversion(paywallAnchorByStart.eventName, PAYWALL_SKIP_EVENTS[0]),
        queryConversion(paywallAnchorByStart.eventName, PAYWALL_SKIP_EVENTS[1]),
        queryConversion(paywallAnchorByStart.eventName, PURCHASE_SUCCESS_EVENTS[0]),
        queryConversion(paywallAnchorByStart.eventName, PURCHASE_SUCCESS_EVENTS[1]),
      ]);

      const starters = completionFromStart.totalFrom;
      const bestSkipFromStart = pickBetterAlias(
        PAYWALL_SKIP_EVENTS[0],
        startToSkipPrimary.totalConverted,
        PAYWALL_SKIP_EVENTS[1],
        startToSkipFallback.totalConverted,
      );
      const bestPurchaseFromStart = pickBetterAlias(
        PURCHASE_SUCCESS_EVENTS[0],
        startToPurchasePrimary.totalConverted,
        PURCHASE_SUCCESS_EVENTS[1],
        startToPurchaseFallback.totalConverted,
      );
      const bestSkipFromPaywall = pickBetterAlias(
        PAYWALL_SKIP_EVENTS[0],
        anchorToSkipPrimary.totalConverted,
        PAYWALL_SKIP_EVENTS[1],
        anchorToSkipFallback.totalConverted,
      );
      const bestPurchaseFromPaywall = pickBetterAlias(
        PURCHASE_SUCCESS_EVENTS[0],
        anchorToPurchasePrimary.totalConverted,
        PURCHASE_SUCCESS_EVENTS[1],
        anchorToPurchaseFallback.totalConverted,
      );
      const paywallExposedUsers =
        anchorToSkipPrimary.totalFrom ||
        anchorToSkipFallback.totalFrom ||
        anchorToPurchasePrimary.totalFrom ||
        anchorToPurchaseFallback.totalFrom ||
        paywallAnchorByStart.users;

      let trends: {
        starters: ReturnType<typeof computeTrendFromTimeseriesPoints>;
        completionRate: ReturnType<typeof computeRateTrendFromTimeseriesPoints>;
        dropOffRate: ReturnType<typeof computeRateTrendFromTimeseriesPoints>;
        paywallReachedRate: ReturnType<typeof computeRateTrendFromTimeseriesPoints>;
        purchaseRate: ReturnType<typeof computeRateTrendFromTimeseriesPoints>;
      } | null = null;

      if (includeTrends) {
        const [
          startersSeries,
          completionSeries,
          paywallShownSeries,
          paywallEntrySeries,
          purchasePrimarySeries,
          purchaseFallbackSeries,
        ] = await Promise.all([
          queryUniqueUserSeries(ONBOARDING_START_EVENT),
          queryUniqueUserSeries('onboarding:complete'),
          queryUniqueUserSeries(PAYWALL_ANCHOR_EVENTS[0]),
          queryUniqueUserSeries(PAYWALL_ANCHOR_EVENTS[1]),
          queryUniqueUserSeries(PURCHASE_SUCCESS_EVENTS[0]),
          queryUniqueUserSeries(PURCHASE_SUCCESS_EVENTS[1]),
        ]);

        const selectedPaywallSeries =
          paywallAnchorByStart.eventName === PAYWALL_ANCHOR_EVENTS[0]
            ? paywallShownSeries
            : paywallEntrySeries;
        const selectedPurchaseSeries =
          bestPurchaseFromStart.eventName === PURCHASE_SUCCESS_EVENTS[0]
            ? purchasePrimarySeries
            : purchaseFallbackSeries;

        const completionByTs = new Map(completionSeries.map((point) => [point.ts, point.value] as const));
        const dropOffSeries = startersSeries.map((point) => ({
          ts: point.ts,
          value: Math.max(0, point.value - (completionByTs.get(point.ts) ?? 0)),
        }));

        trends = {
          starters: computeTrendFromTimeseriesPoints(startersSeries),
          completionRate: computeRateTrendFromTimeseriesPoints(completionSeries, startersSeries, 100),
          dropOffRate: computeRateTrendFromTimeseriesPoints(dropOffSeries, startersSeries, 100),
          paywallReachedRate: computeRateTrendFromTimeseriesPoints(
            selectedPaywallSeries,
            startersSeries,
            100,
          ),
          purchaseRate: computeRateTrendFromTimeseriesPoints(selectedPurchaseSeries, startersSeries, 100),
        };
      }

      const eventOrder = new Map<string, number>(
        [...ONBOARDING_CORE_EVENTS, ...PAYWALL_JOURNEY_EVENT_ORDER].map((eventName, index) => [
          eventName,
          index,
        ]),
      );

      const coverageRows = eventConversions
        .map((row) => ({
          eventName: row.eventName,
          users: row.users,
          percentFromStart: toPercent(row.users, starters),
        }))
        .filter((row) => row.users > 0 || eventOrder.has(row.eventName))
        .sort((a, b) => {
          const aIdx = eventOrder.get(a.eventName) ?? -1;
          const bIdx = eventOrder.get(b.eventName) ?? -1;
          const aIsOrdered = aIdx >= 0;
          const bIsOrdered = bIdx >= 0;
          if (aIsOrdered && bIsOrdered) return aIdx - bIdx;
          if (aIsOrdered) return -1;
          if (bIsOrdered) return 1;
          return b.users - a.users;
        });

      const payload = {
        projectId: options.project,
        within: options.within,
        last: options.last,
        startEvent: ONBOARDING_START_EVENT,
        flow: flowSelection ?? null,
        starters,
        completedUsers: completionFromStart.totalConverted,
        completionRate: toPercent(completionFromStart.totalConverted, starters),
        paywallAnchorEvent: paywallAnchorByStart.eventName,
        paywallReachedUsers: paywallAnchorByStart.users,
        paywallReachedRate: toPercent(paywallAnchorByStart.users, starters),
        paywallSkippedUsers: bestSkipFromStart.count,
        paywallSkipEvent: bestSkipFromStart.eventName,
        paywallSkipRateFromStart: toPercent(bestSkipFromStart.count, starters),
        paywallSkipRateFromPaywall: toPercent(bestSkipFromPaywall.count, paywallExposedUsers),
        purchasedUsers: bestPurchaseFromStart.count,
        purchaseEvent: bestPurchaseFromStart.eventName,
        purchaseRateFromStart: toPercent(bestPurchaseFromStart.count, starters),
        purchaseRateFromPaywall: toPercent(bestPurchaseFromPaywall.count, paywallExposedUsers),
        coverageRows,
        ...(includeTrends ? { trends } : {}),
      };

      if (root.format === 'text') {
        const flowSummary = flowSelection
          ? [
              flowSelection.appVersion ? `appVersion=${flowSelection.appVersion}` : null,
              flowSelection.onboardingFlowId ? `flowId=${flowSelection.onboardingFlowId}` : null,
              flowSelection.onboardingFlowVersion
                ? `flowVersion=${flowSelection.onboardingFlowVersion}`
                : null,
              flowSelection.experimentVariant ? `variant=${flowSelection.experimentVariant}` : null,
              flowSelection.paywallId ? `paywallId=${flowSelection.paywallId}` : null,
            ]
              .filter((entry): entry is string => Boolean(entry))
              .join(', ')
          : 'all';
        const summaryLines = [
          `Onboarding journey (${options.last}, within=${options.within})`,
          `flow: ${flowSummary}`,
          `starters: ${payload.starters}`,
          `completion: ${payload.completedUsers}/${payload.starters} (${payload.completionRate}%)`,
          `paywall reached: ${payload.paywallReachedUsers}/${payload.starters} (${payload.paywallReachedRate}%) via ${payload.paywallAnchorEvent}`,
          `skipped: ${payload.paywallSkippedUsers}/${payload.starters} (${payload.paywallSkipRateFromStart}%)`,
          `purchased: ${payload.purchasedUsers}/${payload.starters} (${payload.purchaseRateFromStart}%)`,
        ];
        if (payload.trends) {
          summaryLines.push(
            `trend new users: ${formatTrendSummary(payload.trends.starters)}`,
            `trend onboarding complete rate: ${formatTrendSummary(payload.trends.completionRate)}`,
            `trend drop-off rate: ${formatTrendSummary(payload.trends.dropOffRate)}`,
            `trend paywall reached rate: ${formatTrendSummary(payload.trends.paywallReachedRate)}`,
            `trend purchase rate: ${formatTrendSummary(payload.trends.purchaseRate)}`,
          );
        }
        const table = renderTable(
          ['event', 'users', '%start'],
          payload.coverageRows.map((row) => [row.eventName, row.users, `${row.percentFromStart}%`]),
        );
        print('text', `${summaryLines.join('\n')}\n\n${table}`);
        return;
      }

      print(root.format, payload);
    });
  });

program
  .command('funnel')
  .requiredOption('--project <id>', 'Project ID')
  .requiredOption('--steps <steps>', 'Comma-separated event steps')
  .option('--within <scope>', 'session|user', 'session')
  .option('--last <duration>', 'Time range like 7d', '7d')
  .option('--app-version <version>', 'Filter by appVersion')
  .option('--flow-id <id>', 'Filter by onboardingFlowId')
  .option('--flow-version <version>', 'Filter by onboardingFlowVersion')
  .option('--variant <name>', 'Filter by experimentVariant (A/B variant)')
  .option('--paywall-id <id>', 'Filter by paywallId')
  .action(async (options) => {
    await withErrorHandling(async () => {
      const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();
      const steps = String(options.steps)
        .split(',')
        .map((step) => step.trim())
        .filter(Boolean);

      const payload = await requestApi(
        'POST',
        '/v1/query/funnel',
        {
          ...resolveProjectOption(options.project),
          steps,
          within: options.within,
          last: options.last,
          includeDebug: includeDebugFlag(),
          ...resolveFlowSelectorOption(options),
        },
        {
          apiUrl: root.apiUrl,
          token: root.token,
        },
      );
      print(root.format, payload);
    });
  });

program
  .command('conversion-after')
  .requiredOption('--project <id>', 'Project ID')
  .requiredOption('--from <event>', 'From event name')
  .requiredOption('--to <event>', 'To event name')
  .option('--within <scope>', 'session|user', 'session')
  .option('--last <duration>', 'Time range like 7d', '7d')
  .option('--app-version <version>', 'Filter by appVersion')
  .option('--flow-id <id>', 'Filter by onboardingFlowId')
  .option('--flow-version <version>', 'Filter by onboardingFlowVersion')
  .option('--variant <name>', 'Filter by experimentVariant (A/B variant)')
  .option('--paywall-id <id>', 'Filter by paywallId')
  .action(async (options) => {
    await withErrorHandling(async () => {
      const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();
      const payload = await requestApi(
        'POST',
        '/v1/query/conversion_after',
        {
          ...resolveProjectOption(options.project),
          from: options.from,
          to: options.to,
          within: options.within,
          last: options.last,
          includeDebug: includeDebugFlag(),
          ...resolveFlowSelectorOption(options),
        },
        {
          apiUrl: root.apiUrl,
          token: root.token,
        },
      );
      print(root.format, payload);
    });
  });

program
  .command('goal-completion')
  .description(
    'Convenience query for completion style questions, e.g. onboarding start -> onboarding complete',
  )
  .requiredOption('--project <id>', 'Project ID')
  .requiredOption('--start <event>', 'Start event (e.g. onboarding:start)')
  .requiredOption('--complete <event>', 'Completion event (e.g. onboarding:complete)')
  .option('--within <scope>', 'session|user', 'session')
  .option('--last <duration>', 'Time range like 30d', '30d')
  .option('--app-version <version>', 'Filter by appVersion')
  .option('--flow-id <id>', 'Filter by onboardingFlowId')
  .option('--flow-version <version>', 'Filter by onboardingFlowVersion')
  .option('--variant <name>', 'Filter by experimentVariant (A/B variant)')
  .option('--paywall-id <id>', 'Filter by paywallId')
  .action(async (options) => {
    await withErrorHandling(async () => {
      const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();
      const payload = (await requestApi(
        'POST',
        '/v1/query/conversion_after',
        {
          ...resolveProjectOption(options.project),
          from: options.start,
          to: options.complete,
          within: options.within,
          last: options.last,
          includeDebug: includeDebugFlag(),
          ...resolveFlowSelectorOption(options),
        },
        {
          apiUrl: root.apiUrl,
          token: root.token,
        },
      )) as {
        from: string;
        to: string;
        totalFrom: number;
        totalConverted: number;
        conversionRate: number;
        timeRange?: { since?: string; until?: string };
      };

      if (root.format === 'text') {
        print(
          'text',
          `Completion ${payload.from} -> ${payload.to}: ${payload.totalConverted}/${payload.totalFrom} (${(
            payload.conversionRate * 100
          ).toFixed(2)}%)`,
        );
        return;
      }

      print(root.format, payload);
    });
  });

program
  .command('paths-after')
  .requiredOption('--project <id>', 'Project ID')
  .requiredOption('--from <event>', 'Anchor event')
  .option('--top <n>', 'Top N next events', '20')
  .option('--within <scope>', 'session|user', 'session')
  .option('--last <duration>', 'Time range like 7d', '7d')
  .option('--app-version <version>', 'Filter by appVersion')
  .option('--flow-id <id>', 'Filter by onboardingFlowId')
  .option('--flow-version <version>', 'Filter by onboardingFlowVersion')
  .option('--variant <name>', 'Filter by experimentVariant (A/B variant)')
  .option('--paywall-id <id>', 'Filter by paywallId')
  .action(async (options) => {
    await withErrorHandling(async () => {
      const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();
      const payload = await requestApi(
        'POST',
        '/v1/query/paths_after',
        {
          ...resolveProjectOption(options.project),
          from: options.from,
          top: Number(options.top),
          within: options.within,
          last: options.last,
          includeDebug: includeDebugFlag(),
          ...resolveFlowSelectorOption(options),
        },
        {
          apiUrl: root.apiUrl,
          token: root.token,
        },
      );
      print(root.format, payload);
    });
  });

program
  .command('timeseries')
  .requiredOption('--project <id>', 'Project ID')
  .requiredOption('--metric <metric>', 'event_count|unique_sessions|unique_users')
  .option('--event <name>', 'Optional event filter')
  .option('--interval <value>', '1h|1d', '1h')
  .option('--last <duration>', 'Time range like 7d', '7d')
  .option('--viz <mode>', 'none|table|chart|svg', 'none')
  .option('--trend', 'Include trend from first to latest bucket', false)
  .option('--out <path>', 'Output file path for svg mode', './timeseries.svg')
  .option('--app-version <version>', 'Filter by appVersion')
  .option('--flow-id <id>', 'Filter by onboardingFlowId')
  .option('--flow-version <version>', 'Filter by onboardingFlowVersion')
  .option('--variant <name>', 'Filter by experimentVariant (A/B variant)')
  .option('--paywall-id <id>', 'Filter by paywallId')
  .action(async (options) => {
    await withErrorHandling(async () => {
      const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();
      const payload = (await requestApi(
        'POST',
        '/v1/query/timeseries',
        {
          ...resolveProjectOption(options.project),
          metric: options.metric,
          event: options.event,
          interval: options.interval,
          last: options.last,
          includeDebug: includeDebugFlag(),
          ...resolveFlowSelectorOption(options),
        },
        {
          apiUrl: root.apiUrl,
          token: root.token,
        },
      )) as {
        metric: string;
        interval: string;
        points: TimeseriesPoint[];
      };

      const vizMode = String(options.viz ?? 'none');
      const points = asTimeseriesPoints(payload);
      const trend = options.trend ? computeTrendFromTimeseriesPoints(points) : null;
      if (vizMode === 'table') {
        const table = renderTable(
          ['timestamp', 'value'],
          points.map((point) => [point.ts, point.value]),
        );
        const text = options.trend ? `${table}\n\ntrend: ${formatTrendSummary(trend)}` : table;
        print('text', text);
        return;
      }

      if (vizMode === 'chart') {
        const chart = renderHorizontalBars(
          points.map((point) => ({
            label: point.ts,
            value: point.value,
          })),
        );
        const text = options.trend ? `${chart}\n\ntrend: ${formatTrendSummary(trend)}` : chart;
        print('text', text);
        return;
      }

      if (vizMode === 'none') {
        const output = options.trend ? { ...payload, trend } : payload;
        print(root.format, output);
        return;
      }

      if (vizMode === 'svg') {
        const svg = renderTimeseriesSvg({
          title: `${payload.metric} (${payload.interval})`,
          points,
        });
        await writeSvgToFile(String(options.out), svg);
        print(root.format, {
          ok: true,
          file: String(options.out),
          points: points.length,
          ...(options.trend ? { trend } : {}),
        });
        return;
      }

      throw Object.assign(new Error('Invalid --viz mode. Use none|table|chart|svg'), { exitCode: 2 });
    });
  });

program
  .command('retention')
  .description('Cohort retention by day offsets (e.g. D1/D7/D30) with avg active days')
  .requiredOption('--project <id>', 'Project ID')
  .option('--anchor-event <name>', 'Cohort anchor event', ONBOARDING_START_EVENT)
  .option('--active-event <name>', 'Optional active event filter (default: any event)')
  .option('--days <list>', 'Comma-separated day offsets, e.g. 1,7,30', '1,7,30')
  .option('--max-age-days <n>', 'Observation horizon in days for avg active span', '90')
  .option('--last <duration>', 'Cohort time range like 30d', '30d')
  .option('--app-version <version>', 'Filter by appVersion')
  .option('--flow-id <id>', 'Filter by onboardingFlowId')
  .option('--flow-version <version>', 'Filter by onboardingFlowVersion')
  .option('--variant <name>', 'Filter by experimentVariant (A/B variant)')
  .option('--paywall-id <id>', 'Filter by paywallId')
  .action(async (options) => {
    await withErrorHandling(async () => {
      const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();
      const days = parseRetentionDaysOption(options.days);
      const maxAgeDays = parseIntegerOption(options.maxAgeDays, '--max-age-days', 1, 365);

      const payload = (await requestApi(
        'POST',
        '/v1/query/retention',
        {
          ...resolveProjectOption(options.project),
          anchorEvent: options.anchorEvent,
          activeEvent: options.activeEvent,
          days,
          maxAgeDays,
          last: options.last,
          includeDebug: includeDebugFlag(),
          ...resolveFlowSelectorOption(options),
        },
        {
          apiUrl: root.apiUrl,
          token: root.token,
        },
      )) as {
        anchorEvent: string;
        activeEvent: string | null;
        cohortSize: number;
        avgActiveDays: number;
        maxAgeDays: number;
        days: Array<{ day: number; retainedUsers: number; retentionRate: number }>;
      };

      if (root.format === 'text') {
        const summary = [
          `Retention cohort (${options.last})`,
          `anchor event: ${payload.anchorEvent}`,
          `active event: ${payload.activeEvent ?? 'any event'}`,
          `cohort size: ${payload.cohortSize}`,
          `avg active days: ${payload.avgActiveDays}`,
        ].join('\n');
        const table = renderTable(
          ['day', 'retained_users', 'retention_rate'],
          payload.days.map((row) => [
            `D${row.day}`,
            row.retainedUsers,
            `${(row.retentionRate * 100).toFixed(2)}%`,
          ]),
        );
        print('text', `${summary}\n\n${table}`);
        return;
      }

      print(root.format, payload);
    });
  });

program
  .command('survey')
  .description('Aggregate survey responses (anonymized) by question and answer')
  .requiredOption('--project <id>', 'Project ID')
  .option('--event <name>', 'Survey response event name', 'onboarding:survey_response')
  .option('--survey-key <key>', 'Optional survey key filter')
  .option('--question-key <key>', 'Optional question key filter')
  .option('--top-questions <n>', 'Top questions', '20')
  .option('--top-answers <n>', 'Top answers per question', '10')
  .option('--min-users <n>', 'Minimum unique users before values are shown', '3')
  .option('--last <duration>', 'Time range like 30d', '30d')
  .option('--app-version <version>', 'Filter by appVersion')
  .option('--flow-id <id>', 'Filter by onboardingFlowId')
  .option('--flow-version <version>', 'Filter by onboardingFlowVersion')
  .option('--variant <name>', 'Filter by experimentVariant (A/B variant)')
  .option('--paywall-id <id>', 'Filter by paywallId')
  .action(async (options) => {
    await withErrorHandling(async () => {
      const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();
      const topQuestions = parseIntegerOption(options.topQuestions, '--top-questions', 1, 100);
      const topAnswers = parseIntegerOption(options.topAnswers, '--top-answers', 1, 100);
      const minUsers = parseIntegerOption(options.minUsers, '--min-users', 1, 500);

      const payload = (await requestApi(
        'POST',
        '/v1/query/survey',
        {
          ...resolveProjectOption(options.project),
          eventName: options.event,
          surveyKey: options.surveyKey,
          questionKey: options.questionKey,
          topQuestions,
          topAnswers,
          minUsers,
          last: options.last,
          includeDebug: includeDebugFlag(),
          ...resolveFlowSelectorOption(options),
        },
        {
          apiUrl: root.apiUrl,
          token: root.token,
        },
      )) as {
        eventName: string;
        surveyKey: string | null;
        questionKey: string | null;
        minUsers: number;
        questions: Array<{
          questionKey: string;
          responses: number;
          uniqueUsers: number;
          answers: Array<{
            responseKey: string;
            responses: number;
            uniqueUsers: number;
            share: number;
          }>;
        }>;
        totals: { responses: number; uniqueUsers: number };
      };

      if (root.format === 'text') {
        const blocks: string[] = [];
        blocks.push(
          [
            `Survey summary (${options.last})`,
            `event: ${payload.eventName}`,
            `survey: ${payload.surveyKey ?? 'all'}`,
            `question: ${payload.questionKey ?? 'all'}`,
            `totals: ${payload.totals.responses} responses / ${payload.totals.uniqueUsers} users`,
            `anonymization threshold: min ${payload.minUsers} users`,
          ].join('\n'),
        );

        for (const question of payload.questions) {
          const table = renderTable(
            ['response', 'responses', 'users', 'share'],
            question.answers.map((answer) => [
              answer.responseKey,
              answer.responses,
              answer.uniqueUsers,
              `${(answer.share * 100).toFixed(2)}%`,
            ]),
          );

          blocks.push(
            [
              `Question: ${question.questionKey}`,
              `responses: ${question.responses} / users: ${question.uniqueUsers}`,
              table,
            ].join('\n'),
          );
        }

        if (payload.questions.length === 0) {
          blocks.push('No survey responses found for the selected window/filters.');
        }

        print('text', blocks.join('\n\n'));
        return;
      }

      print(root.format, payload);
    });
  });

program
  .command('breakdown')
  .requiredOption('--project <id>', 'Project ID')
  .requiredOption('--by <prop>', 'Property name')
  .requiredOption('--type <type>', 'event_count|conversion_after')
  .option('--event <name>', 'Required for event_count')
  .option('--from <event>', 'Required for conversion_after')
  .option('--to <event>', 'Required for conversion_after')
  .option('--within <scope>', 'session|user', 'session')
  .option('--top <n>', 'Top buckets', '10')
  .option('--last <duration>', 'Time range like 7d', '7d')
  .option('--app-version <version>', 'Filter by appVersion')
  .option('--flow-id <id>', 'Filter by onboardingFlowId')
  .option('--flow-version <version>', 'Filter by onboardingFlowVersion')
  .option('--variant <name>', 'Filter by experimentVariant (A/B variant)')
  .option('--paywall-id <id>', 'Filter by paywallId')
  .action(async (options) => {
    await withErrorHandling(async () => {
      const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();

      const query =
        options.type === 'event_count'
          ? {
              type: 'event_count',
              eventName: options.event,
            }
          : {
              type: 'conversion_after',
              from: options.from,
              to: options.to,
              within: options.within,
            };

      const payload = await requestApi(
        'POST',
        '/v1/query/breakdown',
        {
          ...resolveProjectOption(options.project),
          by: options.by,
          top: Number(options.top),
          last: options.last,
          includeDebug: includeDebugFlag(),
          ...resolveFlowSelectorOption(options),
          query,
        },
        {
          apiUrl: root.apiUrl,
          token: root.token,
        },
      );
      print(root.format, payload);
    });
  });

const feedback = program.command('feedback').description('Feedback data helpers');

feedback
  .command('submit')
  .description('Submit product feedback for Prodinfos')
  .requiredOption('--message <text>', 'Feedback message')
  .option('--rating <n>', 'Optional rating 1-5')
  .option('--category <type>', 'bug|feature|ux|performance|other', 'other')
  .option('--context <text>', 'Optional context, e.g. what failed')
  .option('--meta <json>', 'Optional JSON object with additional fields')
  .option('--endpoint <url>', 'Collector endpoint (defaults to PRODINFOS_SELF_TRACKING_ENDPOINT)')
  .option('--project <id>', 'Project ID for feedback events (defaults to PRODINFOS_SELF_TRACKING_PROJECT_ID)')
  .option('--api-key <key>', 'Write key for feedback events (defaults to PRODINFOS_SELF_TRACKING_API_KEY)')
  .action(async (options) => {
    await withErrorHandling(async () => {
      const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();
      const endpoint = String(options.endpoint ?? env.PRODINFOS_SELF_TRACKING_ENDPOINT ?? '').replace(
        /\/$/,
        '',
      );
      const projectId = String(options.project ?? env.PRODINFOS_SELF_TRACKING_PROJECT_ID ?? '').trim();
      const apiKey = String(options.apiKey ?? env.PRODINFOS_SELF_TRACKING_API_KEY ?? '').trim();

      const category = String(options.category ?? 'other').toLowerCase();
      if (!['bug', 'feature', 'ux', 'performance', 'other'].includes(category)) {
        throw Object.assign(
          new Error('Invalid --category. Use bug|feature|ux|performance|other'),
          { exitCode: 2 },
        );
      }

      let rating: number | undefined;
      if (options.rating !== undefined) {
        const parsedRating = Number(options.rating);
        if (!Number.isInteger(parsedRating) || parsedRating < 1 || parsedRating > 5) {
          throw Object.assign(new Error('Invalid --rating. Use an integer 1-5.'), { exitCode: 2 });
        }
        rating = parsedRating;
      }

      const meta = parseJsonObjectOption(
        options.meta as string | undefined,
        '--meta',
      );
      const message = String(options.message);
      const context = options.context ? String(options.context) : null;

      const apiPayload: Record<string, unknown> = {
        source: 'cli',
        message,
        category,
        context,
        meta,
        ...(rating !== undefined ? { rating } : {}),
        ...(projectId ? { project_id: projectId } : {}),
      };

      let response: unknown;
      let delivery: 'api' | 'ingest-fallback' = 'api';

      try {
        response = await requestApi('POST', '/v1/feedback', apiPayload, {
          apiUrl: root.apiUrl,
          token: root.token,
        });
      } catch (apiError) {
        if (!endpoint || !projectId || !apiKey) {
          throw apiError;
        }

        const now = new Date().toISOString();
        const ingestPayload = {
          projectId,
          sentAt: now,
          events: [
            {
              eventName: 'feedback_submitted',
              ts: now,
              sessionId: CLI_SESSION_ID,
              anonId: CLI_ANON_ID,
              properties: {
                message,
                ...(rating !== undefined ? { rating } : {}),
                category,
                context,
                source: 'cli',
                meta,
              },
              platform: env.PRODINFOS_SELF_TRACKING_PLATFORM,
              appVersion: CLI_VERSION,
              type: 'feedback',
            },
          ],
        };

        response = await requestCollect('/v1/collect', ingestPayload, {
          endpoint,
          apiKey,
        });
        delivery = 'ingest-fallback';
      }

      if (root.format === 'text') {
        print('text', 'Feedback gesendet.');
        return;
      }

      print(root.format, {
        ok: true,
        delivery,
        ...(projectId ? { projectId } : {}),
        ...(delivery === 'ingest-fallback' ? { endpoint } : {}),
        category,
        ...(rating !== undefined ? { rating } : {}),
        response,
      });
    });
  });

feedback
  .command('export')
  .requiredOption('--project <id>', 'Project ID')
  .option('--last <duration>', 'Time range like 30d', '30d')
  .option('--limit <n>', 'Page size', '100')
  .option('--cursor <cursor>', 'Pagination cursor')
  .action(async (options) => {
    await withErrorHandling(async () => {
      const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();
      const qs = new URLSearchParams({
        projectId: options.project,
        last: options.last,
        limit: String(Number(options.limit)),
        includeDebug: String(includeDebugFlag()),
      });
      if (options.cursor) {
        qs.set('cursor', options.cursor);
      }

      const payload = await requestApi('GET', `/v1/feedback/export?${qs.toString()}`, undefined, {
        apiUrl: root.apiUrl,
        token: root.token,
      });
      print(root.format, payload);
    });
  });

const events = program.command('events').description('Event export helpers');

events
  .command('months')
  .description('List months with available events for a given year')
  .requiredOption('--project <id>', 'Project ID')
  .requiredOption('--year <year>', 'UTC year, e.g. 2026')
  .action(async (options) => {
    await withErrorHandling(async () => {
      const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();
      const qs = new URLSearchParams({
        projectId: options.project,
        year: String(Number(options.year)),
        includeDebug: String(includeDebugFlag()),
      });

      const payload = await requestApi('GET', `/v1/export/events/months?${qs.toString()}`, undefined, {
        apiUrl: root.apiUrl,
        token: root.token,
      });
      print(root.format, payload);
    });
  });

events
  .command('export')
  .description('Download monthly events export as CSV')
  .requiredOption('--project <id>', 'Project ID')
  .requiredOption('--year <year>', 'UTC year, e.g. 2026')
  .requiredOption('--month <month>', 'UTC month number 1-12')
  .option('--out <path>', 'Output file path')
  .action(async (options) => {
    await withErrorHandling(async () => {
      const root = program.opts<{ apiUrl?: string; token?: string; format: OutputFormat }>();
      const year = Number(options.year);
      const month = Number(options.month);
      const qs = new URLSearchParams({
        projectId: options.project,
        year: String(year),
        month: String(month),
        format: 'csv',
        includeDebug: String(includeDebugFlag()),
      });

      const { csv, filename } = await requestCsvExport(`/v1/export/events/download?${qs.toString()}`, {
        apiUrl: root.apiUrl,
        token: root.token,
      });

      const outPath = options.out ? String(options.out) : `./${filename}`;
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, csv, 'utf8');

      if (root.format === 'text') {
        print('text', `Export gespeichert: ${outPath}`);
        return;
      }

      print(root.format, {
        ok: true,
        file: outPath,
        year,
        month,
        format: 'csv',
      });
    });
  });

const dev = program.command('dev').description('Local development helpers');

dev
  .command('send-fixture-events')
  .description('Send deterministic fixture events to ingest endpoint')
  .requiredOption('--endpoint <url>', 'Collector base URL, e.g. http://localhost:8787')
  .requiredOption('--api-key <key>', 'Project write API key')
  .requiredOption('--project <id>', 'Project ID')
  .option('--sessions <n>', 'Number of sessions', '20')
  .action(async (options) => {
    await withErrorHandling(async () => {
      const root = program.opts<{ format: OutputFormat }>();
      const sessions = Number(options.sessions);
      const events: Array<Record<string, unknown>> = [];

      for (let i = 0; i < sessions; i += 1) {
        const sessionId = `fixture-session-${i}`;
        const anonId = `fixture-anon-${i}`;
        const now = Date.now() - i * 1000;

        events.push(
          {
            eventId: `fixture-${i}-1`,
            eventName: 'screen:home',
            ts: new Date(now).toISOString(),
            sessionId,
            anonId,
            properties: { appVersion: i % 2 === 0 ? '1.0.0' : '1.1.0' },
          },
          {
            eventId: `fixture-${i}-2`,
            eventName: i % 3 === 0 ? 'click:cta_upgrade' : 'scroll:pricing',
            ts: new Date(now + 1000).toISOString(),
            sessionId,
            anonId,
            properties: { appVersion: i % 2 === 0 ? '1.0.0' : '1.1.0' },
          },
        );

        if (i % 4 === 0) {
          events.push({
            eventId: `fixture-${i}-3`,
            eventName: 'feedback_submitted',
            ts: new Date(now + 2000).toISOString(),
            sessionId,
            anonId,
            properties: {
              message: `Feedback message ${i}`,
              rating: (i % 5) + 1,
            },
          });
        }
      }

      const response = await fetch(`${options.endpoint.replace(/\/$/, '')}/v1/collect`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': options.apiKey,
        },
        body: JSON.stringify({
          projectId: options.project,
          sentAt: new Date().toISOString(),
          events,
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        const err = new Error('Fixture ingest failed') as Error & { exitCode?: number; payload?: unknown };
        err.exitCode = mapStatusToExitCode(response.status);
        err.payload = payload;
        throw err;
      }

      print(root.format, {
        ok: true,
        sessions,
        events: events.length,
        response: payload,
      });
    });
  });

program.parseAsync(process.argv).catch((error) => {
  const typed = error as Error;
  process.stderr.write(`${JSON.stringify({ error: { message: typed.message } })}\n`);
  process.exitCode = 4;
});
