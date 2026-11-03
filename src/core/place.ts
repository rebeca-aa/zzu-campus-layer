/**
 * 地点词 → 教室名前缀。
 *
 * 背景：教室名长这样 —— `南1_303`、`北3_403`、`物_505`、`材_606`、`北区2_101`。
 * 学生嘴里说的是「南核」「北核」「物理馆」「北1」，跟这些名字对不上，
 * 于是「明天南核空教室」会被当成「不限楼」——查出来一堆北1/北2 的教室。
 *
 * 这个模块只做一件事：把口语地点换成教室名前缀，然后按前缀过滤。
 */

export interface PlaceAlias {
  /** 用来显示的名字 */
  label: string;
  /** 匹配到的原文（用于回显「你说的 XX 我按 YY 查」） */
  raw: string;
  /** 教室名前缀，如 '南1'（教室名 `南1_303` → 前缀 `南1`） */
  prefixes: string[];
  /** 补充匹配：楼号会一直加（南4、南5…），前缀表追不上时用它兜住 */
  re?: RegExp;
}

interface Rule {
  re: RegExp;
  label: string;
  prefixes: string[];
  /** 教室名补充匹配（见 PlaceAlias.re） */
  roomRe?: RegExp;
}

/** 南核心教学区的楼号不是固定三栋：实网楼栋表里 南1–南5 都在（2026-11-03 实测）。 */
const SOUTH_CORE = /^南[1-9]\d*_/;
const SOUTH_CORE_PREFIXES = ['南1', '南2', '南3', '南4', '南5'];

/** 顺序有意义：更具体的写在前面（「南核」要先于「核心教学区」）。 */
const RULES: Rule[] = [
  { re: /南核(?:心)?(?:教学)?区?/, label: '南核心教学区（南1–南5）', prefixes: SOUTH_CORE_PREFIXES, roomRe: SOUTH_CORE },
  { re: /北核(?:心)?(?:教学)?区?/, label: '北核心教学区（北1–北5）', prefixes: ['北1', '北2', '北3', '北4', '北5'] },
  {
    re: /核心教学区/,
    label: '核心教学区（南1–南5、北1–北5）',
    prefixes: [...SOUTH_CORE_PREFIXES, '北1', '北2', '北3', '北4', '北5'],
    roomRe: SOUTH_CORE,
  },
  { re: /物理馆|物馆/, label: '物理馆', prefixes: ['物'] },
  { re: /材料馆|材馆/, label: '材料馆', prefixes: ['材'] },
  { re: /化学馆|化馆/, label: '化学馆', prefixes: ['化'] },
  { re: /数学馆|数馆/, label: '数学馆', prefixes: ['数'] },
  { re: /图书馆/, label: '图书馆', prefixes: ['图'] },
];

/**
 * 从一句话里认出地点。
 * 先查别名表，再退化到「楼号」（北1、南2、东3…），最后什么都没认出来 → null。
 */
export function resolvePlace(text: string): PlaceAlias | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  for (const rule of RULES) {
    const m = rule.re.exec(t);
    if (m) {
      return {
        label: rule.label,
        raw: m[0],
        prefixes: rule.prefixes,
        ...(rule.roomRe ? { re: rule.roomRe } : {}),
      };
    }
  }
  // 楼号：北1 / 南2 / 东3；要排除「南校区」「北校区」这种没有数字的说法
  const num = /(南|北|东|西)\s*([1-9]\d?)(?![\d])/.exec(t);
  if (num?.[1] && num[2]) {
    const prefix = `${num[1]}${num[2]}`;
    return { label: `${prefix} 楼`, raw: num[0], prefixes: [prefix] };
  }
  return null;
}

/** 教室名 → 前缀：`南1_303` → `南1`，`北区2_101` → `北区2`。 */
export function roomPrefix(name: string): string {
  return (name.split(/[_\s（(]/)[0] ?? name).trim();
}

/**
 * 这间教室在不在该地点范围内（`南1_303` 在「南核」里，`北区2_101` 不在）。
 *
 * 先用前缀表；带 `re` 的地方（南核/核心教学区）再补一道楼号正则，
 * 这样新盖一栋「南6」不用改代码也能查到。
 */
export function roomInPlace(roomName: string, place: PlaceAlias): boolean {
  const p = roomPrefix(roomName);
  const byPrefix = place.prefixes.some((pre) => p === pre || (p.startsWith(pre) && !/\d/.test(p.charAt(pre.length))));
  if (byPrefix) return true;
  return place.re ? place.re.test(roomName) : false;
}

/** 给人看的说明，例如「只查 南核心教学区（南1–南5）」。 */
export function placeHint(place: PlaceAlias): string {
  return `只查 ${place.label}`;
}
