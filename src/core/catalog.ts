/**
 * 门户（豫见郑大）的服务目录：来自 /v2/service/serviceShowAll 与 /v1/service/list 的实测结果。
 * 用途：一句话直达——「打开办事大厅」直接给链接，不用在 App 里翻。
 * 例外：座位预约标了 noLink，那个站网页登录在 App 里走不通，改指「我的 → 图书馆登录」。
 */
export interface PortalService {
  name: string;
  url: string;
  /** 分类（门户里的分组） */
  group: string;
  /** 一句话说明它到底能干什么 */
  what: string;
  /** 口语别名，用于匹配 */
  aliases?: string[];
  /** 是否只能在校内网 / 需要 VPN */
  campusOnly?: boolean;
  /**
   * 不给入口链接：这个站的网页登录在 App 里走不通（点了也登不上），
   * 统一改成去「我的 → 图书馆登录」，AI 那边也不许甩链接。
   */
  noLink?: boolean;
}

export const PORTAL_SERVICES: PortalService[] = [
  {
    name: '座位预约',
    // 这个站只有 http：443 直接拒连（TLS 没配好），所以链接必须写 http，写 https 用户点开就是空白/证书错
    url: 'http://order.lib.zzu.edu.cn/h5/index.html#/seat/index',
    group: '图书馆',
    what: '图书馆座位/自习位预约',
    noLink: true,
    aliases: ['自习', '占座', '抢座', '图书馆座位', '自习室', '预约座位', '预约位置', '图书馆位置', '图书馆一楼', '订座', '找个位置'],
  },
  {
    name: '网上办事大厅',
    url: 'https://ehall.v.zzu.edu.cn/taskcenter',
    group: '办事',
    what: '各类申请、证明、审批事项的入口',
    aliases: ['办事', '办事大厅', '申请', '证明', '审批', '请假', '证明打印'],
  },
  {
    name: '网络报修',
    url: 'https://ecard.v.zzu.edu.cn/repair-management-h5/',
    group: '生活',
    what: '宿舍网络/线路报修',
    aliases: ['报修', '网络坏了', '断网', '维修'],
  },
  {
    name: '图书馆',
    url: 'https://library.zzu.edu.cn/',
    group: '图书馆',
    what: '馆藏检索、借阅与续借、电子资源',
    aliases: ['图书馆', '借书', '还书', '续借', '馆藏', '文献'],
  },
  {
    name: '学术搜递',
    url: 'https://sodi.zzu.superlib.net/',
    group: '图书馆',
    what: '文献传递/论文检索（超星）',
    aliases: ['文献传递', '论文检索', '学术搜递', '查文献'],
  },
  {
    name: '智慧食堂',
    url: 'http://222.22.63.118:58100/h5/',
    group: '生活',
    what: '食堂订餐/取餐、消费记录',
    aliases: ['订餐', '食堂', '吃饭', '取餐', '点餐'],
  },
  {
    name: '校历查询',
    url: 'https://jw.v.zzu.edu.cn/app-ws/ws/app-service/super/app/index?redirectURI=/schoolCalendar',
    group: '教学',
    what: '校历、开学/放假时间',
    aliases: ['校历', '放假', '开学时间'],
  },
  {
    name: '培养计划查询',
    url: 'https://jw.v.zzu.edu.cn/app-ws/ws/app-service/super/app/index?redirectURI=/studentPlan',
    group: '教学',
    what: '培养方案与学分要求（网页版）',
    aliases: ['培养方案', '培养计划', '学分要求'],
  },
  {
    name: '个人云盘',
    url: 'https://pan.v.zzu.edu.cn/',
    group: '工具',
    what: '校内网盘',
    aliases: ['网盘', '云盘', '存文件'],
    campusOnly: true,
  },
  {
    name: '校园地理信息服务平台',
    url: 'https://ksh-ms.v.zzu.edu.cn/',
    group: '工具',
    what: '校园地图/楼栋定位',
    aliases: ['地图', '校园地图', '找楼', '教学楼在哪'],
  },
  {
    name: '网络报修状态',
    url: 'https://ecard.v.zzu.edu.cn/repair-management-h5/',
    group: '生活',
    what: '报修工单进度',
    aliases: ['报修进度', '工单'],
  },
  {
    name: '会务接待系统',
    url: 'https://hwjd.zzu.edu.cn/',
    group: '办事',
    what: '会议室/接待申请',
    aliases: ['会议室', '会务', '接待'],
  },
  {
    name: '学生奖惩助贷查询',
    url: 'https://authx-service.s.zzu.edu.cn/authSecond/api/open/accessCas/login?key=reward',
    group: '办事',
    what: '奖学金/助学金/贷款/处分记录',
    aliases: ['奖学金', '助学金', '助学贷款', '评奖', '处分'],
  },
  {
    name: '校园通行微服务群',
    url: 'https://jf.v.zzu.edu.cn/jksb/servlet/casApi',
    group: '生活',
    what: '门禁/出入校申请（点击量最高）',
    aliases: ['出入校', '门禁', '通行', '返校', '离校'],
  },
  {
    name: '厚山学习平台',
    url: 'https://course101.zzu.edu.cn/m',
    group: '教学',
    what: '101 计划课程学习',
    aliases: ['厚山', '学习平台', '101'],
  },
  {
    name: 'DeepSeek（学校自建）',
    url: 'http://chat.zzu.edu.cn',
    group: 'AI',
    what: '校内 Open WebUI，DeepSeek-R1',
    aliases: ['deepseek', '学校模型', '校内ai'],
    campusOnly: true,
  },
  {
    name: 'AI 大模型农场',
    url: 'https://jksb.v.zzu.edu.cn/ds2025.htm',
    group: 'AI',
    what: '另一个 DeepSeek 入口（独立账号+图形验证码）',
    aliases: ['ai农场', '大模型农场', 'aifarm'],
  },
  {
    name: 'AI4S 平台',
    url: 'https://auth.zzu.edu.cn:8080/kyaiunion/zzu',
    group: 'AI',
    what: '科研 AI 平台',
    aliases: ['ai4s', '科研ai'],
  },
  {
    name: '校园码（离线码）',
    url: 'https://uniapp.s.zzu.edu.cn/pages/tab/index/index',
    group: '生活',
    what: '校园码需要在 App 内离线使用，网页端只到门户首页',
    aliases: ['校园码', '离线码', '二维码'],
  },
];

