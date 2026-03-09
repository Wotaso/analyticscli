import {
  CLAWHUB_SITE_URL,
  PRODINFOS_AGENT_SKILL_NAMES,
  SKILL_SYNC_INTERVAL_MS,
  SKILL_SYNC_TIMEOUT_MS,
  SKILLS_PUBLIC_REPO_SLUG,
} from './constants.js';
import { configPath, persistAuthToken, readConfig, resolveAuthToken, writeConfigValue } from './config-store.js';
import { exchangeClerkJwtForReadonlyToken } from './http.js';
import { isCommandAvailable, runCommand } from './shell.js';
import type {
  PromptClient,
  SetupAgent,
  SetupExecutionOptions,
  SetupExecutionResult,
  SetupLoginResult,
  SkillInstallResult,
} from './types.js';

const formatCommand = (command: string, args: string[]) => `\`${[command, ...args].join(' ')}\``;

const getClawHubInvoker = (): { command: string; prefix: string[] } | null => {
  if (isCommandAvailable('clawhub')) {
    return { command: 'clawhub', prefix: [] };
  }

  if (isCommandAvailable('npx')) {
    return { command: 'npx', prefix: ['-y', 'clawhub'] };
  }

  return null;
};

const runCodexClaudeSkillInstall = (skillName: string, timeoutMs = 120_000) =>
  runCommand('npx', ['-y', 'skills', 'add', SKILLS_PUBLIC_REPO_SLUG, '--skill', skillName], {
    timeoutMs,
  });

const runClawHubCommand = (args: string[], timeoutMs: number) => {
  const invoker = getClawHubInvoker();
  if (!invoker) {
    return null;
  }

  return runCommand(invoker.command, [...invoker.prefix, ...args], { timeoutMs });
};

const summarizeRuns = (
  runs: Array<{ name: string; ok: boolean; timedOut: boolean; stderr: string; code: number | null }>,
  successDetail: string,
): string => {
  if (runs.every((run) => run.ok)) {
    return successDetail;
  }

  return runs
    .map((run) => {
      if (run.ok) {
        return `${run.name}: ok`;
      }

      if (run.timedOut) {
        return `${run.name}: timed out`;
      }

      return `${run.name}: ${run.stderr.trim() || `exit code ${run.code ?? 'unknown'}`}`;
    })
    .join('; ');
};

export const parseSetupAgents = (value: string): SetupAgent[] => {
  const normalized = value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  const wantsAll = normalized.length === 0 || normalized.includes('all');
  const selected = wantsAll ? ['codex', 'claude', 'openclaw'] : normalized;
  const allowed = new Set<SetupAgent>(['codex', 'claude', 'openclaw']);
  const result: SetupAgent[] = [];

  for (const agent of selected) {
    if (!allowed.has(agent as SetupAgent)) {
      throw Object.assign(
        new Error('Invalid --agents value. Use all|codex|claude|openclaw (comma-separated).'),
        { exitCode: 2 },
      );
    }

    const typedAgent = agent as SetupAgent;
    if (!result.includes(typedAgent)) {
      result.push(typedAgent);
    }
  }

  return result;
};

export const installAgentSkills = (agents: SetupAgent[]): SkillInstallResult[] => {
  const results: SkillInstallResult[] = [];

  if (agents.includes('codex') || agents.includes('claude')) {
    if (!isCommandAvailable('npx')) {
      results.push({
        target: 'codex_claude',
        ok: false,
        skipped: true,
        detail: '`npx` not available on this machine.',
      });
    } else {
      const installs = PRODINFOS_AGENT_SKILL_NAMES.map((skillName) => {
        const install = runCodexClaudeSkillInstall(skillName);
        return {
          name: skillName,
          ok: install.ok,
          timedOut: install.timedOut,
          stderr: install.stderr,
          code: install.code,
        };
      });
      results.push({
        target: 'codex_claude',
        ok: installs.every((install) => install.ok),
        skipped: false,
        detail: summarizeRuns(
          installs,
          `Skills installed/updated from ${formatCommand('npx', ['-y', 'skills', 'add', SKILLS_PUBLIC_REPO_SLUG, '--skill', 'prodinfos-cli'])} and the matching \`prodinfos-ts-sdk\` command.`,
        ),
      });
    }
  }

  if (agents.includes('openclaw')) {
    const invoker = getClawHubInvoker();
    if (!invoker) {
      results.push({
        target: 'openclaw',
        ok: false,
        skipped: true,
        detail: `Neither \`clawhub\` nor \`npx\` is available. Install ClawHub first or use ${CLAWHUB_SITE_URL}.`,
      });
    } else {
      const installs = PRODINFOS_AGENT_SKILL_NAMES.map((skillName) => {
        const install = runCommand(invoker.command, [...invoker.prefix, 'install', skillName], {
          timeoutMs: 120_000,
        });
        return {
          name: skillName,
          ok: install.ok,
          timedOut: install.timedOut,
          stderr: install.stderr,
          code: install.code,
        };
      });
      results.push({
        target: 'openclaw',
        ok: installs.every((install) => install.ok),
        skipped: false,
        detail: summarizeRuns(
          installs,
          `Skills installed/updated via ${formatCommand(invoker.command, [...invoker.prefix, 'install', 'prodinfos-cli'])} and the matching \`prodinfos-ts-sdk\` command.`,
        ),
      });
    }
  }

  return results;
};

export const renderSetupTextSummary = (label: string, result: SetupExecutionResult): string => {
  const lines = [
    label,
    `- Login: ${String(result.login.mode ?? 'skipped')}`,
    `- Auto skill update: ${result.autoSkillUpdate ? 'enabled' : 'disabled'}`,
    `- Config: ${result.configPath}`,
  ];

  for (const entry of result.skillSetup) {
    lines.push(`- Skills (${entry.target}): ${entry.ok ? 'ok' : entry.skipped ? 'skipped' : 'failed'}`);
  }

  return lines.join('\n');
};

