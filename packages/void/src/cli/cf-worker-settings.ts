import {
  configuredWorkerSettings,
  mergeWorkerSettings,
  parseWorkerSettings,
  workerSettingsMatch,
  type CloudflareWorkerSettings,
} from '@void/deploy-cloudflare';
import { isRecord } from '@void/deploy-core';
import { getVoidUserAgent } from './cf-user-agent.ts';

type SettingsTarget = {
  apiBaseUrl: string;
  accountId: string;
  workerName: string;
  headers: Record<string, string>;
  verify?: () => boolean;
};

async function request(
  options: SettingsTarget,
  resource: 'script-settings' | 'deployments',
  body?: CloudflareWorkerSettings,
): Promise<unknown> {
  if (options.verify && !options.verify()) {
    throw new Error('The Cloudflare settings publisher changed during deployment.');
  }
  const endpoint = `${options.apiBaseUrl.replace(/\/$/, '')}/accounts/${encodeURIComponent(options.accountId)}/workers/scripts/${encodeURIComponent(options.workerName)}/${resource}`;
  const response = await fetch(endpoint, {
    method: body ? 'PATCH' : 'GET',
    headers: {
      'User-Agent': getVoidUserAgent(),
      ...options.headers,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  const value: unknown = await response.json();
  if (!response.ok || !isRecord(value) || value.success !== true) {
    throw new Error(`Cloudflare Worker settings request failed (HTTP ${response.status}).`);
  }
  return value.result;
}

export async function readCloudflareWorkerSettings(
  options: SettingsTarget,
): Promise<CloudflareWorkerSettings> {
  const settings = parseWorkerSettings(await request(options, 'script-settings'));
  if (!settings) {
    throw new Error('The Cloudflare Worker settings were not readable.');
  }
  return settings;
}

/** Shared settings cannot be versioned, so apply only while the inspected owner still serves. */
export async function publishCloudflareWorkerSettings(
  options: SettingsTarget & {
    settings: CloudflareWorkerSettings;
    replace?: boolean;
    expectedSettings?: CloudflareWorkerSettings;
    expectedVersionId?: string;
  },
): Promise<void> {
  // A disabled prestate can omit channels that the failed deployment subsequently enabled.
  const canonicalDisabled = (settings: CloudflareWorkerSettings): CloudflareWorkerSettings =>
    settings.observability?.enabled === false
      ? {
          ...settings,
          observability: {
            logs: { enabled: false },
            traces: { enabled: false },
            ...settings.observability,
          },
        }
      : settings;
  const desired = options.replace
    ? canonicalDisabled(configuredWorkerSettings(options.settings))
    : configuredWorkerSettings(options.settings);
  if (Object.keys(desired).length === 0) {
    return;
  }
  const current = await readCloudflareWorkerSettings(options);
  if (workerSettingsMatch(desired, options.replace ? canonicalDisabled(current) : current)) {
    return;
  }
  const baseline = options.expectedSettings;
  if (baseline && !workerSettingsMatch(baseline, current)) {
    throw new Error(
      'Cloudflare Worker settings changed during deployment; refusing to overwrite them.',
    );
  }
  if (options.expectedVersionId) {
    const deployments = await request(options, 'deployments');
    const latest =
      isRecord(deployments) && Array.isArray(deployments.deployments)
        ? deployments.deployments[0]
        : null;
    const versions = isRecord(latest) && Array.isArray(latest.versions) ? latest.versions : [];
    if (
      versions.length !== 1 ||
      !isRecord(versions[0]) ||
      versions[0].version_id !== options.expectedVersionId ||
      versions[0].percentage !== 100
    ) {
      throw new Error('The active Cloudflare Worker changed before settings publication.');
    }
  }
  const patch = options.replace
    ? desired
    : mergeWorkerSettings(
        Object.fromEntries(
          Object.keys(desired).map((key) => [key, current[key as keyof CloudflareWorkerSettings]]),
        ),
        desired,
      );
  await request(options, 'script-settings', patch);
  if (!workerSettingsMatch(patch, await readCloudflareWorkerSettings(options))) {
    throw new Error('Cloudflare Worker settings did not match after publication.');
  }
}
