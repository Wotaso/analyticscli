import { spawnSync } from 'node:child_process';
import type { CommandRunResult } from './types.js';

export const runCommand = (
  command: string,
  args: string[],
  options?: { input?: string; timeoutMs?: number },
): CommandRunResult => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    input: options?.input,
    timeout: options?.timeoutMs,
  });

  const timedOut = (result.error as { code?: string } | undefined)?.code === 'ETIMEDOUT';

  return {
    ok: !result.error && result.status === 0,
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut,
  };
};

export const isCommandAvailable = (command: string): boolean => {
  const result = spawnSync(command, ['--help'], {
    stdio: 'ignore',
    timeout: 2000,
  });
  return !result.error;
};

export const openExternalUrl = (url: string): CommandRunResult | null => {
  if (process.platform === 'darwin') {
    return runCommand('open', [url], { timeoutMs: 5000 });
  }

  if (process.platform === 'linux') {
    return runCommand('xdg-open', [url], { timeoutMs: 5000 });
  }

  if (process.platform === 'win32') {
    return runCommand('cmd', ['/c', 'start', '', url], { timeoutMs: 5000 });
  }

  return null;
};
