import { expect, it } from 'vite-plus/test';
import {
  activateCloudflareVersion,
  encodeCloudflareVersionMessage,
  type CloudflareCommandResult,
  type CloudflareOperation,
  type CloudflareTriggerConfig,
  type CloudflareWorkerSettings,
  mergeWorkerSettings,
  workerSettingsMatch,
} from '../../src/index.ts';

const CURRENT = '11111111-1111-4111-8111-111111111111';
const NEXT = '22222222-2222-4222-8222-222222222222';
const triggers: CloudflareTriggerConfig = {
  workers_dev: true,
  preview_urls: true,
  routes: [],
  crons: [],
  queueConsumers: [],
  workflows: [],
};

async function deployment(failure: 'none' | 'settings' | 'read' | 'operator', legacy = false) {
  const live: CloudflareWorkerSettings = {
    logpush: true,
    observability: {
      enabled: true,
      logs: { enabled: true, invocation_logs: false, destinations: ['existing'] },
    },
  };
  let settings = structuredClone(live);
  let traffic = CURRENT;
  let uploaded = false;
  const operations: Array<CloudflareOperation> = [];
  const runWrangler = async (operation: CloudflareOperation): Promise<CloudflareCommandResult> => {
    operations.push(operation);
    const ok = (data?: unknown): CloudflareCommandResult => ({
      status: 0,
      stdout: '',
      stderr: '',
      data,
    });
    if (operation.type === 'deployments.status') {
      return ok({ versions: [{ version_id: traffic, percentage: 100 }] });
    }
    if (operation.type === 'versions.list') {
      return ok([
        {
          id: CURRENT,
          number: 1,
          annotations: legacy
            ? {}
            : {
                'workers/message': encodeCloudflareVersionMessage([], {
                  ...triggers,
                  observability: { enabled: false },
                }),
              },
        },
        ...(uploaded ? [{ id: NEXT, number: 2 }] : []),
      ]);
    }
    if (operation.type === 'worker.settings.read') {
      return failure === 'read' ? { ...ok(), status: 1 } : ok(settings);
    }
    if (operation.type === 'versions.upload') {
      expect(settings).toEqual(live);
      uploaded = true;
      return ok({ versionId: NEXT, previewUrl: 'https://preview.example.workers.dev' });
    }
    if (operation.type === 'versions.deploy') {
      traffic = operation.versions[0]!.versionId;
      return ok();
    }
    if (operation.type === 'triggers.deploy') {
      return ok();
    }
    if (operation.type === 'worker.settings.apply') {
      expect(operation.expectedVersionId).toBe(traffic);
      if (failure === 'operator' && traffic === NEXT) {
        settings = { ...settings, observability: { enabled: false, logs: { enabled: false } } };
      }
      if (workerSettingsMatch(operation.settings, settings)) {
        return ok();
      }
      if (
        operation.expectedSettings &&
        !workerSettingsMatch(operation.expectedSettings, settings)
      ) {
        return { ...ok(), status: 1 };
      }
      settings = mergeWorkerSettings(settings, operation.settings);
      return failure === 'settings' && traffic === NEXT ? { ...ok(), status: 1 } : ok();
    }
    throw new Error(`Unexpected operation ${operation.type}`);
  };
  const result = await activateCloudflareVersion({
    runWrangler,
    workerName: 'synthetic-worker',
    verifyUploader: () => true,
    message: encodeCloudflareVersionMessage([], {
      ...triggers,
      logpush: false,
      observability: { enabled: true, logs: { destinations: [] } },
    }),
    readinessAttempts: 1,
    fetch: async () => Response.json({ ready: true }),
  });
  return { result, settings, live, traffic, operations };
}

it('captures settings before upload and applies them only after activation', async () => {
  const test = await deployment('none');
  expect(test.result).toMatchObject({ ok: true });
  const types = test.operations.map(({ type }) => type);
  expect(types.indexOf('worker.settings.read')).toBeLessThan(types.indexOf('versions.upload'));
  expect(types.indexOf('versions.deploy')).toBeLessThan(types.indexOf('worker.settings.apply'));
  expect(test.settings).toEqual({
    logpush: false,
    observability: {
      enabled: true,
      logs: { enabled: true, invocation_logs: false, destinations: [] },
    },
  });
});

it.each([false, true])(
  'restores actual live settings after failure, including older metadata (legacy=%s)',
  async (legacy) => {
    const test = await deployment('settings', legacy);
    expect(test.result).toMatchObject({
      ok: false,
      reason: 'triggers-failed',
      rollback: legacy ? 'unavailable' : 'succeeded',
    });
    expect(test.traffic).toBe(CURRENT);
    expect(test.settings).toEqual(test.live);
  },
);

it('fails before upload when live settings cannot be captured', async () => {
  const test = await deployment('read');
  expect(test.result).toMatchObject({ ok: false, reason: 'status-failed' });
  expect(test.operations.some(({ type }) => type === 'versions.upload')).toBe(false);
});

it('does not overwrite operator changes during activation or compensation', async () => {
  const test = await deployment('operator');
  expect(test.result).toMatchObject({ ok: false, rollback: 'failed' });
  expect(test.settings.observability).toEqual({ enabled: false, logs: { enabled: false } });
});
