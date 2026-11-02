/**
 * 图书馆那套账号（学号 + 图书馆密码）。
 *
 * 图书馆跟统一身份认证是两套账号：主登录换出来的 30 天票是 uniapp 的 idToken，
 * 签不出图书馆要的 CAS ticket，所以这里单独存一份密码，等要用的那一刻
 * （扩展里打开图书馆页 / 壳里点「登录图书馆」）再拿它去登一次。
 *
 * 存在本机，不进同步码，也不上传。
 */
import { getKV } from './kv';

const KEY = 'libCreds';

export interface LibCreds {
  account: string;
  password: string;
  /** 上次成功登录（拿到 sessionStorage.token）的时间 */
  at?: number;
}

function norm(raw: unknown): LibCreds | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Partial<LibCreds>;
  const account = typeof o.account === 'string' ? o.account.trim() : '';
  const password = typeof o.password === 'string' ? o.password : '';
  if (!account || !password) return null;
  return typeof o.at === 'number' ? { account, password, at: o.at } : { account, password };
}

export async function getLibCreds(): Promise<LibCreds | null> {
  try {
    return norm(await getKV().get<unknown>(KEY));
  } catch {
    return null;
  }
}

export async function saveLibCreds(creds: LibCreds): Promise<LibCreds> {
  const clean = norm(creds);
  if (!clean) throw new Error('学号和图书馆密码都要填');
  await getKV().set(KEY, clean);
  return clean;
}

/** 登进去过一次（拿到 token）就记一笔，界面上显示「已绑定」 */
export async function markLibBound(at = Date.now()): Promise<void> {
  const cur = await getLibCreds();
  if (!cur) return;
  await getKV().set(KEY, { ...cur, at });
}

export async function clearLibCreds(): Promise<void> {
  await getKV().remove(KEY);
}

export function describeLib(creds: LibCreds | null): string {
  if (!creds) return '未绑定';
  if (!creds.at) return '已存下，还没登过';
  const days = Math.max(0, Math.floor((Date.now() - creds.at) / 86_400_000));
  return days === 0 ? '今天登过' : `${days} 天前登过`;
}
