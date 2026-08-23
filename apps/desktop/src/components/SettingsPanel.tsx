// SettingsPanel.tsx — 应用设置（relay 凭据录入，C2 决策）。
//
// client 插件的 AI 能力（notes 等）通过宿主 client_* 代理命令调用 relay；凭据不进 iframe，
// 由用户在此页录入，经 set_relay_settings 落到宿主。空串 → null（Rust 归一为 None）。
import { useCallback, useEffect, useState } from 'react';
import { tauriInvoke, errorMessage } from '@/lib/api';
import { validateRelayApiBase, relayTokenHint } from '@/lib/relaySettings';
import { Button } from '@/components/ui/button';

interface RelaySettings {
  api_base?: string;
  auth_token?: string;
}

export function SettingsPanel({ onClose }: { onClose?: () => void }) {
  const [apiBase, setApiBase] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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

  return (
    <div className="space-y-5">
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
