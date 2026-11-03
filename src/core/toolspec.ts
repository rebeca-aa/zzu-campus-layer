/**
 * 工具规格：给「支持 function calling 的模型」看的 JSON Schema（OpenAI tools 格式）。
 *
 * 为什么不从 zod 自动转：我们只有 10 个工具，手写一遍更可控，
 * 而且描述文案（什么时候用、参数怎么填）本来就是给模型看的提示词，值得单独打磨。
 *
 * 与 `tools.ts` 的 zod schema 是两份：zod 负责运行时校验（严），
 * JSON Schema 负责告诉模型怎么填（宽 + 带说明）。两者字段必须对齐，
 * `test/toolspec.test.ts` 会核对。
 */
import { TOOLS, type ToolName } from './tools';

export interface JsonSchemaProperty {
  type?: string;
  description?: string;
  enum?: string[];
  anyOf?: JsonSchemaProperty[];
  items?: JsonSchemaProperty;
  minimum?: number;
  maximum?: number;
  default?: unknown;
}

export interface ToolSpec {
  type: 'function';
  function: {
    name: ToolName;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, JsonSchemaProperty>;
      required?: string[];
      additionalProperties?: boolean;
    };
  };
}

const DAY: JsonSchemaProperty = {
  anyOf: [
    { type: 'string', enum: ['today', 'tomorrow'] },
    { type: 'integer', minimum: 1, maximum: 7 },
  ],
  description: '哪天：today / tomorrow，或 1-7（周一=1）。用户说「明天/后天」时优先用 today/tomorrow 语义，不要自己算成具体日期。',
};

const PERIOD: JsonSchemaProperty = {
  type: 'string',
  enum: ['morning', 'afternoon', 'evening'],
  description: '时段：morning 上午（1-4 节）/ afternoon 下午（5-8 节）/ evening 晚上（9-10 节）。用户说「上午/下午/晚上」时必须带上。',
};