export interface ServiceMatch {
  service: PortalService;
  score: number;
  /** 命中的字面长度，仅用于同分排序 */
  hitLen?: number;
}

/** 关键词匹配：名字命中 > 别名命中 > 「什么」描述命中。 */
export function matchServices(keyword: string, limit = 3): ServiceMatch[] {
  const q = keyword.trim().toLowerCase();
  if (!q) return [];
  const scored: ServiceMatch[] = [];

  for (const service of PORTAL_SERVICES) {
    let score = 0;
    /** 命中的字面长度：同分时更长的说法更具体（「图书馆一楼」应压过「图书馆」） */
    let hitLen = 0;
    const name = service.name.toLowerCase();
    if (name === q) {
      score = 100;
      hitLen = name.length;
    } else if (name.includes(q)) {
      score = 80;
      hitLen = q.length;
    } else if (q.includes(name)) {
      score = 70;
      hitLen = name.length;
    }
    if (!score) {
      for (const alias of service.aliases ?? []) {
        const a = alias.toLowerCase();
        if (a === q) {
          score = Math.max(score, 90);
          hitLen = Math.max(hitLen, a.length);
        } else if (q.includes(a)) {
          // 「预约图书馆一楼的位置」里「图书馆一楼」比服务名「图书馆」更具体，
          // 所以别名被整句包含时给 78 分，压过「名字被整句包含」的 70 分。
          score = Math.max(score, 78);
          hitLen = Math.max(hitLen, a.length);
        } else if (a.includes(q)) {
          score = Math.max(score, 70);
          hitLen = Math.max(hitLen, q.length);
        }
      }
    }
    if (!score && service.what.toLowerCase().includes(q)) {
      score = 30;
      hitLen = q.length;
    }
    if (score) scored.push({ service, score, hitLen });
  }

  return scored
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.hitLen ?? 0) - (a.hitLen ?? 0) ||
        a.service.name.localeCompare(b.service.name, 'zh-Hans-CN'),
    )
    .slice(0, limit);
}
