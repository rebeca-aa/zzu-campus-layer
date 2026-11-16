/**
 * 「换 30 天票」用的学号 + 密码。
 *
 * 只存本机（扩展 = chrome.storage.local，网页 = localStorage），不上传、不同步、
 * 不进导出的同步码。不填也能用：那时就靠 CAS 会话换 8 小时的票。
 *
 * `deviceId` 是学校认设备用的：第一次过完短信 MFA，这台设备就被登记成可信设备，
 * 之后同一个 deviceId 再换票就不需要验证码了。所以它必须稳定，生成一次就存下来。
 *
 * 密码落盘前过 `secure.ts` 的 AES-GCM：存储里只剩密文，钥匙在本机密钥库。
 */
import type { AppCreds } from './appMint';
import { getKV } from './kv';
import { readSecure, writeSecure } from './secure';

const KEY = 'appCreds';

export interface StoredAppCreds extends AppCreds {
  savedAt: number;
  /** 这台设备过完短信验证的时间（有了它理论上就不用再验；学校那边多久放宽未知） */
  trustedAt?: number;
}

export function newDeviceId(): string {
  const bytes = new Uint8Array(8);
  const c = globalThis.crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `zzu-layer-${hex}`;
}

export async function getAppCreds(): Promise<StoredAppCreds | null> {
  const got = await readSecure<StoredAppCreds>(KEY);
  if (!got || typeof got.account !== 'string' || typeof got.password !== 'string') return null;
  if (!got.account || !got.password) return null;
  return {
    account: got.account,
    password: got.password,
    deviceId: typeof got.deviceId === 'string' && got.deviceId ? got.deviceId : newDeviceId(),
    savedAt: typeof got.savedAt === 'number' ? got.savedAt : Date.now(),
    ...(typeof got.trustedAt === 'number' && got.trustedAt > 0 ? { trustedAt: got.trustedAt } : {}),
  };
}

/** 保存（deviceId 留空则沿用旧的，没有就新生成）。换设备时「已验证」标记作废。 */
export async function saveAppCreds(input: Partial<AppCreds>): Promise<StoredAppCreds> {
  const prev = await getAppCreds();
  const account = (input.account ?? prev?.account ?? '').trim();
  const password = input.password ?? prev?.password ?? '';
  const deviceId = (input.deviceId ?? prev?.deviceId ?? '').trim() || newDeviceId();
  if (!account || !password) throw new Error('学号和密码都要填');
  const trustedAt = deviceId === prev?.deviceId ? prev?.trustedAt : undefined;
  const next: StoredAppCreds = {
    account,
    password,
    deviceId,
    savedAt: Date.now(),
    ...(trustedAt ? { trustedAt } : {}),
  };
  await writeSecure(KEY, next);
  return next;
}

/** 短信验证过了：给这台设备记一笔，界面就能显示「已登记」。 */
export async function markCredsTrusted(at = Date.now()): Promise<StoredAppCreds | null> {
  const prev = await getAppCreds();
  if (!prev) return null;
  const next: StoredAppCreds = { ...prev, trustedAt: at };
  await writeSecure(KEY, next);
  return next;
}

export async function clearAppCreds(): Promise<void> {
  await getKV().remove(KEY);
}

/** 只给界面看的脱敏描述。 */
export function describeCreds(creds: StoredAppCreds | null): string {
  if (!creds) return '未绑定';
  const device = `设备 ${creds.deviceId}`;
  return `${creds.account} · ${device}${creds.trustedAt ? ' · 已过短信验证' : ' · 待短信验证'}`;
}