export const TOOL_SPECS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'find_study_spot',
      description:
        '找现在就能连坐一会儿的地方：把空教室（含能坐多久）和图书馆余量合起来排序。用户说「我想自习两小时」「哪能安静看会儿书」「找个地方学习」就用它，不要连续调 find_free_room + library_seats。',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
          needMinutes: { type: 'integer', description: '需要连坐多少分钟，默认 120' },
          near: { type: 'string', description: '从哪出发（楼名或教室名，如 北3_403）' },
          maxWalkMin: { type: 'integer', description: '最多愿意走几分钟' },
        },
        additionalProperties: false,
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'get_schedule',
      description:
        '查这名学生自己的课表。可以整周、按天（今天/明天/周几）、按时段（上午/下午/晚上）查。' +
        '用户问「今天/明天有课吗」「下午有课吗」都用它，不要用空教室工具。',
      parameters: {
        type: 'object',
        properties: {
          week: { type: 'integer', minimum: 1, maximum: 30, description: '教学周次（绝对）；不填=当前周' },
          weekOffset: {
            type: 'integer',
            minimum: -4,
            maximum: 4,
            description: '相对周次：0=本周、1=下周、-1=上周。用户说「下周/上周」时用它，不要自己算周号',
          },
          day: DAY,
          period: PERIOD,
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_free_room',
      description:
        '查某天有哪些空教室/自习室可用（全校教室减去当天占用）。' +
        '用户问「哪里能自习」「明天下午哪间教室空着」「南核空教室」时用。',
      parameters: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            description: '日期 YYYY-MM-DD。**用户说今天/明天/后天时不要填这个字段**，交给服务端按相对日期算，模型自己算日期不可靠。',
          },
          campus: { type: 'string', description: '校区，例如 主校区 / 南校区 / 北校区' },
          building: {
            type: 'string',
            description:
              '地点原词，按教室名前缀过滤：南核 / 北核 / 核心教学区 / 北1 / 南2 / 物理馆 / 材料馆 / 化学馆 / 图书馆。' +
              '用户提到具体楼或教学区时，原样填他说的词。',
          },
          minSeats: { type: 'integer', minimum: 0, description: '最少座位数（多数教室没有座位数据，筛完可能变少）' },
          sections: {
            type: 'array',
            items: { type: 'integer', minimum: 1, maximum: 20 },
            description: '只想要这些节次都空着的教室，例如 [5,6,7,8] 表示下午 5-8 节',
          },
          roomTypeIds: {
            type: 'array',
            items: { type: 'string' },
            description: '教室类型：1=普通教室 2=多媒体教室（默认就查这两类）5=实验室',
          },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: '最多列几间，默认 12' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_notices',
      description:
        '查通知卡片（唯一通知入口）：讲座 / 比赛 / 活动 / 会议 / 教务 / 生活 六类，教务还会细到选课/考试/成绩/学籍/毕业/实习等子类。' +
        '每条给标题、分类、活动时间、地点、报名截止。用户问「最近的通知」「今天有什么讲座」「最近有比赛吗」' +
        '「这周有什么活动」「×× 什么时候截止」都用它。没有截止或地点就是没抽到，别自己补。',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            enum: ['lecture', 'competition', 'activity', 'meeting', 'academic', 'life'],
            description:
              '只要某一类：lecture=讲座/报告，competition=比赛/竞赛，activity=活动，meeting=会议，academic=教务，life=生活。不填=全部',
          },
          topic: {
            type: 'string',
            description:
              '子类，主要给教务用：选课 / 考试 / 成绩 / 学籍 / 毕业 / 实习实践 / 论文 / 培养方案 / 教学 / 四六级 / 评教。不填=不按子类筛',
          },
          keyword: {
            type: 'string',
            description: '关键词，原词即可（「挑战杯」「选课」「大模型」）。会做同义词扩展，不要自己造句。',
          },
          withinDays: {
            type: 'integer',
            minimum: 0,
            maximum: 365,
            description: '时间窗：最近 N 天发布的，或今天起 N 天内截止/开讲的。0=只看今天；不填=不限时间。',
          },
          sort: {
            type: 'string',
            enum: ['published', 'deadline'],
            description: 'published=按发布时间倒序（默认）；deadline=按截止日临近排，问「什么时候截止」时用。',
          },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: '最多几条，默认 12' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_grades',
      description:
        '查成绩与绩点。可按课程名过滤（用户问「高数多少分」「哪门拉低了绩点」时把课名填进 course）。' +
        '返回分数、学分、绩点，以及服务端给出的构成分（平时/期中/期末/卷面，不同课字段不同，没有就不显示）。',
      parameters: {
        type: 'object',
        properties: {
          course: { type: 'string', description: '课程名或其中一段，例如 高数 / 线性代数 / 英语。不填=全部' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_exams',
      description: '查考试安排（时间、地点、座位号）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_plan_progress',
      description: '查培养方案完成情况：总学分要求、已通过、在修、还差多少，以及各模块缺口与未修课程。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '培养类型 code，默认 01（主修）' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_card',
      description: '查校园一卡通：余额、最近消费/充值流水。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_todos',
      description: '查待办事项：待办/在办/待申请计数与具体条目。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'library_seats',
      description:
        '查图书馆**实时空座数**（各馆空闲/总数，免登录）。用户问「图书馆还有位置吗」「自习去哪坐」「几楼有空位」时用。' +
        '只给馆级余量；要看**具体哪个座位空着**用 library_seat_map，要下单用 book_library_seat。',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: '日期 YYYY-MM-DD；不填=今天。用户说今天/明天时**不要填**，让服务端按相对日期算。' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'library_seat_map',
      description:
        '读某区域某天的**座位级**空闲情况（列出空着的座位号）。需要用户先在「我的 → 图书馆登录」登录（别让他点网页链接，那个登录用不了，也不要输出网址）；若没登录，工具会让你引导他去设置面板登录。' +
        '用户问「一楼大厅哪些座位空着」「A12 有人吗」时用。二层以上一层里有多间自习室：只给楼层会列出该层所有房间并各画一张图，给了 room 就只画那一间。' +
        '**不要编造座位号**，只说工具返回的。',
      parameters: {
        type: 'object',
        properties: {
          floor: { type: 'string', enum: ['一楼', '二楼', '三楼', '四楼'], description: '楼层（中文）。用户说"二楼""三楼"就填它，不要自己编数字 id。' },
          room: { type: 'string', description: '具体房间名，如「语言文史书库」「电子阅览室」「在线电子阅览室」。用户点名房间时填；不填则用楼层代表房间。' },
          date: { type: 'string', description: '日期 YYYY-MM-DD' },
        },
        required: ['date'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'book_library_seat',
      description:
        '**准备**一条图书馆座位预约（不会自己下单）。用户明确说「帮我订 001」「订一楼大厅 A12，明天」时调用。' +
        '调用后界面上会出现需要**长按**的确认按钮，用户长按才真正提交——所以你可以直接调，但要告诉用户「长按下面那个按钮才会提交」。' +
        '座位号必须来自 library_seat_map 的结果。',
      parameters: {
        type: 'object',
        properties: {
          floor: { type: 'string', enum: ['一楼', '二楼', '三楼', '四楼'], description: '楼层（中文）。用户说"二楼""三楼"就填它，不要自己编数字 id。' },
          room: { type: 'string', description: '具体房间名，如「语言文史书库」「电子阅览室」「在线电子阅览室」。用户点名房间时填；不填则用楼层代表房间。' },
          date: { type: 'string', description: '日期 YYYY-MM-DD' },
          seatNo: { type: 'string', description: '座位号，例如 "001"（必须来自座位图结果）' },
        },
        required: ['date', 'seatNo'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_service',
      description:
        '给出学校某个在线服务的入口（面板会渲染成可点按钮）：网上办事大厅、图书馆、智慧食堂、报修、云盘、校历…' +
        '用户想「去某处办事/预约/查」但这件事没有对应工具时用它。注意：它只给入口，**不能代替用户完成预约**。' +
        '座位预约例外：那个站网页登录走不通，返回里没有链接，只说去「我的 → 图书馆登录」，你不要另外贴网址。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '服务名或口语说法，例如 座位预约 / 报修 / 奖学金 / 图书馆' },
        },
        required: ['keyword'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'export_ics',
      description: '把整学期课表导出成 iCalendar（.ics），可导入手机日历。',
      parameters: {
        type: 'object',
        properties: {
          fromWeek: { type: 'integer', minimum: 1, maximum: 30, description: '从第几周开始' },
          toWeek: { type: 'integer', minimum: 1, maximum: 30, description: '到第几周结束' },
        },
        additionalProperties: false,
      },
    },
  },
];

/** 只保留 TOOLS 里真实存在的工具（防止规格文件里写了不存在的名字）。 */
export function activeToolSpecs(): ToolSpec[] {
  return TOOL_SPECS.filter((s) => s.function.name in TOOLS);
}
