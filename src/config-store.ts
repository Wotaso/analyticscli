import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { env, KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE } from './constants.js';
import { runCommand } from './shell.js';
import type { CliConfig } from './types.js';

const resolveConfigPath = (): string => {
  if (env.PRODINFOS_CONFIG_DIR) {
    return join(env.PRODINFOS_CONFIG_DIR, 'config.json');
  }

  return join(homedir(), '.config', 'prodinfos', 'config.json');
};

export const configPath = resolveConfigPath();

export const readConfig = async (): Promise<CliConfig> => {
  try {
    const raw = await readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CliConfig>;
    return {
      apiUrl: typeof parsed.apiUrl === 'string' ? parsed.apiUrl : env.PRODINFOS_API_URL,
      token: typeof parsed.token === 'string' ? parsed.token : undefined,
      tokenStorage:
        parsed.tokenStorage === 'system_keychain' || parsed.tokenStorage === 'config_file'
          ? parsed.tokenStorage
          : undefined,
      skillAutoUpdate: typeof parsed.skillAutoUpdate === 'boolean' ? parsed.skillAutoUpdate : false,
      lastSkillSyncAt: typeof parsed.lastSkillSyncAt === 'string' ? parsed.lastSkillSyncAt : undefined,
      setupCompletedAt: typeof parsed.setupCompletedAt === 'string' ? parsed.setupCompletedAt : undefined,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return {
      apiUrl: env.PRODINFOS_API_URL,
      skillAutoUpdate: false,
      updatedAt: new Date().toISOString(),
    };
  }
};

export const writeConfigValue = async (value: CliConfig): Promise<void> => {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(value, null, 2), 'utf8');
  await chmod(configPath, 0o600).catch(() => {
    // Best effort: some platforms may not support chmod for this path.
  });
};

const readTokenFromSystemStore = (): string | undefined => {
  if (process.platform === 'darwin') {
    const result = runCommand('security', [
      'find-generic-password',
      '-a',
      KEYCHAIN_ACCOUNT,
      '-s',
      KEYCHAIN_SERVICE,
      '-w',
    ]);
    if (!result.ok) {
      return undefined;
    }

    const token = result.stdout.trim();
    return token || undefined;
  }

  if (process.platform === 'linux') {
    const result = runCommand('secret-tool', [
      'lookup',
      'service',
      KEYCHAIN_SERVICE,
      'account',
      KEYCHAIN_ACCOUNT,
    ]);
    if (!result.ok) {
      return undefined;
    }

    const token = result.stdout.trim();
    return token || undefined;
  }

  return undefined;
};

const writeTokenToSystemStore = (token: string): boolean => {
  if (process.platform === 'darwin') {
    const result = runCommand(
      'security',
      ['add-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE, '-w', token, '-U'],
      { timeoutMs: 5000 },
    );
    return result.ok;
  }

  if (process.platform === 'linux') {
    const result = runCommand(
      'secret-tool',
      ['store', '--label', 'Prodinfos CLI token', 'service', KEYCHAIN_SERVICE, 'account', KEYCHAIN_ACCOUNT],
      { input: token, timeoutMs: 5000 },
    );
    return result.ok;
  }

  return false;
};

export const resolveAuthToken = (config: CliConfig, overrideToken?: string): string | undefined => {
  if (overrideToken) {
    return overrideToken;
  }

  if (config.tokenStorage === 'system_keychain') {
    const tokenFromStore = readTokenFromSystemStore();
    if (tokenFromStore) {
      return tokenFromStore;
    }
  }

  return config.token;
};

export const persistAuthToken = async (
  baseConfig: CliConfig,
  apiUrl: string,
  token: string,
): Promise<{ config: CliConfig; storage: 'config_file' | 'system_keychain' }> => {
  const useSystemStore = writeTokenToSystemStore(token);
  const storage: 'config_file' | 'system_keychain' = useSystemStore ? 'system_keychain' : 'config_file';
  const nextConfig: CliConfig = {
    ...baseConfig,
    apiUrl,
    token: storage === 'config_file' ? token : undefined,
    tokenStorage: storage,
    updatedAt: new Date().toISOString(),
  };
  await writeConfigValue(nextConfig);
  return { config: nextConfig, storage };
};
