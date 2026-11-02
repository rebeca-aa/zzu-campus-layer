/**
 * 登录页（PWA / 壳共用一套）：一屏只有一件事——账号密码换 30 天的票；
 * 图书馆作为同一屏的第二块（同一套账号，密码可能不一样，补一次就行）。
 *
 * 其他方式（粘同步码、导出、清除）在 main.tsx 里折进「其他方式」，不放这儿。
 */
import { useEffect, useState } from 'preact/hooks';
import { mintViaApp, mintViaAppState } from '../src/core/appMint';
import {
  canBindInShell,
  startBind,
  startBindInShell,
  submitCode,
  submitCodeInShell,
  type BindContext,
} from '../src/core/appBind';
import { canMintInBrowser } from '../src/core/casMint';
import { getAppCreds, markCredsTrusted, saveAppCreds, type StoredAppCreds } from '../src/core/creds';
import { describeLib, getLibCreds, markLibBound, saveLibCreds, type LibCreds } from '../src/core/libCreds';
import { saveToken } from '../src/core/storage';

type Mode = 'shell' | 'fetch' | 'none';

function bindMode(): Mode {
  if (canBindInShell()) return 'shell';
  if (canMintInBrowser()) return 'fetch';
  return 'none';
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'busy'; what: string }
  | { kind: 'code'; ctx: BindContext; phone: string };

interface Props {
  /** 已经登录时外面传进来的一句话（比如「28 天」） */
  signedIn?: string;
  /** 登录成功 / 换到新票后叫外面刷新状态 */
  onSignedIn: () => void;
  /** 这台设备（浏览器）换不了票：走登录页那条路 */
  onOpenLogin: () => void;
}

