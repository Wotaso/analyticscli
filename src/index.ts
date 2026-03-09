#!/usr/bin/env node
import { Command } from 'commander';
import { registerAuthCommands } from './commands/auth.js';
import type { CliCommandContext, RootCliOptions } from './commands/context.js';
import { registerDevCommands } from './commands/dev.js';
import { registerEventCommands } from './commands/events.js';
import { registerFeedbackCommands } from './commands/feedback.js';
import { registerProjectCommands } from './commands/projects.js';
import { registerQueryCommands } from './commands/queries/index.js';
import {
  CLI_DEV_COMMANDS_ENABLED,
  CLI_ANON_ID,
  CLI_SESSION_ID,
  CLI_VERSION,
  SELF_TRACKING_ENABLED,
  SELF_TRACKING_ENDPOINT,
  env,
} from './constants.js';
import { maybeAutoRefreshSkills } from './setup.js';

let activeCommandPath = 'unknown';
let activeCommandStartMs = Date.now();

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

const program = new Command();
program
  .name('prodinfos')
  .description('Agent-friendly Prodinfos CLI')
  .option('--api-url <url>', 'API base URL')
  .option('--token <token>', 'Override auth token for this call')
  .option('--format <format>', 'Output format json|text', 'json')
  .option('--include-debug', 'Include development/debug events in query/export commands', false)
  .option('--quiet', 'Reduce text output noise', false);

const getRootOptions = (): RootCliOptions => program.opts<RootCliOptions>();
const includeDebugFlag = (): boolean => Boolean(getRootOptions().includeDebug);

const context: CliCommandContext = {
  program,
  withErrorHandling,
  getRootOptions,
  includeDebugFlag,
};

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

registerAuthCommands(context);
registerProjectCommands(context);
registerQueryCommands(context);
registerFeedbackCommands(context);
registerEventCommands(context);
if (CLI_DEV_COMMANDS_ENABLED) {
  registerDevCommands(context);
}

program.parseAsync(process.argv).catch((error) => {
  const typed = error as Error;
  process.stderr.write(`${JSON.stringify({ error: { message: typed.message } })}\n`);
  process.exitCode = 4;
});
