/**
 * secure.ts 的单元测试。
 *
 * 这里不碰真正的 IndexedDB：钥匙用 `__setSecureKeyForTest` 直接塞进来
 * （Node 里 crypto.subtle 有，IndexedDB 没有），测的是信封本身和退化行为。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __setSecureKeyForTest, isSealed, readSecure, seal, open, secureAvailable, writeSecure } from '../src/core/secure';
import { getAppCreds, saveAppCreds } from '../src/core/creds';
import { getLibCreds, saveLibCreds } from '../src/core/libCreds';

const mem = new Map<string, string>();

function installLocalStorage(): void {
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

async function newKey(): Promise<CryptoKey> {
  return globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** 存储里那条原始记录（模拟「有人把 localStorage 拷走」） */
function storedRaw(key: string): unknown {
  const raw = mem.get(`campus-layer:${key}`);
  return raw ? JSON.parse(raw) : undefined;
}

beforeEach(() => {
  mem.clear();
  installLocalStorage();
  __setSecureKeyForTest(undefined);
});

afterEach(() => {
  __setSecureKeyForTest(undefined);
});

describe('信封', () => {
  it('有钥匙时能往返，且密文里看不出原文', async () => {
    __setSecureKeyForTest(await newKey());
    const box = await seal('appCreds', { password: 'hunter2' });
    expect(box).toBeDefined();
    expect(box?.v).toBe(2);
    expect(box?.alg).toBe('AES-GCM');
    expect(JSON.stringify(box)).not.toContain('hunter2');
    expect(await open('appCreds', box!)).toEqual({ password: 'hunter2' });
  });

  it('没有钥匙就不封，直接给 undefined', async () => {
    __setSecureKeyForTest(null);
    expect(await seal('appCreds', { password: 'x' })).toBeUndefined();
    expect(await secureAvailable()).toBe(false);
  });

  it('换一把钥匙就解不开（当没存过）', async () => {
    __setSecureKeyForTest(await newKey());
    const box = await seal('appCreds', { password: 'x' });
    __setSecureKeyForTest(await newKey());
    expect(await open('appCreds', box!)).toBeUndefined();
  });

  it('密文换了槽位就解不开（AAD 绑了键名）', async () => {
    __setSecureKeyForTest(await newKey());
    const box = await seal('appCreds', { password: 'x' });
    expect(await open('libCreds', box!)).toBeUndefined();
  });
});

describe('读写与迁移', () => {
  it('writeSecure 落盘是密文，readSecure 读回原文', async () => {
    __setSecureKeyForTest(await newKey());
    await writeSecure('appCreds', { account: '2026', password: 'pw' });
    expect(isSealed(storedRaw('appCreds'))).toBe(true);
    expect(JSON.stringify(storedRaw('appCreds'))).not.toContain('pw');
    expect(await readSecure('appCreds')).toEqual({ account: '2026', password: 'pw' });
  });

  it('锁没打开时照旧存明文（老 WebView 不能因此用不了）', async () => {
    __setSecureKeyForTest(null);
    await writeSecure('appCreds', { account: '2026', password: 'pw' });
    expect(storedRaw('appCreds')).toEqual({ account: '2026', password: 'pw' });
    expect(await readSecure('appCreds')).toEqual({ account: '2026', password: 'pw' });
  });

  it('读到老明文会顺手迁成密文', async () => {
    __setSecureKeyForTest(await newKey());
    mem.set('campus-layer:appCreds', JSON.stringify({ account: 'a', password: 'old' }));
    expect(await readSecure<{ password: string }>('appCreds')).toEqual({ account: 'a', password: 'old' });
    await new Promise((r) => setTimeout(r, 10));
    expect(isSealed(storedRaw('appCreds'))).toBe(true);
  });

  it('没存过就是 undefined', async () => {
    __setSecureKeyForTest(await newKey());
    expect(await readSecure('appCreds')).toBeUndefined();
  });
});

describe('接到业务上', () => {
  it('学号密码落盘不再有明文', async () => {
    __setSecureKeyForTest(await newKey());
    await saveAppCreds({ account: '202615020223', password: 'secret-pw' });
    const raw = JSON.stringify(storedRaw('appCreds'));
    expect(raw).not.toContain('secret-pw');
    expect(raw).not.toContain('202615020223');
    const got = await getAppCreds();
    expect(got?.password).toBe('secret-pw');
    expect(got?.account).toBe('202615020223');
  });

  it('图书馆密码同理', async () => {
    __setSecureKeyForTest(await newKey());
    await saveLibCreds({ account: '202615020223', password: 'lib-pw' });
    expect(JSON.stringify(storedRaw('libCreds'))).not.toContain('lib-pw');
    expect((await getLibCreds())?.password).toBe('lib-pw');
  });
});
