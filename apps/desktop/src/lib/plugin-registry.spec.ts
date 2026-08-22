import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./api', () => ({
  tauriInvoke: vi.fn(),
}));

import { tauriInvoke } from './api';
import { loadInstalledPlugin, listInstallations } from './plugin-registry';

const mockInvoke = tauriInvoke as unknown as ReturnType<typeof vi.fn>;

function makePayload(overrides: {
  origin: string;
  protected: boolean;
  entry?: string;
  runtime_type?: string;
}): Record<string, unknown> {
  const installation = {
    installationId: 'inst-1',
    packageId: 'com.example.demo',
    origin: overrides.origin,
    protected: overrides.protected,
    activeRelease: {
      releaseId: 'rel-1',
      sha256: 'abcd1234',
      version: '1.2.3',
    },
  };
  const manifest: Record<string, unknown> = {
    name: 'Demo',
    description: 'A demo plugin',
  };
  if (overrides.entry !== undefined) manifest.entry = overrides.entry;
  if (overrides.runtime_type !== undefined) manifest.runtime_type = overrides.runtime_type;
  return {
    installation,
    manifest,
    entryContent: '<html></html>',
    readmeMarkdown: '# Demo\n\nReadme.',
  };
}

describe('loadInstalledPlugin', () => {
  beforeEach(() => mockInvoke.mockReset());

  it('maps a local, non-protected payload to a LoadedPlugin', async () => {
    mockInvoke.mockResolvedValue(
      makePayload({ origin: 'local', protected: false, entry: 'index.html', runtime_type: 'client' })
    );
    const plugin = await loadInstalledPlugin('inst-1');
    expect(plugin.id).toBe('inst-1');
    expect(plugin.installationId).toBe('inst-1');
    expect(plugin.packageId).toBe('com.example.demo');
    expect(plugin.releaseId).toBe('rel-1');
    expect(plugin.releaseSha256).toBe('abcd1234');
    expect(plugin.version).toBe('1.2.3');
    expect(plugin.entry).toBe('index.html');
    expect(plugin.runtime_type).toBe('client');
    expect(plugin.source).toBe('installed');
    expect(plugin.builtin).toBe(false);
    expect(plugin.manifest).toBeDefined();
  });

  it('treats origin builtin + protected as a builtin plugin', async () => {
    mockInvoke.mockResolvedValue(makePayload({ origin: 'builtin', protected: true }));
    const plugin = await loadInstalledPlugin('inst-1');
    expect(plugin.source).toBe('builtin');
    expect(plugin.builtin).toBe(true);
  });

  it('defaults entry and runtime_type when manifest omits them', async () => {
    mockInvoke.mockResolvedValue(makePayload({ origin: 'local', protected: false }));
    const plugin = await loadInstalledPlugin('inst-1');
    expect(plugin.entry).toBe('ui/index.html');
    expect(plugin.runtime_type).toBe('client');
  });
});

describe('listInstallations', () => {
  beforeEach(() => mockInvoke.mockReset());

  it('returns the array from list_plugin_installations', async () => {
    const installations = [
      { installationId: 'inst-1', packageId: 'com.example.a', origin: 'local', protected: false },
      { installationId: 'inst-2', packageId: 'com.example.b', origin: 'builtin', protected: true },
    ] as never;
    mockInvoke.mockResolvedValue(installations);
    const result = await listInstallations();
    expect(mockInvoke).toHaveBeenCalledWith('list_plugin_installations');
    expect(result).toHaveLength(2);
  });
});
