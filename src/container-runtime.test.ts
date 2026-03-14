import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecSync = vi.fn();
const mockExistsSync = vi.fn();
const mockNetworkInterfaces = vi.fn();

async function loadContainerRuntime(options?: {
  platform?: NodeJS.Platform;
  envRuntime?: string | undefined;
}) {
  vi.resetModules();

  if (options?.envRuntime === undefined) {
    delete process.env.CONTAINER_RUNTIME;
  } else {
    process.env.CONTAINER_RUNTIME = options.envRuntime;
  }

  vi.doMock('./logger.js', () => ({
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }));

  vi.doMock('child_process', () => ({
    execSync: (...args: unknown[]) => mockExecSync(...args),
  }));

  vi.doMock('fs', () => ({
    default: {
      existsSync: (...args: unknown[]) => mockExistsSync(...args),
    },
  }));

  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof import('os')>('os');
    return {
      ...actual,
      default: {
        ...actual,
        platform: () => options?.platform ?? 'linux',
        networkInterfaces: () => mockNetworkInterfaces(),
      },
      platform: () => options?.platform ?? 'linux',
      networkInterfaces: () => mockNetworkInterfaces(),
    };
  });

  const runtime = await import('./container-runtime.js');
  const { logger } = await import('./logger.js');
  return { runtime, logger };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CONTAINER_RUNTIME;
  mockExistsSync.mockReturnValue(false);
  mockNetworkInterfaces.mockReturnValue({});
});

describe('runtime selection', () => {
  it('defaults to docker on linux', async () => {
    const { runtime } = await loadContainerRuntime({ platform: 'linux' });

    expect(runtime.CONTAINER_RUNTIME_BIN).toBe('docker');
    expect(runtime.isAppleContainerRuntime()).toBe(false);
  });

  it('defaults to container on macOS', async () => {
    const { runtime } = await loadContainerRuntime({ platform: 'darwin' });

    expect(runtime.CONTAINER_RUNTIME_BIN).toBe('container');
    expect(runtime.isAppleContainerRuntime()).toBe(true);
  });

  it('respects CONTAINER_RUNTIME override', async () => {
    const { runtime } = await loadContainerRuntime({
      platform: 'linux',
      envRuntime: 'container',
    });

    expect(runtime.CONTAINER_RUNTIME_BIN).toBe('container');
    expect(runtime.isAppleContainerRuntime()).toBe(true);
  });
});

describe('readonlyMountArgs', () => {
  it('returns --mount flag with type=bind and readonly', async () => {
    const { runtime } = await loadContainerRuntime();
    const args = runtime.readonlyMountArgs('/host/path', '/container/path');

    expect(args).toEqual([
      '--mount',
      'type=bind,source=/host/path,target=/container/path,readonly',
    ]);
  });
});

describe('stopContainer', () => {
  it('returns stop command using the selected runtime', async () => {
    const { runtime } = await loadContainerRuntime({ platform: 'linux' });

    expect(runtime.stopContainer('nanoclaw-test-123')).toBe(
      'docker stop nanoclaw-test-123',
    );
  });
});

describe('hostGatewayArgs', () => {
  it('adds host-gateway mapping for docker on linux', async () => {
    const { runtime } = await loadContainerRuntime({ platform: 'linux' });

    expect(runtime.hostGatewayArgs()).toEqual([
      '--add-host=host.docker.internal:host-gateway',
    ]);
  });

  it('omits host-gateway mapping for apple container', async () => {
    mockNetworkInterfaces.mockReturnValue({
      bridge100: [{ family: 'IPv4', address: '192.168.64.1' }],
    });

    const { runtime } = await loadContainerRuntime({
      platform: 'darwin',
      envRuntime: 'container',
    });

    expect(runtime.hostGatewayArgs()).toEqual([]);
  });
});

describe('ensureContainerRuntimeRunning', () => {
  it('checks docker with info on linux', async () => {
    mockExecSync.mockReturnValueOnce('');
    const { runtime, logger } = await loadContainerRuntime({ platform: 'linux' });

    runtime.ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledWith('docker info', {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(logger.debug).toHaveBeenCalledWith(
      'Container runtime already running',
    );
  });

  it('checks apple container with system status on macOS', async () => {
    mockExecSync.mockReturnValueOnce('');
    const { runtime, logger } = await loadContainerRuntime({
      platform: 'darwin',
    });

    runtime.ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledWith('container system status', {
      stdio: 'pipe',
    });
    expect(logger.debug).toHaveBeenCalledWith(
      'Container runtime already running',
    );
  });

  it('auto-starts apple container when system status fails', async () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('not running');
    });
    mockExecSync.mockReturnValueOnce('');
    const { runtime, logger } = await loadContainerRuntime({
      platform: 'darwin',
    });

    runtime.ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      'container system start',
      { stdio: 'pipe', timeout: 30000 },
    );
    expect(logger.info).toHaveBeenCalledWith('Container runtime started');
  });
});

describe('cleanupOrphans', () => {
  it('uses docker ps output on linux', async () => {
    mockExecSync.mockReturnValueOnce('nanoclaw-a\nnanoclaw-b\n');
    mockExecSync.mockReturnValue('');
    const { runtime, logger } = await loadContainerRuntime({ platform: 'linux' });

    runtime.cleanupOrphans();

    expect(mockExecSync).toHaveBeenNthCalledWith(
      1,
      "docker ps --filter name=nanoclaw- --format '{{.Names}}'",
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-a', 'nanoclaw-b'] },
      'Stopped orphaned containers',
    );
  });

  it('uses apple container json output on macOS', async () => {
    const lsOutput = JSON.stringify([
      { status: 'running', configuration: { id: 'nanoclaw-group1-111' } },
      { status: 'stopped', configuration: { id: 'nanoclaw-group2-222' } },
      { status: 'running', configuration: { id: 'nanoclaw-group3-333' } },
    ]);
    mockExecSync.mockReturnValueOnce(lsOutput);
    mockExecSync.mockReturnValue('');
    const { runtime, logger } = await loadContainerRuntime({ platform: 'darwin' });

    runtime.cleanupOrphans();

    expect(mockExecSync).toHaveBeenNthCalledWith(
      1,
      'container ls --format json',
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-group1-111', 'nanoclaw-group3-333'] },
      'Stopped orphaned containers',
    );
  });
});
