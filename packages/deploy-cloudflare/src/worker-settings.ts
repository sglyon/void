import { isDeepStrictEqual } from 'node:util';
import { isRecord } from '@void/deploy-core';

/** These settings belong to the Worker, rather than an uploaded version. */
export type CloudflareWorkerSettings = Readonly<{
  logpush?: boolean;
  observability?: Readonly<Record<string, unknown>>;
}>;

export function configuredWorkerSettings(
  value: CloudflareWorkerSettings,
): CloudflareWorkerSettings {
  return {
    ...(value.logpush === undefined ? {} : { logpush: value.logpush }),
    ...(value.observability === undefined ? {} : { observability: value.observability }),
  };
}

/** Null observability means logging is disabled, including on older Workers. */
export function parseWorkerSettings(value: unknown): CloudflareWorkerSettings | null {
  if (
    !isRecord(value) ||
    (value.logpush !== undefined && typeof value.logpush !== 'boolean') ||
    (value.observability !== undefined &&
      value.observability !== null &&
      !isRecord(value.observability)) ||
    (value.logpush === undefined && value.observability === undefined)
  ) {
    return null;
  }
  return {
    ...(value.logpush === undefined ? {} : { logpush: value.logpush }),
    ...(value.observability === undefined
      ? {}
      : { observability: value.observability ?? { enabled: false } }),
  };
}

/** Provider defaults do not change intent; explicit arrays and false values do. */
export function workerSettingsMatch(expected: unknown, actual: unknown): boolean {
  if (isRecord(expected)) {
    return (
      isRecord(actual) &&
      Object.entries(expected).every(([key, value]) => workerSettingsMatch(value, actual[key]))
    );
  }
  return isDeepStrictEqual(expected, actual);
}

/** Preserve unconfigured nested settings while keeping explicit clears authoritative. */
export function mergeWorkerSettings(
  current: Readonly<Record<string, unknown>>,
  desired: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({ ...current, ...desired }).map(([key, value]) => [
      key,
      isRecord(value) && isRecord(current[key]) && isRecord(desired[key])
        ? mergeWorkerSettings(current[key], desired[key])
        : value,
    ]),
  );
}
