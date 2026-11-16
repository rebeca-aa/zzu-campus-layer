/**
 * 本机保存的密码 / 令牌：落盘前统一过一道 AES-GCM。
 *
 * 为什么要这层：学号密码、图书馆密码、模型 key、登录令牌都存在本机
 * （扩展是 `chrome.storage.local`，网页是 `localStorage`）。那是明文，
 * 只要能拿到浏览器数据（备份、别的扩展、root 后的手机、被导出的存储文件）
 * 就能直接读出密码。加了这层以后，磁盘上只剩密文。
 *
 * 钥匙从哪来：`crypto.subtle.generateKey` 生成一把 **AES-GCM 256** 的
 * `CryptoKey`，`extractable: false` —— 读不出裸字节，只能拿它做加密解密。
 * 它存在 IndexedDB 的密钥库里（库 `campus-layer-secure`、store `keys`、
 * 键 `device`），和站点数据一起被清掉、一起被备份。
 *
 * 代价（想清楚再改）：
 *  - 清站点数据 / 换设备 / 换浏览器 → 钥匙没了，原来存的密文解不开，得重新填一次；
 *  - 钥匙和密文在同一个源下面，挡的是「拿到存储文件」的人，不是「已经能在
 *    这个页面里跑脚本」的人 —— 那层得靠 CSP 和别把令牌往 DOM 里塞。
 *
 * 退化：环境里没有 `crypto.subtle`（老 WebView）或没有 IndexedDB 时，
 * 这一层直接失效、照旧存明文，只在控制台警告一次。宁可功能可用，
 * 也不要让用户填不了密码。
 */

import { getKV } from './kv';

/** IndexedDB 里的密钥库（每个源一份；扩展与网页各存各的） */
const DB_NAME = 'campus-layer-secure';
const DB_VERSION = 1;
const STORE = 'keys';
const KEY_ID = 'device';

/** 信封的版本号：以后要换算法就靠它认老数据 */
const SEAL_V = 2;

export interface SealedBox {
  v: typeof SEAL_V;
  alg: 'AES-GCM';
  iv: string;
  ct: string;
}

export function isSealed(raw: unknown): raw is SealedBox {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  return o.v === SEAL_V && o.alg === 'AES-GCM' && typeof o.iv === 'string' && typeof o.ct === 'string';
}

/* ---------- base64（小工具，值都不大，不做流式） ---------- */

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i] as number);
  return btoa(bin);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------- 钥匙 ---------- */

let keyTask: Promise<CryptoKey | null> | null = null;
/** 测试用：直接塞一把钥匙，绕开 IndexedDB；`undefined` = 没动过 */
let testKey: CryptoKey | null | undefined;

/** 只给测试用：注入一把钥匙（传 null 表示「这个环境没有钥匙」）。 */
export function __setSecureKeyForTest(key: CryptoKey | null | undefined): void {
  testKey = key;
  keyTask = null;
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('密钥库被占着，打不开'));
  });
}

function idbGet(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let warned = false;
function warnOnce(reason: string): void {
  if (warned) return;
  warned = true;
  console.warn(`[secure] 这台环境没有加密能力（${reason}），密码会照旧明文存在本机。`);
}

async function createKey(): Promise<CryptoKey | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    warnOnce('没有 crypto.subtle');
    return null;
  }
  if (typeof indexedDB === 'undefined') {
    warnOnce('没有 IndexedDB');
    return null;
  }
  const db = await openDb();
  const existing = await idbGet(db, KEY_ID);
  if (existing && typeof existing === 'object') return existing as CryptoKey;
  /* extractable: false —— 只有这一句能保证钥匙读不出来 */
  const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await idbPut(db, KEY_ID, key);
  return key;
}

/** 拿本机的钥匙；拿不到就返回 null（调用方退回明文）。结果会缓存。 */
function getKey(): Promise<CryptoKey | null> {
  if (testKey !== undefined) return Promise.resolve(testKey);
  if (!keyTask) {
    keyTask = withTimeout(
      createKey().catch((err) => {
        warnOnce(`密钥库读不出来：${(err as Error)?.message ?? err}`);
        return null;
      }),
      2000,
      null,
    );
  }
  return keyTask;
}

/* ---------- 加解密 ---------- */

const enc = new TextEncoder();
const dec = new TextDecoder();

/** 把「哪个键」绑进密文，防止把 A 的密文贴到 B 的位置上还能解开 */
function aad(slot: string): Uint8Array<ArrayBuffer> {
  return enc.encode(`campus-layer:${slot}`);
}

/** 加密。没有钥匙、或者钥匙坏了时返回 undefined（调用方退回明文，不能因此存不进去）。 */
export async function seal(slot: string, value: unknown): Promise<SealedBox | undefined> {
  const key = await getKey();
  if (!key) return undefined;
  try {
    const iv = new Uint8Array(new ArrayBuffer(12));
    globalThis.crypto.getRandomValues(iv);
    const plain = enc.encode(JSON.stringify(value));
    const ct = await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad(slot) },
      key,
      plain,
    );
    return { v: SEAL_V, alg: 'AES-GCM', iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
  } catch (err) {
    /* 钥匙在密钥库里坏了（系统更新会偶发）：这次先存明文，别把功能弄挂 */
    warnOnce(`加密失败：${(err as Error)?.message ?? err}`);
    return undefined;
  }
}

/** 解密。钥匙不对 / 数据坏了都返回 undefined（当没存过）。 */
export async function open(slot: string, box: SealedBox): Promise<unknown> {
  const key = await getKey();
  if (!key) return undefined;
  try {
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(box.iv), additionalData: aad(slot) },
      key,
      fromBase64(box.ct),
    );
    return JSON.parse(dec.decode(plain)) as unknown;
  } catch {
    return undefined;
  }
}

/* ---------- 给业务用的读写 ---------- */

/**
 * 读一个本该加密的键。
 * 老版本存的是明文：照常返回，并就地改写成密文（await 之后再返回，
 * 否则「读→立刻写」的调用方会被这次迁移写覆盖成旧值）。
 */
export async function readSecure<T>(key: string): Promise<T | undefined> {
  const raw = await getKV().get<unknown>(key);
  if (raw === undefined) return undefined;
  if (isSealed(raw)) {
    const opened = await open(key, raw);
    if (opened === undefined) console.warn(`[secure] ${key} 解不开（换了设备或清了站点数据？），当没存过。`);
    return opened as T | undefined;
  }
  /* 明文：顺手迁成密文（存不上也不影响这次返回） */
  try {
    await writeSecure(key, raw);
  } catch {
    /* 迁移是顺手的事，失败下次再说 */
  }
  return raw as T;
}

/** 写一个本该加密的键：有钥匙就存密文，没有就老老实实存明文。 */
export async function writeSecure(key: string, value: unknown): Promise<void> {
  const box = await seal(key, value);
  await getKV().set(key, box ?? value);
}

/** 这台环境有没有真的加密（界面想提示「已加密保存」时用）。 */
export async function secureAvailable(): Promise<boolean> {
  return (await getKey()) !== null;
}