export function LoginPage({ signedIn, onSignedIn, onOpenLogin }: Props) {
  const mode = bindMode();
  const [saved, setSaved] = useState<StoredAppCreds | null>(null);
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [note, setNote] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const [lib, setLib] = useState<LibCreds | null>(null);
  const [libPwd, setLibPwd] = useState('');
  const [libNote, setLibNote] = useState('');

  useEffect(() => {
    void (async () => {
      const got = await getAppCreds();
      setSaved(got);
      if (got) setAccount(got.account);
      setLib(await getLibCreds());
    })();
  }, []);

  async function storeToken(token: string): Promise<void> {
    await saveToken('jwxt', token);
    await saveToken('portal', token);
  }

  async function mintNow(creds?: StoredAppCreds): Promise<void> {
    const out = await mintViaApp(creds ?? (await getAppCreds()) ?? { account, password, deviceId: saved?.deviceId ?? '' });
    if (out.ok) {
      await storeToken(out.idToken);
      onSignedIn();
      setNote('');
    } else if (out.reason === 'mfa') {
      setNote('这台设备还要过一次短信验证');
    } else {
      setNote(out.detail ?? '换票没成');
    }
  }

  async function signIn(): Promise<void> {
    setNote('');
    if (mode === 'none') {
      onOpenLogin();
      return;
    }
    const useSaved = Boolean(saved) && !password && account.trim() === (saved?.account ?? '');
    let creds: StoredAppCreds;
    if (useSaved && saved) {
      creds = saved;
    } else {
      try {
        creds = await saveAppCreds({ account, password });
        setSaved(creds);
        setPassword('');
      } catch (err) {
        setNote(err instanceof Error ? err.message : '保存失败');
        return;
      }
    }
    if (creds.trustedAt) {
      setPhase({ kind: 'busy', what: '登录中…' });
      await mintNow(creds);
      setPhase({ kind: 'idle' });
      return;
    }
    setPhase({ kind: 'busy', what: '发送短信…' });
    const started = mode === 'shell' ? await startBindInShell(creds) : await startBind(creds);
    if (!started.ok) {
      setPhase({ kind: 'idle' });
      setNote(started.detail ?? '发验证码失败');
      return;
    }
    if (started.trusted) {
      setPhase({ kind: 'busy', what: '登录中…' });
      await mintNow(creds);
      setPhase({ kind: 'idle' });
      return;
    }
    setPhase({ kind: 'code', ctx: started.ctx, phone: started.phone });
  }

  async function verify(): Promise<void> {
    if (phase.kind !== 'code') return;
    const ctx = phase.ctx;
    setPhase({ kind: 'busy', what: '校验…' });
    const out = mode === 'shell' ? await submitCodeInShell(code) : await submitCode(ctx, code);
    if (!out.ok) {
      setPhase({ kind: 'code', ctx, phone: phase.phone });
      setNote(out.detail ?? '验证码不对');
      return;
    }
    await markCredsTrusted();
    const fresh = await getAppCreds();
    setSaved(fresh);
    setCode('');
    if (out.idToken) {
      await storeToken(out.idToken);
      setPhase({ kind: 'idle' });
      onSignedIn();
      return;
    }
    const minted = fresh ? await mintViaAppState(fresh, ctx.state) : { ok: false as const, reason: 'network' as const };
    setPhase({ kind: 'idle' });
    if (minted.ok) {
      await storeToken(minted.idToken);
      onSignedIn();
    } else {
      setNote('设备已登记，这次换票没成，下次会自动再试');
    }
  }

  async function bindLib(): Promise<void> {
    setLibNote('');
    try {
      const next = await saveLibCreds({ account: account.trim(), password: libPwd.trim() });
      setLib(next);
      setLibPwd('');
      const rt = (globalThis as { chrome?: { runtime?: { id?: unknown; sendMessage?: (m: unknown) => Promise<unknown> } } })
        .chrome?.runtime;
      if (!rt?.id || !rt.sendMessage) {
        setLibNote('已存下');
        return;
      }
      setLibNote('登录中…');
      const res = (await rt.sendMessage({
        type: 'lib:autologin',
        args: { account: next.account, password: next.password },
      })) as { ok?: boolean; error?: string } | undefined;
      if (res?.ok) {
        await markLibBound();
        setLib(await getLibCreds());
        setLibNote('');
        onSignedIn();
      } else {
        setLibNote(res?.error ?? '没登上，稍后再试');
      }
    } catch (err) {
      setLibNote(err instanceof Error ? err.message : '保存失败');
    }
  }

  const busy = phase.kind === 'busy';
  const inCode = phase.kind === 'code';
  const canPress = Boolean(account.trim()) && (Boolean(password) || (saved && account.trim() === saved.account));
  const libSame = lib && lib.account === account.trim();

  return (
    <div class="login-page">
      <div class="card login-card">
        <div class="login-head">
          <strong>登录</strong>
          <span class="login-state">{signedIn ? `已登录 · ${signedIn}` : mode === 'none' ? '这台设备换不了票' : '教务 · 门户'}</span>
        </div>
        {!inCode && mode !== 'none' && (
          <>
            <label class="lingrid">
              <span>学号</span>
              <input
                inputMode="numeric"
                autocomplete="username"
                placeholder="学号"
                value={account}
                onInput={(e) => setAccount((e.currentTarget as HTMLInputElement).value)}
              />
            </label>
            <label class="lingrid">
              <span>密码</span>
              <input
                type="password"
                autocomplete="current-password"
                placeholder={saved ? '已存过，可不填' : '统一身份认证密码'}
                value={password}
                onInput={(e) => setPassword((e.currentTarget as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void signIn();
                }}
              />
            </label>
          </>
        )}
        {inCode && (
          <label class="lingrid">
            <span>验证码</span>
            <input
              inputMode="numeric"
              maxLength={8}
              placeholder={`短信里 ${phase.phone ? '的 4~6 位' : ''}`}
              value={code}
              onInput={(e) => setCode((e.currentTarget as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void verify();
              }}
            />
          </label>
        )}
        <button
          class="primary wide"
          disabled={busy || (mode !== 'none' && (inCode ? code.trim().length < 4 : !canPress))}
          onClick={() => void (inCode ? verify() : signIn())}
        >
          {busy ? (phase.what ?? '处理中…') : inCode ? '确认' : mode === 'none' ? '去登录' : '登录'}
        </button>
        {note && <p class="hint warn">{note}</p>}
      </div>

      {mode !== 'none' && (
        <div class="card login-card">
          <div class="login-head">
            <strong>图书馆</strong>
            <span class="login-state">{libSame ? describeLib(lib) : '另填密码'}</span>
          </div>
          <label class="lingrid">
            <span>密码</span>
            <input
              type="password"
              autocomplete="off"
              placeholder={lib?.password ? '已存过，可不填' : '图书馆密码（可能和上面不一样）'}
              value={libPwd}
              onInput={(e) => setLibPwd((e.currentTarget as HTMLInputElement).value)}
            />
          </label>
          <button class="ghost wide" disabled={!account.trim() || !libPwd.trim()} onClick={() => void bindLib()}>
            保存
          </button>
          {libNote && <p class="hint">{libNote}</p>}
        </div>
      )}
    </div>
  );
}
