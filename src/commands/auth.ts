import { createInterface } from 'node:readline/promises';
import { print } from '../analytics-utils.js';
import { configPath, persistAuthToken, readConfig, resolveAuthToken } from '../config-store.js';
import { CLAWHUB_SITE_URL } from '../constants.js';
import { exchangeClerkJwtForReadonlyToken } from '../http.js';
import { isCommandAvailable, openExternalUrl } from '../shell.js';
import {
  parseSetupAgents,
  promptLoginMode,
  promptRequiredValue,
  promptYesNo,
  renderSetupTextSummary,
  runSetupFlow,
} from '../setup.js';
import type { SetupAgent } from '../types.js';
import type { CliCommandContext } from './context.js';

export const registerAuthCommands = (context: CliCommandContext): void => {
  const { program, withErrorHandling, getRootOptions } = context;

  program
    .command('login')
    .description('Store a readonly token directly, or exchange a Clerk JWT')
    .option('--clerk-jwt <jwt>', 'Clerk JWT to exchange')
    .option('--readonly-token <token>', 'Readonly token to store directly')
    .action(async (options: { clerkJwt?: string; readonlyToken?: string }) => {
      await withErrorHandling(async () => {
        const root = getRootOptions();
        const config = await readConfig();
        const apiUrl = (root.apiUrl ?? config.apiUrl).replace(/\/$/, '');

        const directToken = options.readonlyToken?.trim() ?? root.token?.trim();
        const clerkJwt = options.clerkJwt?.trim();

        if (directToken && clerkJwt) {
          throw Object.assign(new Error('Use either --readonly-token/--token or --clerk-jwt, not both.'), {
            exitCode: 2,
          });
        }

        if (!directToken && !clerkJwt) {
          throw Object.assign(new Error('Provide --readonly-token/--token or --clerk-jwt'), { exitCode: 2 });
        }

        const now = new Date().toISOString();
        if (directToken) {
          const persisted = await persistAuthToken(config, apiUrl, directToken);
          print(root.format, {
            ok: true,
            mode: 'direct_token',
            tokenStorage: persisted.storage,
            configPath,
            updatedAt: now,
          });
          return;
        }

        const exchanged = await exchangeClerkJwtForReadonlyToken(apiUrl, String(clerkJwt));
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
    .option('--clerk-jwt <jwt>', 'Clerk JWT to exchange for a readonly token')
    .option('--skip-login', 'Skip login step', false)
    .option('--skip-skills', 'Skip skill installation step', false)
    .option('--agents <targets>', 'all|codex|claude|openclaw (comma-separated)', 'all')
    .option('--no-auto-skill-update', 'Disable daily skill refresh on CLI execution')
    .action(
      async (options: {
        clerkJwt?: string;
        skipLogin?: boolean;
        skipSkills?: boolean;
        agents?: string;
        autoSkillUpdate?: boolean;
      }) => {
        await withErrorHandling(async () => {
          const root = getRootOptions();
          const agents = parseSetupAgents(String(options.agents ?? 'all'));
          const result = await runSetupFlow(root, {
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
    .option('--clerk-jwt <jwt>', 'Clerk JWT to exchange for a readonly token')
    .option('--no-auto-skill-update', 'Disable daily skill refresh on CLI execution')
    .action(
      async (options: {
        clerkJwt?: string;
        autoSkillUpdate?: boolean;
      }) => {
        await withErrorHandling(async () => {
          const root = getRootOptions();

          if (!process.stdin.isTTY || !process.stdout.isTTY) {
            throw Object.assign(
              new Error(
                '`onboard` requires an interactive terminal. Use `prodinfos setup` for non-interactive flows.',
              ),
              { exitCode: 2 },
            );
          }

          const selectedAgents: SetupAgent[] = [];
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
              'Install Prodinfos skills for Codex/Claude Code from `wotaso/prodinfos-skills`?',
              true,
            );
            if (installCodexClaude) {
              selectedAgents.push('codex', 'claude');
            }

            const installOpenclaw = await promptYesNo(
              rl,
              'Install Prodinfos skills for OpenClaw via ClawHub?',
              false,
            );
            if (installOpenclaw) {
              selectedAgents.push('openclaw');
              if (!isCommandAvailable('clawhub') && !isCommandAvailable('npx')) {
                process.stdout.write('\nNeither `clawhub` nor `npx` is installed on this machine.\n');
                const openSkillPage = await promptYesNo(
                  rl,
                  `Open ClawHub now (${CLAWHUB_SITE_URL})?`,
                  true,
                );
                if (openSkillPage) {
                  const openResult = openExternalUrl(CLAWHUB_SITE_URL);
                  if (!openResult) {
                    process.stdout.write(
                      `Could not auto-open browser. Open this URL manually: ${CLAWHUB_SITE_URL}\n`,
                    );
                  } else if (!openResult.ok) {
                    process.stdout.write(
                      `Failed to open browser automatically. Open this URL manually: ${CLAWHUB_SITE_URL}\n`,
                    );
                  }
                }
              }
            }

            if (!clerkJwt) {
              const config = await readConfig();
              const hasExistingToken = Boolean(resolveAuthToken(config, root.token));
              const loginMode = await promptLoginMode(rl, hasExistingToken);

              if (loginMode === 'clerk') {
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
};