export const runSetupFlow = async (
  root: { apiUrl?: string; token?: string },
  options: SetupExecutionOptions,
): Promise<SetupExecutionResult> => {
  const initialConfig = await readConfig();
  const apiUrl = (root.apiUrl ?? initialConfig.apiUrl).replace(/\/$/, '');
  const skillResults = options.skipSkills ? [] : installAgentSkills(options.agents);

  let activeConfig = initialConfig;
  let loginResult: SetupLoginResult = {
    ok: true,
    skipped: true,
  };

  if (!options.skipLogin) {
    if (options.clerkJwt) {
      const exchanged = await exchangeClerkJwtForReadonlyToken(apiUrl, options.clerkJwt);
      const persisted = await persistAuthToken(activeConfig, apiUrl, exchanged.token);
      activeConfig = persisted.config;
      loginResult = {
        ok: true,
        mode: 'clerk_exchange',
        tokenStorage: persisted.storage,
        tenantId: exchanged.tenantId,
        projectIds: exchanged.projectIds,
      };
    } else if (root.token?.trim()) {
      const persisted = await persistAuthToken(activeConfig, apiUrl, root.token.trim());
      activeConfig = persisted.config;
      loginResult = {
        ok: true,
        mode: 'existing_token',
        tokenStorage: persisted.storage,
      };
    } else if (resolveAuthToken(activeConfig, root.token)) {
      loginResult = {
        ok: true,
        mode: 'existing_token',
        tokenStorage: activeConfig.tokenStorage ?? 'config_file',
      };
    } else {
      throw Object.assign(
        new Error(
          'Provide --clerk-jwt for setup login, or pass --skip-login if you want skills only.',
        ),
        { exitCode: 2 },
      );
    }
  }

  const now = new Date().toISOString();
  const autoSkillUpdateEnabled = options.autoSkillUpdate !== false;
  const finalConfig = {
    ...activeConfig,
    apiUrl,
    skillAutoUpdate: autoSkillUpdateEnabled,
    setupCompletedAt: activeConfig.setupCompletedAt ?? now,
    lastSkillSyncAt: options.skipSkills ? activeConfig.lastSkillSyncAt : now,
    updatedAt: now,
  };
  await writeConfigValue(finalConfig);

  return {
    ok: true,
    apiUrl,
    configPath,
    login: loginResult,
    skillSetup: skillResults,
    autoSkillUpdate: finalConfig.skillAutoUpdate ?? false,
    setupCompletedAt: finalConfig.setupCompletedAt,
  };
};

export const promptYesNo = async (
  rl: PromptClient,
  question: string,
  defaultValue: boolean,
): Promise<boolean> => {
  const suffix = defaultValue ? '[Y/n]' : '[y/N]';
  while (true) {
    const answer = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase();
    if (!answer) {
      return defaultValue;
    }
    if (answer === 'y' || answer === 'yes') {
      return true;
    }
    if (answer === 'n' || answer === 'no') {
      return false;
    }

    process.stdout.write('Please answer with y or n.\n');
  }
};

export const promptRequiredValue = async (rl: PromptClient, question: string): Promise<string> => {
  while (true) {
    const answer = (await rl.question(`${question} `)).trim();
    if (answer) {
      return answer;
    }
    process.stdout.write('Value is required.\n');
  }
};

export const promptLoginMode = async (
  rl: PromptClient,
  hasExistingToken: boolean,
): Promise<'clerk' | 'existing' | 'skip'> => {
  while (true) {
    process.stdout.write('\nLogin method:\n');
    process.stdout.write('  1) Clerk JWT\n');
    if (hasExistingToken) {
      process.stdout.write('  2) Use existing token\n');
      process.stdout.write('  3) Skip for now\n');
    } else {
      process.stdout.write('  2) Skip for now\n');
    }

    const maxChoice = hasExistingToken ? 3 : 2;
    const defaultChoice = hasExistingToken ? '2' : '1';
    const answer = (await rl.question(`Select [1-${maxChoice}] (default ${defaultChoice}): `)).trim();
    const choice = answer || defaultChoice;

    if (choice === '1') {
      return 'clerk';
    }
    if (choice === '2' && hasExistingToken) {
      return 'existing';
    }
    if (choice === '2' || choice === '3') {
      return 'skip';
    }

    process.stdout.write('Invalid selection.\n');
  }
};

export const maybeAutoRefreshSkills = async (commandPath: string): Promise<void> => {
  if (commandPath === 'setup' || commandPath === 'onboard') {
    return;
  }

  const config = await readConfig();
  if (!config.skillAutoUpdate) {
    return;
  }

  const lastSyncAtMs = config.lastSkillSyncAt ? Date.parse(config.lastSkillSyncAt) : 0;
  if (Number.isFinite(lastSyncAtMs) && Date.now() - lastSyncAtMs < SKILL_SYNC_INTERVAL_MS) {
    return;
  }

  if (isCommandAvailable('npx')) {
    for (const skillName of PRODINFOS_AGENT_SKILL_NAMES) {
      runCodexClaudeSkillInstall(skillName, SKILL_SYNC_TIMEOUT_MS);
    }
  }

  for (const skillName of PRODINFOS_AGENT_SKILL_NAMES) {
    runClawHubCommand(['update', skillName], SKILL_SYNC_TIMEOUT_MS);
  }

  await writeConfigValue({
    ...config,
    lastSkillSyncAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
};
