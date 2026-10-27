import { createServer } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { afterEach, expect, it } from 'vite-plus/test';
import {
  readCloudflareWorkerSettings,
  publishCloudflareWorkerSettings,
} from '../../src/cli/cf-worker-settings.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

async function fixture() {
  let state: Record<string, unknown> = {
    logpush: true,
    observability: {
      enabled: true,
      redact_query_string: false,
      logs: { enabled: true, invocation_logs: true, destinations: ['existing'], persist: true },
    },
    tags: ['operator-tag'],
    tail_consumers: [{ service: 'operator-tail' }],
  };
  let owner = 'current';
  let failure: 'none' | 'read' | 'patch' | 'readback' = 'none';
  const requests: Array<{ method: string; body?: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Array<Buffer> = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString();
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
    requests.push({ method: request.method!, ...(body ? { body } : {}) });
    const failed =
      (failure === 'read' && request.method === 'GET') ||
      (failure === 'patch' && request.method === 'PATCH');
    if (body && !failed && failure !== 'readback') {
      state = { ...state, ...body };
    }
    response.writeHead(failed ? 403 : 200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        success: !failed,
        result: request.url?.endsWith('/deployments')
          ? { deployments: [{ versions: [{ version_id: owner, percentage: 100 }] }] }
          : state,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Test server did not bind');
  }
  return {
    options: {
      apiBaseUrl: `http://127.0.0.1:${address.port}`,
      accountId: 'synthetic-account',
      workerName: 'synthetic-worker',
      headers: { Authorization: 'Bearer synthetic-token' },
    },
    requests,
    read: () => structuredClone(state),
    set: (value: Record<string, unknown>) => {
      state = value;
    },
    owner: (value: string) => {
      owner = value;
    },
    fail: (value: typeof failure) => {
      failure = value;
    },
  };
}

it('applies explicit false and array clears, preserves omitted settings, and verifies readback', async () => {
  const test = await fixture();
  await publishCloudflareWorkerSettings({
    ...test.options,
    expectedVersionId: 'current',
    settings: {
      logpush: false,
      observability: {
        logs: { invocation_logs: false, destinations: [] },
        redact_query_string: true,
      },
    },
  });
  expect(test.requests.map(({ method }) => method)).toEqual(['GET', 'GET', 'PATCH', 'GET']);
  expect(test.read()).toEqual({
    logpush: false,
    observability: {
      enabled: true,
      redact_query_string: true,
      logs: { enabled: true, invocation_logs: false, destinations: [], persist: true },
    },
    tags: ['operator-tag'],
    tail_consumers: [{ service: 'operator-tail' }],
  });
  const patch = test.requests.find(({ method }) => method === 'PATCH')!.body!;
  expect(Object.keys(patch)).toEqual(['logpush', 'observability']);
  expect(patch).not.toHaveProperty('tags');
  expect(patch).not.toHaveProperty('tail_consumers');
});

it('does not read or mutate settings when none are configured', async () => {
  const test = await fixture();
  await publishCloudflareWorkerSettings({ ...test.options, settings: {} });
  expect(test.requests).toEqual([]);
});

it('skips mutation for unchanged settings despite provider-added defaults', async () => {
  const test = await fixture();
  await publishCloudflareWorkerSettings({
    ...test.options,
    settings: { logpush: true, observability: { enabled: true } },
  });
  expect(test.requests.map(({ method }) => method)).toEqual(['GET']);
});

it('normalizes older Workers with null observability as disabled', async () => {
  const test = await fixture();
  test.set({ logpush: false, observability: null });
  expect(await readCloudflareWorkerSettings(test.options)).toEqual({
    logpush: false,
    observability: { enabled: false },
  });
  await publishCloudflareWorkerSettings({
    ...test.options,
    settings: { observability: { enabled: true } },
  });
  expect(test.read()).toEqual({ logpush: false, observability: { enabled: true } });
});

it.each(['operator edit', 'new deployment'] as const)(
  'refuses to overwrite settings after %s',
  async (change) => {
    const test = await fixture();
    const before = test.read();
    if (change === 'new deployment') {
      test.owner('another-version');
    }
    await expect(
      publishCloudflareWorkerSettings({
        ...test.options,
        expectedVersionId: 'current',
        expectedSettings:
          change === 'operator edit' ? { observability: { enabled: false } } : undefined,
        settings: { logpush: false },
      }),
    ).rejects.toThrow(/changed/);
    expect(test.requests.some(({ method }) => method === 'PATCH')).toBe(false);
    expect(isDeepStrictEqual(test.read(), before)).toBe(true);
  },
);

it.each(['read', 'patch', 'readback'] as const)(
  'reports %s failure instead of claiming settings were published',
  async (failure) => {
    const test = await fixture();
    test.fail(failure);
    await expect(
      publishCloudflareWorkerSettings({ ...test.options, settings: { logpush: false } }),
    ).rejects.toThrow(failure === 'readback' ? /did not match/ : /HTTP 403/);
  },
);

it('rejects unreadable live settings before mutation', async () => {
  const test = await fixture();
  test.set({ logpush: 'invalid' });
  await expect(
    publishCloudflareWorkerSettings({ ...test.options, settings: { logpush: false } }),
  ).rejects.toThrow(/not readable/);
  expect(test.requests.map(({ method }) => method)).toEqual(['GET']);
});

it.each([{}, { logpush: false }, { observability: { enabled: false } }])(
  'accepts disabled logging surfaces omitted by the API: %j',
  async (settings) => {
    const test = await fixture();
    test.set(settings);
    expect(await readCloudflareWorkerSettings(test.options)).toEqual({
      logpush: false,
      observability: { enabled: false },
    });
    await publishCloudflareWorkerSettings({
      ...test.options,
      settings: { logpush: false, observability: { enabled: false } },
    });
    expect(test.requests.every(({ method }) => method === 'GET')).toBe(true);
  },
);

it('refuses full-object compensation after an operator adds a nested setting', async () => {
  const test = await fixture();
  const candidate = { logpush: true, observability: { enabled: true } };
  const edited = {
    ...candidate,
    observability: { enabled: true, traces: { enabled: true } },
  };
  test.set(edited);
  await expect(
    publishCloudflareWorkerSettings({
      ...test.options,
      settings: { logpush: false, observability: { enabled: false } },
      expectedSettings: candidate,
      replace: true,
    }),
  ).rejects.toThrow(/changed/);
  expect(test.read()).toEqual(edited);
  expect(test.requests.map(({ method }) => method)).toEqual(['GET']);
});

it('restores a previously disabled Worker without retaining traces introduced by a failed deploy', async () => {
  const test = await fixture();
  test.set({ logpush: false, observability: null });
  const before = await readCloudflareWorkerSettings(test.options);
  const candidate = {
    logpush: true,
    observability: { enabled: true, logs: { enabled: true }, traces: { enabled: true } },
  };
  await publishCloudflareWorkerSettings({ ...test.options, settings: candidate });
  await publishCloudflareWorkerSettings({
    ...test.options,
    settings: before,
    expectedSettings: candidate,
    replace: true,
  });
  expect(test.read()).toEqual({
    logpush: false,
    observability: { enabled: false, logs: { enabled: false }, traces: { enabled: false } },
  });
});
