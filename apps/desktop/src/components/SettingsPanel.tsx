// SettingsPanel.tsx — 应用设置（relay 凭据录入，C2 决策）。
//
// client 插件的 AI 能力（notes 等）通过宿主 client_* 代理命令调用 relay；凭据不进 iframe，
// 由用户在此页录入，经 set_relay_settings 落到宿主。空串 → null（Rust 归一为 None）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { tauriInvoke, errorMessage } from '@/lib/api';
import { validateRelayApiBase, relayTokenHint } from '@/lib/relaySettings';
import { Button } from '@/components/ui/button';

interface RelaySettings {
  api_base?: string;
  auth_token?: string;
}

type CheckState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'downloading'; version: string }
  | { kind: 'no-update' }
  | { kind: 'ready'; version: string; notes: string; canApply: boolean }
  | { kind: 'updated' }
  | { kind: 'error'; message: string };

export function SettingsPanel({ onClose }: { onClose?: () => void }) {
  const [apiBase, setApiBase] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [appVersion, setAppVersion] = useState('');
  const [check, setCheck] = useState<CheckState>({ kind: 'idle' });
  const downloadingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    tauriInvoke<RelaySettings>('get_relay_settings')
      .then((settings) => {
        if (cancelled) return;
        setApiBase(settings?.api_base ?? '');
        setAuthToken(settings?.auth_token ?? '');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(errorMessage(err, '读取设置失败'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    tauriInvoke<string>('get_app_version')
      .then((v) => !cancelled && setAppVersion(v))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const onSave = useCallback(async () => {
    setSaved(false);
    setError(null);
    try {
      await tauriInvoke('set_relay_settings', {
        api_base: apiBase.trim() ? apiBase.trim() : null,
        auth_token: authToken.trim() ? authToken.trim() : null,
      });
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err, '保存失败'));
    }
  }, [apiBase, authToken]);

  const configured = apiBase.trim().length > 0 && authToken.trim().length > 0;
  // F5：api_base 非法时阻断保存；token 仅提示。
  const apiBaseError = validateRelayApiBase(apiBase);
  const tokenHint = relayTokenHint(authToken);

  // LF-10：应用侧更新触发链路（手动触发，v1 不做后台静默下载）。
  // 流程：check_update →（有更新）download_update → apply_update（拉起 updater.exe 覆盖重启）。
  const onCheckUpdate = useCallback(async () => {
    if (downloadingRef.current) return;
    setCheck({ kind: 'checking' });
    try {
      const info = await tauriInvoke<{
        version: string;
        notes: string;
        setupUrl: string;
        setupSha256: string;
        setupMinisigUrl: string;
        setupSize: number;
      } | null>('check_update', { feedUrl: null });
      if (!info) {
        setCheck({ kind: 'no-update' });
        return;
      }
      setCheck({ kind: 'ready', version: info.version, notes: info.notes, canApply: false });
    } catch (err) {
      setCheck({ kind: 'error', message: errorMessage(err, '检查更新失败') });
    }
  }, []);

  const onDownloadAndApply = useCallback(async () => {
    if (downloadingRef.current) return;
    const info = await tauriInvoke<{
      version: string;
      notes: string;
      setupUrl: string;
      setupSha256: string;
      setupMinisigUrl: string;
      setupSize: number;
    } | null>('check_update', { feedUrl: null });
    if (!info) {
      setCheck({ kind: 'no-update' });
      return;
    }
    downloadingRef.current = true;
    setCheck({ kind: 'downloading', version: info.version });
    try {
      const setupPath = await tauriInvoke<string>('download_update', {
        info: {
          version: info.version,
          notes: info.notes,
          pubDate: '',
          setupUrl: info.setupUrl,
          setupSha256: info.setupSha256,
          setupMinisigUrl: info.setupMinisigUrl,
          setupSize: info.setupSize,
        },
        pubkey: null,
      });
      setCheck({ kind: 'ready', version: info.version, notes: info.notes, canApply: true });
      await tauriInvoke('apply_update', { setupPath });
      setCheck({ kind: 'updated' });
    } catch (err) {
      setCheck({ kind: 'error', message: errorMessage(err, '下载/应用更新失败') });
    } finally {
      downloadingRef.current = false;
    }
  }, []);

  return (
    <div className="space-y-5">
      {/* LF-10：更新检查入口（手动触发）。 */}
      <div className="space-y-2 rounded-md border p-3">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <h3 className="text-sm font-medium">更新</h3>
            <p className="text-xs text-muted-foreground">
              当前版本 {appVersion || '—'}（v1 手动检查，不后台静默下载）
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={onCheckUpdate}
            disabled={check.kind === 'checking' || check.kind === 'downloading'}
          >
            {check.kind === 'checking'
              ? '检查中…'
              : check.kind === 'downloading'
                ? '下载中…'
                : '检查更新'}
          </Button>
        </div>

        {check.kind === 'no-update' && (
          <div className="text-xs text-green-600">已是最新版本。</div>
        )}
        {check.kind === 'ready' && (
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground">
              发现新版本 <span className="font-medium text-foreground">{check.version}</span>
            </div>
            {check.notes && (
              <pre className="max-h-24 overflow-auto whitespace-pre-wrap rounded bg-muted px-2 py-1 text-xs">
                {check.notes}
              </pre>
            )}
            <Button size="sm" onClick={onDownloadAndApply}>
              下载并安装
            </Button>
          </div>
        )}
        {check.kind === 'downloading' && (
          <div className="text-xs text-muted-foreground">
            正在下载 {check.version} 并校验完整性…
          </div>
        )}
        {check.kind === 'updated' && (
          <div className="text-xs text-green-600">
            已拉起更新器，将自动覆盖并重启（若未自动重启，请手动重开应用）。
          </div>
        )}
        {check.kind === 'error' && (
          <div className="text-xs text-red-600">{check.message}</div>
        )}
      </div>

      <div className="space-y-1">
        <h3 className="text-sm font-medium">Relay 凭据</h3>
        <p className="text-xs text-muted-foreground">
          client 插件的 AI 能力（notes 等）经宿主 client_* 代理命令调用 relay；凭据只存于宿主，iframe 不持有。
        </p>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground">读取中…</div>
      ) : (
        <div className="space-y-4">
          {!configured && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              client 插件的 AI 能力（notes 等）需在此配置 relay 凭据后方可使用。
            </div>
          )}

          <label className="block space-y-1">
            <span className="text-sm">Relay API Base</span>
            <input
              type="text"
              value={apiBase}
              onChange={(e) => {
                setApiBase(e.target.value);
                setSaved(false);
              }}
              placeholder="https://relay.example.com/v1"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            />
            {apiBaseError && <span className="text-xs text-red-600">{apiBaseError}</span>}
          </label>

          <label className="block space-y-1">
            <span className="text-sm">Relay Auth Token</span>
            <input
              type="password"
              value={authToken}
              onChange={(e) => {
                setAuthToken(e.target.value);
                setSaved(false);
              }}
              placeholder="••••••••"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            />
            {tokenHint && <span className="text-xs text-amber-600">{tokenHint}</span>}
          </label>

          {error && <div className="text-xs text-red-600">{error}</div>}
          {saved && <div className="text-xs text-green-600">已保存。</div>}

          <div className="flex items-center gap-2">
            <Button onClick={onSave} disabled={Boolean(apiBaseError)}>
              保存
            </Button>
            {onClose && (
              <Button variant="ghost" onClick={onClose}>
                关闭
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
