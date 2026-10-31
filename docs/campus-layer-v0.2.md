# 校园信息层 · v0.2 修订（实测版）

> 取代 `campus-layer-handoff.md`（v0.1）中的架构主路径、权限策略、Schema 与验收标准。
> 修订依据：`campus-site-probe.md`、`campus-platform-architecture.md`，以及 `campus-layer/` 里已跑通的实现。
> 日期：2026-10-20

## 0. 一句话

v0.1 假设「用 content script 解析教务网页的 DOM」。实测后这一层不需要：学生端的门户与教务都是 uni-app SPA，App 与网页共用同一份前端、靠 `X-Terminal-Info` 区分渠道；拿到 CAS 下发的 `idToken` 后，所有数据都能用 JSON API 直取。**v0.2 的主路径 = 取 token + 直连 API + 本地归一化 + 模板回答**，DOM 解析整层删除。

## 1. 与 v0.1 的差异总表

| # | v0.1 的要求 | v0.2 的处理 | 依据 |
| --- | --- | --- | --- |
| 1 | Adapter 层：`parse(input): T[]` / `selfTest()` / `matches(url)`，按页面解析 DOM | **删除**。改为 `src/core/{portal,jwxt}.ts` 里的纯函数，输入 API JSON | 两站点 DOM 无稳定语义；API 稳定且字段齐全 |
| 2 | C5「禁用 `nth-child` 选择器」 | 自动满足（无 DOM 选择器） | — |
| 3 | C1「只申请两个占位教务域」 | 改成 **14 个真实域**白名单（8 个学校域 + 6 家模型服务商，见 §3），仍不申请 `<all_urls>` | 跨源 fetch 必须靠 host_permissions |
| 4 | §7.3 让用户自填 `baseUrl` | **删除**。域名固定，不开放任意端点 | 任意 baseUrl 会引入 `Failed to fetch` 与 SSRF 面 |
| 5 | 巡检（路径 C，判断是否登录） | **删除**。改用 `code:-1 没有访问权限01` + JWT `exp` 双重判定 | 服务端把未登录塞进 HTTP 200，跳转判定必然误判 |
| 6 | `get_schedule(week)` 缺学期首周 | `Term.startDate` 由 `/semester/current-semester` 给出（2026-09-07） | 服务端权威 |
| 7 | `TimeSlot` 手工维护节次时间 | 用 `/room/system/course-units` 的 10 条权威节次表 | 无需硬编码 |
| 8 | `weeks: number[]` 无法表达单双周 | 保留 `number[]`，**不加 `pattern` 字段**：课表已按日期实例化，单双周由 `weekIndex` 集合自然表达 | `/lesson/student/course-table` 的 `schedules[].weekIndex` |
| 9 | `Notice.bodyText` 必填 | 改 `summary`（可选，能拿到的字符串）+ 可选 `contentHtml` | 门户 CMS 硬截 200 字；教务处通知有完整 HTML |
| 10 | L1 LLM / Ollama 作为意图层 | 降级为**可选增强**，默认关闭；2026-10-21 起已接学校自建 Open WebUI（`http://chat.zzu.edu.cn`，`DeepSeek-R1`），只判意图不出数据 | Ollama 默认拒 `chrome-extension://` origin，评委机器跑不起来；学校模型仅在校园网内 |
| 11 | `rag_lookup` 工具 | **删除**。没有语料，且通知全文一半拿不到 | 无数据源 |
| 12 | `export_ics` 无下载通道 | 面板用 `Blob` + `URL.createObjectURL` 直接存 `.ics` | — |
| 13 | 空教室「数据源未知」 | **可用**：全部教室 − 当天占用；占用取自 `rooms` 响应里每间教室的 `roomOccupationInfoVms`（含 `Lesson` 排课），**不是** `room-occupancy`（那个只含借用，一天个位数） | `/room/place/rooms`（带 `date`） |
| 14 | 成绩/考试「无入口」 | **可用**：`/grade/student/grades`、`/exam/student/exam`（本账号当前为空） | 微前端 `eams-student-grade-app` / `eams-exam-student-app` |
| 15 | M2「真实站点逆向 3–4 人日」 | 已完成，不再计入工期 | 本仓库 |

## 2. 架构（v0.2.3：模型当执行核心，2026-10-22）

```
用户一句话（可带最近 3 轮 history）
   │
   ├─ intent.parseIntent(text, today)      L0 规则，命中即出 {tool,args}（几十毫秒、离线可用）
   │     └─ 未命中 → 若开启模型且配了 key：
   │           ├─ 服务商支持 function calling → agent.runAgent() 循环
   │           └─ 不支持（学校 R1）        → llm.classifyIntent() 只给 {tool,args}
   │
   ├─ tools.runTool(name, args, svc)       zod 校验参数 → 调服务
   │     └─ agent 模式：结果以 {text,data} JSON 回灌给模型，模型再决定「继续调工具」或「回答」
   │
   ├─ services.CampusService               5 分钟 TTL 缓存
   │     ├─ jwxt（优先）: 学期/课表/教室/成绩/考试/通知
   │     └─ portal（降级）: 课表事件 + 节次表 + CMS 通知
   │
   └─ render.*                             模板作答（无模型 / 学校 R1 走这条）
```

**为什么改（2026-10-22）**：此前模型只是「语义解释层」，只负责把话翻成 `{tool,args}`，正文由模板渲染。三个真实失败案例暴露了这条路的天花板：「学校最近有比赛吗」→ 回「没有匹配的通知」（同义词不扩、话题词不认）；「今天下午我有课吗」→ 把整天课表倒出来（无时段概念）；「预约明天图书馆一楼随便一个位置」→ 匹配成「图书馆 馆藏检索」（把预约当成检索）。这些都不是「模型笨」，是「模板 + 参数」这一层太窄。

**现在的分层**（`src/core/agent.ts`）：

| 层 | 职责 | 谁做 |
| --- | --- | --- |
| 事实层 | 数据只来自学校接口 | `services.ts` / `jwxt.ts` / `portal.ts` |
| 动作层 | 10 个工具，参数由 zod 校验 | `tools.ts`（规格在 `toolspec.ts`） |
| 编排层 | 决定调哪个工具、几轮、怎么讲 | 支持 function calling 的模型（`runAgent`，最多 4 步） |
| 兜底层 | 模型不可用时的规则与模板 | `intent.ts` + `render.ts` |

关键护栏：

- **相对日期不许模型算**：`applyTextHints()` 在调工具前用用户原话覆盖 `date`/`day`（「后天」=+2 天，「下午」补 5-8 节）。实测 R1 会把「后天」算成明天。
- **工具返回即事实**：提示词写死「只使用工具返回的内容，不许编数字/课程名/通知标题」。
- **不可代做的操作只能给入口**：预约、报名一律用 `open_service` 给官方链接，并禁止假装成功。
- **未知工具回错误让它自纠**：模型调 `book_seat` 这种不存在的工具时，回 `{"error":"没有叫 book_seat 的工具，可用：…"}`，模型下一轮自己改口。

规则层同时被强化（离线也生效）：`get_schedule` 加 `period`（上午/下午/晚上）、`find_notices` 收 `query` 并按 `SYNONYMS` 扩同义词（比赛→竞赛/大赛/挑战杯/创新创业/选拔赛）、`matchServices` 同分时按命中字面长度排序（「图书馆一楼」压过「图书馆」）。

数据红线不变：模型永远不生成课表/成绩/通知正文，这些只来自学校接口 + 模板渲染。

## 3. 权限与域名（C1 修订）

```json
"permissions": ["storage", "alarms", "sidePanel"],
"host_permissions": [
  "https://cas.s.zzu.edu.cn/*",
  "https://uniapp.s.zzu.edu.cn/*",
  "https://info.s.zzu.edu.cn/*",
  "https://authx-service.s.zzu.edu.cn/*",
  "https://message-service.s.zzu.edu.cn/*",
  "https://transaction.s.zzu.edu.cn/*",
  "https://formflow.s.zzu.edu.cn/*",
  "https://jwxt.zzu.edu.cn/*",
  "http://chat.zzu.edu.cn/*",
  "https://api.deepseek.com/*",
  "https://api.siliconflow.cn/*",
  "https://dashscope.aliyuncs.com/*",
  "https://api.moonshot.cn/*",
  "https://openrouter.ai/*"
],
"minimum_chrome_version": "114"
```

第 9–14 条是模型服务商：第 9 条是学校 LLM（仅校园网、HTTP 明文），其余 5 家是可选的自带 key 通道（HTTPS 页面也能用）。全部不填 key 时不会被请求。

- 不申请 `cookies`：`idToken` 由 content script 从 `localStorage` / `document.cookie` 读，页面自己有权限。
- 不申请 `<all_urls>`，不申请 `optional_host_permissions`（因为不做自定义 `baseUrl`，无需运行时授权）。
- `minimum_chrome_version` 必须是 **114**（`chrome.sidePanel` 自 114 起），v0.1 写的 111 只覆盖 `world:'MAIN'`。

## 4. Schema（v0.2，与 `campus-layer/src/core/types.ts` 一致）

| 模型 | 字段 |
| --- | --- |
| `Course` | `key, name, teachers[], location?, campus?, weekday(1–7), startTime(HH:mm), endTime, sectionStart?, sectionEnd?, weeks[], date?, source('portal'\|'jwxt')` |
| `Notice` | `id, title, summary(default ''), contentHtml?, publishedAt?, department?, readCount?, url?, source('portal-cms'\|'jwxt-notice')` |
| `Term` | `id, code, startDate, endDate, weeks[], currentWeek?, season?` |
| `Room` | `id, name, code?, buildingId?, buildingName?, campus?, floor?, seats?` |
| `Occupancy` | `roomName, date, startAt(HHmm 整数), endAt, activity?, type?, teacher?` |
| `FreeRoom` | `room, freeSections[]` |
| `Grade` / `Exam` | `.passthrough()` 宽松模型（字段随教务版本变） |
| `CourseUnit` | `indexNo, startTime, endTime, dayPart?` |

要点：`weeks` 是**教学周序号**而非自然周；`startTime/endTime` 统一 `HH:mm` 串（服务端给 `800`/`08:00:00` 两种，入口处归一）；`source` 保留来源便于 UI 标注可信度。

## 5. 工具集（v0.2.7，14 个）

| 工具 | 参数（zod） | 语义 |
| --- | --- | --- |
| `get_schedule` | `{week?: int 0–30, day?: 'today'\|'tomorrow'\|1–7, period?: 'morning'\|'afternoon'\|'evening'}` | 默认当前教学周；按天/时段过滤，指定了却没课时明说「没有课」 |
| `find_free_room` | `{date?: YYYY-MM-DD, campus?, building?, minSeats?, sections?: int[1–20], limit?}` | 全部教室 − 当天占用；`sections` 要求全闲；`building` 走教室名前缀（南核=南1–南3、北核=北1–北5、物理馆=物） |
| `find_notices` | `{query?, keyword?, days?, limit?}` | 标题+摘要匹配；`query` 会做同义词扩词（比赛→竞赛/大赛/挑战杯…），零命中时列最近 5 条 |
| `get_grades` | `{course?: string}` | 成绩/绩点；按课程名过滤，并按语义把构成分（平时/期中/期末/卷面…）列出——有没有取决于服务端字段 |
| `get_exams` | `{}` | 考试安排，空则明说 |
| `get_plan_progress` | `{code?: string}` | 培养方案学分进度：按模块列要求/已通过/在修/还差 + 未修课程清单（默认 `code='01'` 主修） |
| `open_service` | `{keyword: string}` | 门户服务直达：从 19 项服务里匹配，返回说明 + 官方 URL（面板渲染成可点按钮） |
| `get_card` | `{}` | 一卡通余额 + 最近消费/充值（门户 `/v2/personalData/getMyECard`） |
| `get_todos` | `{}` | 待办/在办/待申请计数，紧急与超时单列，附第一条事项的办理入口 |
| `library_seats` | `{date?: YYYY-MM-DD}` | 图书馆**实时空座**（各馆空闲/总数 + 楼层明细，免登录 `order.lib.zzu.edu.cn/v4/space/pcTopFor`）+ 选座直达链接 |
| `library_seat_map` | `{areaId, date}` | **座位级**空闲（`/v4/Space/seat`，需那个标签页已登录）：宽容解析（字段名不假设），数字状态不硬猜 |
| `book_library_seat` | `{areaId, date, seatNo}` | **只产出待确认动作**（`data.action.kind='library-book'`），面板渲染成**长按 1.2s** 才提交的按钮；执行在用户自己的图书馆页面上点选（不复制站点的 AES） |
| `find_study_spot` | `{date?, needMinutes? (默认 120), near?, maxWalkMin?}` | **自习决策器**：教室连续空闲窗口（`freeWindows`）+ 图书馆余量合成一个答案，按时长/步行（`walk.ts` 楼间表）排序；凑不够时长会分级说明 |
| `export_ics` | `{fromWeek?, toWeek?}` | 生成 `.ics`，带 `Asia/Shanghai` 与 VTIMEZONE |

> **跨域 token 的实测结论**：教务那张 30 天 `idToken` 在 `portal-api` / `transaction` 上同样有效（同一 CAS 签发、受众相同），
> 所以 `services.portal()` 优先用教务票、门户票（8 小时）只作备用——这一条让「一卡通 / 待办」不必等用户重登门户。

> **新增的两个工具解决的是不同性质的问题**：`get_plan_progress` 是「把已有的结构化数据算成人话」，
> `open_service` 是「把做不到的能力老实交还给官方入口」。后者是这次盘点（`docs/portal-services-inventory.md`）的直接产物——
> 座位预约 443 拒连、智慧食堂 API 不在 h5 那台机上、学术搜递证书不匹配，这些短期内都接不了，
> 与其假装能查，不如一句话把人送到门口。

> **渲染层附带**：`get_schedule` 的回答下方会附一张郑大主校区地图（`public/map/campus.jpg`，随扩展打包，默认收成 240px 高的小图，点一下展开整张）。需求来自实操：课表给出「南1_303」「物_505」这类教室编号，学生还需要知道那栋楼在哪儿。这是扩展自身的静态资源，不需要额外 host 权限、不引入新依赖，也不改变工具契约。

## 6. 数据可得性（v0.2 实测矩阵）

| 数据 | 结论 | 端点 | 备注 |
| --- | --- | --- | --- |
| 学期与首周 | ✅ | `/eams-micro-server/api/v1/semester/current-semester` | `2026-09-07` → `2027-01-17`，19 周 |
| 当前教学周 | ✅ | `/semester/current-week/{termId}` | `7` |
| 课表 | ✅ | `/lesson/student/course-table/{termId}` | 11 门 / 40 条日期实例 / 154KB |
| 节次表 | ✅ | `/room/system/course-units` | 10 节，含 `800-845` 等 |
| 全部教室 | ✅ | `POST /room/place/rooms` | 全部 1614 间；只查普通+多媒体教室是 379 间，30 条/页 |
| 教室占用 | ✅ | 同上响应里的 `roomOccupationInfoVms` | 每间自带若干 `Lesson`/`RoomBorrow` 时段（`startTime`/`endTime` 为 HHmm 整数） |
| 教室占用（借用表） | ⚠️ 只含借用 | `POST /room/place/room-occupancy` `{date}` | 一天仅 8 条，**不能**用来算空教室 |
| 空教室 | ✅ | 教室 − `roomOccupationInfoVms` 求差 | 12 路并发翻页约 4s，之后 60s 缓存 |
| 成绩 | ✅接口 / ⚠️无数据 | `/grade/student/grades` | 大一本学期空 |
| 考试 | ✅接口 / ⚠️无数据 | `/exam/student/exam` | 学期中未发布 |
| 通知（教务） | ✅ 完整正文 | `/eams-door/api/v1/protal-notice/get-notices` | HTML，`readCount` 可读 |
| 通知（门户 CMS） | ⚠️ 摘要仅 200 字 | `/portal-api/v3/cms/content/getColumncontents` | `getOne` 返回空壳，官网原文需登录 |
| 门户课表 | ✅ 可作为降级源 | `/portal-api/v1/calendar/share/schedule/getEvents` | 一次整学期 207 条 |
| 校历/可订阅日历 | ✅ | `/portal-api/.../subscribe/page` | 含「校历」 |
| 待办（教务门面） | ✅ 接口通 / 空 | `/eams-door/api/v1/todo/getTodos` | 无待办 |
| 培养方案学分 | ✅ | `/eams-micro-server/api/v1/plan/search/completion/info?code=01` | 30,920B；本号 166 要求 / 0 已通过 / 25 在修；缺 `code` 报 500 |
| 门户服务目录 | ✅ | `/portal-api/v2/service/serviceShowAll`、`/v1/service/list` | 本号 22 项；已整理成 19 项目录并带口语别名 |
| 当前教学周（一次调用） | ✅ | `/eams-door/api/v1/calendar/get-current-teach-week` | `{currentSemesterId:194, weekIndex:7, inSemester:true}`，可替掉两步调用（v0.3） |
| 校区作息表 | ✅ | `/eams-door/api/v1/calendar/get-campus-layout-table` | 35,278B / 10 条，含校区与作息模板（v0.3） |
| 一卡通余额 | ✅ 已接（用教务票） | `/portal-api/v2/personalData/getMyECard` | 余额是字符串 `"0"`；卡类型 `uni-app`；流水为空 |
| 待办（事务中心） | ✅ 已接 | `/ttc/v1/count/ttcCount?readed=0` + `/ttc/api/ttc/center-list/getToDoList` | 本号全 0；`message-service` 未读数接口回 500，暂不做 |
| 图书馆实时空座 | ✅ 已接（免登录） | `POST http://order.lib.zzu.edu.cn/v4/space/pcTopFor` | 主校区 2527 总 / 约 930 空闲；**只有 http、仅校内网**；返回里只给主校区一个馆 |
| 图书馆座位图/下单 | ❌ 需登录 | `/v4/Space/map`、`/v4/space/confirm` | 回 `{"code":10001,"message":"您尚未登录"}`；`/v4/index/bookingRules` 原文：账号密码与统一身份认证一致（学号+密码），扩展不碰密码 |
| 一卡通账单明细/分类 | ❌ 接口没有 | `/v1/personalData/getECardDataList` | 只回深链配置（`getScanInfo` 指向外校 `ecard-app.jci.edu.cn` 残留），真账目在 `ecard.v.zzu.edu.cn`，需单独登录 |

## 7. 鉴权（v0.2 主路径）

1. content script 在 `uniapp.s.zzu.edu.cn` 读 cookie `userToken`（门户，8h）。
2. content script 在 `jwxt.zzu.edu.cn` 按 **URL（`?idToken=`）→ localStorage → sessionStorage → cookie** 依次找教务的 `idToken`（30d）。
   CAS 回调把 JWT 放在 URL 里，前端落盘时又可能包成 uni-app 的 `{"type":"string","data":"…"}`，所以采集器先解包装再判「是不是三段 JWT」，键名变了还有全量扫描兜底（见 `public/content/jwxt.js`，测试 `test/jwxt-collector.test.ts`）。
   教务有时被门户用 iframe 嵌着，manifest 对这条脚本开了 `all_frames`。页面控制台可跑 `__zzuTokenProbe()` 自查。
3. `chrome.runtime.sendMessage({type:'token', token, source})` → 存 `chrome.storage.local`。
4. SW 发请求时带 `X-Id-Token`、`X-Terminal-Info: h5`、`X-Device-Info: PCWin32NT`，`credentials:'omit'`（不需要 cookie）。
5. 过期判定 = JWT `exp` 到期 **或** 业务码 `code:-1` / `没有访问权限` → 面板标红，提示重新登录。

**安全边界**：token 只存本机 `chrome.storage.local`；不打印、不远程上报；面板只显示剩余时长与姓名/学号末位。

## 8. 风险与限制

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| 门户 token 8 小时过期 | 门户降级源失效 | 面板标红 + 提示重开页面；有教务 token 时主功能不受影响 |
| 成绩/考试为空 | 演示时像"没实现" | 回答里明说「当前学期尚未发布」，不报错 |
| 门户通知只有 200 字 | 全文检索体验差 | UI 标注来源；检索只用标题+摘要 |
| 教室 379 间（限普通+多媒体） | 首次空教室约 4s | 12 路并发翻页 + 60s 缓存 + 只在需要时拉 |
| 教室座位数据为空 | 按座位筛选无效 | 客户端兜底 + UI 说明，不当成必选条件 |
| 接口无版本契约 | 学校升级会断 | 全部 zod 校验 + fixture 回归，断了能定位到字段 |
| `X-Device-Info` 等头可能被收紧 | 401/业务码变化 | 判据写成「业务码非 0 即失败」，不白屏（C9） |

## 9. DoD（v0.2 验收）

1. `npm run typecheck` 零错误；`npm test` 全绿（离线 fixture）。
2. `npm run build` 产出 `dist/`，可在 Edge 114+ 以「加载解压缩扩展」安装。
3. 登录门户与教务后，面板两枚 token 状态正确显示剩余时长。
4. 五句话跑通：`本周课表` / `明天有课吗` / `明天下午的空教室` / `最新通知` / `导出日历`。
5. 导出 `.ics` 能被手机日历导入，时间落在北京时间正确时段，周次裁剪有效。
6. 断网状态下，除数据类回答外，帮助文本与错误提示仍可读（不白屏）。
7. 无 LLM 环境（无 Ollama、无云端 key）下，上述 4 全部成立。

验收记录（真浏览器 + 真 token，Edge 155.0.4283.62，2026-10-20）：

| # | 怎么验的 | 结果 |
| --- | --- | --- |
| 1 | `tsc --noEmit` + `vitest run` | 零错误；35 passed / 6 skipped（跳过的是实网用例） |
| 2 | `vite build` → `dist/` 7 个文件；`--load-extension` 起 Edge | 扩展 id 正常、SW 注册、面板可打开 |
| 3 | 面板 token 药丸 | 「教务 · 28 天」「门户 · 5 小时」 |
| 4 | 面板 + SW 各问一遍 | 五句全部答对（含「明天有课吗」精确到 2 门课/教室/教师） |
| 5 | `ics.test.ts` + `export_ics` | 33 个日程 / 26 门课，`DTSTART;TZID=Asia/Shanghai`、周次裁剪、折行与转义均过；**手机日历实机导入未验** |
| 6 | 把 token 换成已过期的 JWT 再问 | 提示「教务登录态已失效，请重新打开 https://jwxt.zzu.edu.cn 登录一次」，不白屏；认不出的问题返回帮助文本 |
| 7 | 全流程无模型调用 | 成立（不填 key 时代码路径完全不碰网络模型） |
| 8 | L1 兜底（2026-10-21 补测） | 填学校 key 后问「后天下午哪个屋子能让我安静看会儿书」（规则层认不出）→ `via: "llm"` → `find_free_room` → 2026-10-23 真实空教室（北1_102 空闲 1-4 节 等），11.6–17.5s |
| 9 | 培养方案 + 服务直达（2026-10-21 补测） | `get_plan_progress` 740ms 答「要求 166 / 已通过 0 / 在修 25 / 还差 141，未修 54 门」；`open_service`「打开座位预约」→ 面板出现可点按钮「打开 座位预约 ↗」指向 `https://order.lib.zzu.edu.cn/`；69 passed / 6 skipped |
| 10 | 一卡通 + 待办（2026-10-21 补测） | `get_card` 163ms「余额 ¥0 / 卡类型 uni-app / 没有最近流水」；`get_todos` 110ms「目前没有需要你处理的待办」；live 9/9 通过（全部用教务票访问门户与事务中心）；86 passed / 7 skipped |
| 11 | 手机 PWA（2026-10-21 补测） | `npm run pwa:shot`：无头 Edge 155 + 390×844 移动视口 → 清空本地 → 点「登录态」→ 粘贴 3,496 字符同步码 → 药丸变「教务 27 天」→ 问「明天有课吗」得课表 + 校园地图（1280×2044）→ 问「今天上午的空教室」得 1-4 节空闲列表（只列前 12 间 + 「共 N 间」提示）；`tsc` 0 错、94 passed / 9 skipped、`dist/pwa/index.html` 0.93 kB、`background.js` 2.02 kB（共享 chunk 102.40 kB） |
| 12 | 扩展同步码 + e2e 加固（2026-10-21） | `bundle:export` 从面板发出 → 3,496 字符码，解回 `{v,jwxt,portal,at}`（jwxt 1,298 字符、含门户票）；顺手修了 e2e 的一个真 bug：token 不再写进 SW target（`Runtime.evaluate` 打到已休眠的 SW 会报 `chrome is not defined`），改成在扩展页面里写并 `Page.reload`，失败路径也会 kill 掉 Edge 不再挂住端口 |
| 13 | 服务商预设 + 相对路径（2026-10-21） | `tsc` 0 错、**101 passed / 9 skipped**；`vite build` 产物 `dist/pwa/{index.html,pwa-sw.js,pwa.webmanifest}` 且 HTML 全引用 `../assets/…`（子路径可部署）；`pwa-shot` 绿（L1 徽标「由模型判定」、2026-10-23 空教室）；`e2e` 绿（10 工具、`settings inputs:3`、`bundle:llm {provider:"school", model:"DeepSeek-R1"}`、L1 `15.6s via:llm`）；新增 4 条 `llm.test.ts` 用例（换服务商改地址、未知回落学校、402/429 文案、HTTPS+http 服务商直接放弃） |
| 14 | 地点词 + 模型自由回答（2026-10-21 深夜） | ①`src/core/place.ts`：南核→南1–南3、北核→北1–北5、物理馆→物，按教室名前缀过滤（不用不透明的 `buildingIds`）。实网 `ask('明天南核空教室')` → `count 48`，全部 `^南[123]_`；`e2e` 新增断言 `south-core {"hasSouth":true,"leakedNorth":false}`，标题「2026-10-22 空教室 · 南核心教学区（南1–南3）」。②`parseModelReply` + `via:'llm-chat'`：问「hello」由模型直接作答（徽标「由模型回答」），不再甩能力清单。`tsc` 0 错、**134 passed / 10 skipped**、live 10/10（含新用例）、`e2e` 与 `pwa-shot` 全绿 |
| 15 | 模型当执行核心（2026-10-22） | ①`toolspec.ts` 手写 10 个工具的 OpenAI tools Schema；`llmChatWithTools` 走 `tool_choice:'auto'`；`agent.runAgent` 最多 4 步、工具结果以 `{text,data}` 回灌、未知工具回错误自纠、`maxSteps` 用完用最后结果兜底。②`applyTextHints` 用用户原话覆盖相对日期与时段（不信模型算日期）。③规则层同步强化：`get_schedule.period`、`find_notices.query` + `SYNONYMS` 扩词、`matchServices` 同分按命中长度排序。④三个原失败说法现在（**不接模型**）即通过：`学校最近有比赛吗` → 4 条真实竞赛通知（AI 智能体大赛 / 市场调查与分析大赛 / 文博创意选拔赛 / 创新创业大赛决赛）；`今天下午我有课吗` → 只回 14:00-15:40 计算学科导论；`预约明天图书馆一楼随便一个位置` → `open_service` 座位预约 `order.lib.zzu.edu.cn`。⑤`tsc` 0 错、**158 passed / 11 skipped**、live **11/11（13.3s）**、`e2e` 全绿（10 工具 + south-core + bundle 断言）、`vite build` 通过（`llm-*.js` 86.92 kB / gzip 26.10）；**真模型（deepseek-chat）实网未验**（本机无可用 key），工具循环逻辑只在单测里用桩响应验证 |
| 16 | 三个新痛点：成绩按课查 / 图书馆座位 / 一卡通分类（2026-10-22） | ①`get_grades` 加 `course?`，`renderGrades` 按语义捞构成分（`平时|期中|期末|卷面|usual|midterm|final`…），零命中时列出已出分课程；规则层 `extractCourseName` 支持「高数多少分」。②新增 `library_seats` 工具 + `src/core/library.ts`：`POST http://order.lib.zzu.edu.cn/v4/space/pcTopFor` **免登录**拿到各馆实时空闲/总数（实测主校区 929–934 / 2527，37%），渲染成「空闲/总数 + 百分比 + 合计」并给选座直达链接；座位图 `/v4/Space/map` 与下单 `/v4/space/confirm` 回 `您尚未登录`，登录凭据就是统一身份认证的学号+密码，**扩展不碰**。③一卡通分类统计**判定做不到**：`getECardDataList` 只回深链配置、真账目在 `ecard.v.zzu.edu.cn` 需单独登录，已写进 README 限制。④意图：「图书馆还有位置吗」走 `library_seats`，「南核空教室」仍走 `find_free_room`（新增 12 例 `test/library.test.ts` 覆盖，含「不被图书馆规则抢走」）。⑤`tsc` 0 错、**170 passed / 12 skipped**、live **12/12（10.6s，含图书馆用例）**、`e2e` 全绿（11 工具，`library_seats` 60ms）、`vite build` 通过；`manifest.host_permissions` 9→15（新增 `http://order.lib.zzu.edu.cn/*`） |
| 17 | 图书馆座位级 + 长按确认（2026-10-22） | 新增 library_seat_map（读 /v4/Space/seat，宽容解析、数字状态不猜）与 book_library_seat（只产出待确认动作，面板长按 1.2s 才提交，执行在用户自己的图书馆页面里点选，不复制站点 AES）；新增 public/content/library.js（第 4 个 content script）与 src/ui/hold.tsx；工具 11→13，host 仍是 15 条（复用同一域）；单测 171→179 passed / 12 skipped，tsc 0 错、vite build 通过；**真实下单未由我验证**（会占用户座位）。 |
| 18 | 座位级取数打通（2026-10-22/23） | ①根因不是 https/TLS：在已登录标签页里用页面同款请求实测 `POST /v4/Space/seat {id:'3', day:'2026-10-23', label_id:[], start_time:'07:30', end_time:'22:30', begdate:'', enddate:''}` → `code 0 / 216 座位 / free_num 123`；空数组的真因是**模型自己填了 areaId=2**，且日期字段是 `day` 不是 `date`。②`libtab.readLibrarySeats` 改成后台直连：`chrome.scripting.executeScript` 读出该标签页 `sessionStorage.token`，后台 `fetch` 带 `authorization: 'bearer'+token`，候选 areaId 轮试 `[模型给的, '3','4','5','6']`，拿到非空座位表才算命中（manifest 加 `scripting`）。③`library.parseSeatMap` 按真实字段收敛：`seatNo` 取 `no`、状态取 `status_name`，`STATUS_NUM` 记 `1=空闲/6=使用中`，fixture 取真实响应 6 条（`total_num:216`、`free_num:58`）。④结果：`tsc` 0 错、**187 passed / 12 skipped**、`vite build` 通过；用户实测成功（列出 216 个座位 / 空 123 / `001-007`、`010-013`…，并出现「长按预约 001」按钮）。 |
| 19 | 连坐时长 / 自习决策器 / 每日盯梢（2026-10-23） | ①`walk.ts`：15 个楼座相对坐标 + `buildingOf`/`walkMinutes`（78 m/min），`services.freeWindows` 把占用取补集、丢掉 <20 分钟碎片，`FreeRoom` 带 `windows/longestMin/freeNowMin`，渲染成「08:00–12:00，现在就能坐 2 小时 40 分」。②`study.ts` + `find_study_spot`（第 14 个工具）：教室与图书馆合成一个入口，按时长/步行排序；`intent.STUDY_FIRST` 命中「自习/看书/刷题」但**不含具体节次**才走它。③`watch.ts` + `daily-watch` 闹钟（6h 周期、一天只跑一次）：`gradeFingerprint` 比对出新成绩、`dueItems` 抓 7 天内截止的报名/申请通知，用 `chrome.notifications` 弹（manifest 加 `notifications`）。④结果：`tsc` 0 错、**216 passed / 12 skipped**、live 12/12、`vite build` 通过；实测两个空：成绩接口 `data:[]`（大一未出分）、教务通知正文被压成标题（无日期），故这两路目前空转。 |

## 9.1 移动端（PWA，2026-10-21 追加）

安卓 Chrome 至今不支持扩展（Kiwi 已停更），所以 v0.2.3 起同一套 `src/core/` 又打了一个网页版 `dist/pwa/`：

- 存储抽象 `src/core/kv.ts`：`chrome.storage.local` ↔ `localStorage`（前缀 `campus-layer:`）运行时二选一，`storage.ts` 全部改走它，所以核心逻辑零分叉。
- 登录态搬运：`exportTokenBundle()` → base64 同步码（`{v:1,jwxt,portal,at}`）→ 手机 `importTokenBundle()`。**编码不是加密**，等同 `X-Id-Token`。
- 部署约束：service worker 与「添加到主屏幕」要求**安全上下文**，所以必须 HTTPS 或 localhost；局域网 `http://192.168.x.x:8899` 能跑数据查询但装不了。
- 手机版**也能有 L1**：登录态面板底部就是模型设置（服务商 / key / 模型名），同步码里也会带上。
- 验证脚本：`scripts/serve-pwa.mjs`（静态服务，绑 `0.0.0.0` 便于同网段手机预览）、`scripts/pwa-shot.mjs`（CDP 移动视口端到端）。

### 9.1.1 模型来源：从「只有学校」到「六家预设」（2026-10-21 追加）

`src/core/llm.ts` 改成服务商表 + 统一 OpenAI 兼容调用：

- `LLM_PROVIDERS` 六项：`school`（`http://chat.zzu.edu.cn/api`，`DeepSeek-R1`，`campusOnly`）、`deepseek`（`https://api.deepseek.com`，`deepseek-chat`）、`siliconflow`（`https://api.siliconflow.cn/v1`）、`dashscope`（`https://dashscope.aliyuncs.com/compatible-mode/v1`）、`moonshot`（`https://api.moonshot.cn/v1`）、`openrouter`（`https://openrouter.ai/api/v1`）；`chatEndpoint(provider)` 统一拼 `/chat/completions`，模型名留空则用预设默认。
- **只做预设、不做自定义 `baseUrl`**：自定义域名要么全放开（`optional_host_permissions` + 每次弹授权、`<all_urls>` 味道），要么维护一张永远不全的名单。六家常见的够覆盖「想自带 key」的需求。
- `host_permissions` 由 9 域增到 **14 域**（+5 家服务商）。仍不申请 `<all_urls>` / `optional_host_permissions`。
- 错误翻译 `friendlyHttpError()`：401 说「key 无效或过期」、402「余额不足」、403「地域或额度限制」、404「模型名不对」、429「限流」，不再把裸 `HTTP 401` 甩给用户。
- **HTTPS 页面 + 学校预设 = 立刻放弃**（`classifyIntent` 开头判断 `baseUrl.startsWith('http:') && isHttpsPage()` 直接 `return null`），不白等 30s；界面就地提示换服务商。
- 同步码扩成 `{v, jwxt?, portal?, llm?: {provider, apiKey, model, enabled}, at}`。
- 共用 UI：`src/ui/llm-fields.tsx`（面板与 PWA 同一份控件）。
- 部署改为**相对路径**（`vite.config.ts` 的 `base: './'`），manifest/SW 移到 `public/pwa/` 并用 `self.registration.scope` 拼壳缓存路径，因此可放域名根也可放子路径（GitHub Pages 项目页）。部署三种免费放法与自检清单见 [`deploy-pwa.md`](deploy-pwa.md)。

### 9.1.2 「不部署服务器」的可行性依据（实测）

| 目标 | 公网可达 | CORS | 结论 |
| --- | --- | --- | --- |
| `jwxt.zzu.edu.cn` | ✅（境外节点 301，1.7–2.3s） | 回显 Origin | 4G 直查 |
| `info.s.zzu.edu.cn/portal-api` | ✅（境外节点 200） | `*` | 4G 直查 |
| `cas.s.zzu.edu.cn` | ✅（境外节点 302） | — | 只用于登录页 |
| `chat.zzu.edu.cn` | ❌ 私网 `10.67.16.3` | 回显 | 仅校园网 + 仅 http |

也就是说：**数据能力零服务器**，只要一个免费静态托管；唯一离不开校园网的是学校模型，且已被「自带 key」这条预设覆盖。

## 10. 未决（v0.3 候选）

- 成绩接口的真实字段（等期末有数据后补 fixture）。
- 门户 `getOne` 的空壳是否为权限问题（换账号/换栏目再试）。
- 是否需要 `chrome.alarms` 主动刷新 token 状态（当前面板轮询 15s）。
- 一卡通余额 / 最近流水、办事待办 + 未读：接口早前实测通过，但门户 token 只有 8h，
  要等采集到新 token 才能实网验证，故未纳入本轮（见 `docs/portal-services-inventory.md` §4）。
- 座位预约 / 智慧食堂 / 学术搜递 / 会务接待：实测打不通（443 拒连、API 不在 h5 主机、证书不匹配/过期），
  当前只做「一句话给官方入口」。等它们恢复再做。
- 学校 R1 延迟：一次 11–18s。若学校侧新增非推理模型（或 Open WebUI 支持 `think:false`）应切过去；否则用第三方预设。
- 自定义 `baseUrl`（自建反代 / 其它兼容网关）：暂不做，理由见 §9.1.1；真要做需引入 `optional_host_permissions` + 授权流程。
- 自动化部署：`docs/deploy-pwa.md` 里给了三种手工/CLI 放法，还没写成 `scripts/deploy.mjs`（需要用户的托管账号凭据，不适合默认自动化）。


## 9.2 通知总入口与课前提醒（2026-10-23 追加，PR #1 合入 + 本地实现）

### 9.2.1 通知总入口（同学 PR #1 贡献）

- 工具从「按关键词搜通知」升级成**一个入口** `find_notices`：门户 CMS 与教务公告两源合并、**按标题去重**，
  每条渲染成卡片（分类、开讲时间、地点、报名截止、读全文、加入日历）。
- 六类分类（讲座 / 比赛 / 活动 / 会议 / 教务 / 生活），教务再细分选课/考试/成绩/学籍/毕业/论文/实习；
  分类词表与口语→分类映射在 `src/core/noticeRules.ts`。
- 时间/地点/截止**都是从正文里抽的**（接口没有这些字段）：截止句取最晚、活动句取最早，抽不到就不显示。
- 今日口径按 `Asia/Shanghai` 且凌晨 4 点换日（熬夜看通知不会把昨天的算成今天）。
- 服务端「先排序再截断」修过一个真 bug：早先教务在前直接 `slice`，会把门户那 30 条整段截掉。
- 存储只放偏好（订阅分类、关注关键词、已读 id 上限 1000），**不缓存通知本体**，不会越攒越大。

### 9.2.2 课前 30 分钟提醒（安卓壳）

- `src/core/remind.ts`：`buildReminderBlocks(courses, {now, days, termStart})` 把课表排成提醒块——
  **一节课一条，开课前 30 分钟（`LEAD_MIN = 30`）各弹一条，不做任何合并**；
  正文 = `开始-结束 第N-M节 @教室 · 老师`，标题 = `半小时后：课名`。
  同一节课被门户（事件）和教务（模板）重复给出时按 `日期|开始时间|课名` 去重；
  已经过点的课不补弹（否则一开 App 就糊一脸旧通知）；过教学周过滤，最后按时间排序。`pushReminders()` 交给壳。
  （旧行为是「同一半天、空档 ≤40 分钟的连堂课并成一条」，2026-10 按用户要求去掉——上午满课时整上午只在第一节前弹一次，第二节往后都没提醒。）
- 壳侧：`ReminderScheduler`（逐条 `AlarmManager`；Android 12+ 无精确闹钟权限时退 `setAndAllowWhileIdle`；
  requestCode = `(at/60000*37 + 序号) % MAX`，同一时刻撞课也能各响各的；**每次 apply 先撤上一批闹钟再重排**，
  改课表/关开关不会留下旧闹钟）+ `ReminderReceiver`（渠道 `class-reminder`，`BigTextStyle`）+ `BootReceiver`（开机/升级后恢复）。
- 关掉课前提醒开关时前端会 `pushReminders([])` 把已排闹钟一起撤掉。
- 只有安卓壳有这条通道（PWA 没有系统通知权限）；浏览器里 `pushReminders` 直接返回 `false`。

### 9.2.3 本轮验收记录（2026-10-23）

| # | 项 | 结果 |
| --- | --- | --- |
| 17 | 合并 PR #1 后全量回归 | `tsc` 0 错、**303 passed / 12 skipped**（25 文件）；合并前 PR 自己的 CI 是 `action_required`（fork 首贡献没人点 Approve），等于这 3417 行没被人验证过 |
| 18 | 合并后收尾（`b5a22db`） | ①`scripts/e2e.mjs:314` 的 `search_notice` → `find_notices`（CI 不跑 e2e，不改会静默失效）；②`public/content/jwxt.js` 只认 `iss === 'cas.s.zzu.edu.cn'` 的票（PR 给 jwxt 开了 `all_frames:true`，防止把 iframe 里别人的票当登录态）；③补测试后 **305 passed / 12 skipped** |
| 19 | 课前提醒 | `remind.test.ts` 5 例（单节 / 连堂合并 / 跨午不合并 / 过点不弹 / 教学周过滤）⇒ **244 passed**；`android` workflow 出 APK（artifact `campus-layer-debug-apk`） |
| 20 | 课前提醒改**每节课各一条**（0.2.70） | 用户反馈「上午满课只在早上弹一次」。去掉 `GAP_MIN` 合并逻辑，`buildReminderBlocks()` 现在一节课一块：标题 `半小时后：课名`、`at = 开课 - 30 分钟`、正文带 `第N-M节 @教室 · 老师`；同一节课跨源（portal/jwxt）按 `日期|开始时间|课名` 去重；过点仍不补弹。`remind.test.ts` 扩到 8 例（提前量 30、正文带节次、连堂各一条、满课 5 节=5 条且时间递增、跨源去重、过点丢弃、教学周过滤、跨天不合并）⇒ **495 passed / 12 skipped**（37 文件）。壳侧 `ReminderScheduler` 同步硬化：requestCode 改 `(at/60000*37+i)%MAX`（撞课不互相覆盖）、`apply()` 先撤上一批闹钟、`SecurityException` 逐条兜底；关开关时前端 `pushReminders([])` 顺带撤闹钟 |

## 9.3 验收补充（2026-10-27，前端 0.2.52）

以下各条均已落地并有对应单测/实网验证；前表（§9 / §9.1 / §9.2）未覆盖本轮改动。

| # | 能力 / 修复 | 验收依据 |
| --- | --- | --- |
| 21 | 图书馆座位工具改**语义参数**：`floor: '一楼'\|'二楼'\|'三楼'\|'四楼'` + `room`，不再暴露数字 id | `test/libarea.test.ts` 断言 `floor:'二楼'` 通过、`floor:'五楼'` 被 schema 拒、`room:'语言文史书库'` 通过 |
| 22 | 楼层 → 房间 id 用实测表：一楼 `3`；二楼 `8/9/11/12`；三楼 `13–17`；四楼 `18/19/20/76` | 用户从图书馆页面地址栏逐个报的真实 id；`FLOOR_AREA_ID` / `FLOOR_AREA_ALTS` / `AREA_NAMES` |
| 23 | 问**楼层**→ 整层展开：每间一行余量 + 每间一张座位图（`data.images`，UI 逐张渲染并标房间名） | 实机：`今天二楼座位图` 返回 4 行 + 4 张图 |
| 24 | 问**房间**→ 只读那一间、只画那一张。三级判据：`room` 字段 → 用户原话房间名（**前 4 字**模糊匹配）→ `areaId` 已是具体房间即不展开 | `src/core/agent.ts` 的 `ROOM_HINT`；`src/core/tools.ts` 的 `isSpecificRoom` |
| 25 | 修三个「id 被吞」的真 bug：①`areaCandidates` 把楼层默认间排在前面 ②`libtab` 把具体房间 id 归一成楼层默认间 ③楼层备选表混入楼层级旧 id（多出「区域 72」这类未命名项） | 修前整层房间余量完全相同（都读到第一间）；修后各间数字互不相同 |
| 26 | 日期不再信模型：`/v4/space/index` 被混合内容拦下时不回退到模型给的旧日期，改为 **Asia/Shanghai 本地算**今天/明天 | `resolveLibraryDate()`；馆站只认今明两天，其余一律 `code=610` |
| 27 | 错误语义分开：`code=610`（该区域当天不可约）与 `code=10001`（被其它设备顶掉）各自人话；桥路径带「今天不行试明天」兜底 | `LibSeatClient.describePayload` + `libtab` 文案 |
| 28 | 长按预约按钮：**宋体** + 按住后红色进度条自左向右跑满 1.2 秒才提交，松手取消 | `pwa/style.css` 的 `.hold-btn` / `.fill` / `.active` |
| 29 | 蓝绿（teal）配色：模型气泡由白色 `--panel` 改为同族墨绿不透明面、正文近白、去掉半透明 | `html[data-theme='teal'] .bubble` 一组覆盖 |
| 30 | 更新链路：`pwa-sw.js` 缓存名 `campus-layer-v8` + `skipWaiting`/`clients.claim`；注册 `{ updateViaCache: 'none' }` + `reg.update()` + 新 SW 就绪后自动 reload；壳在版本号变化时 `web.clearCache(true)` | 线上核对：`assets/pwa-*.js` 内含当前版本号；壳杀进程重开后版本号前进 |
| 31 | 续票换成**账密直换 30 天票**（学校 App 的 `/token/` 端点族）：`appMint.ts` 手写 RSA PKCS#1 v1.5 + `fetch`；`deviceId` 过一次短信即成为可信设备，之后零人工；扩展/安卓壳（`AppMint.java`）/CLI（`scripts/app-*.mjs`）三处共用同一协议 | `test/appmint.test.ts` 19 例（含用 Node `privateDecrypt` 解回原文）；实网 74–113 ms、720 h、eams-door 200；`cas:*` 降级为兜底 |
| 32 | **绑定向导**（0.2.72）：手机 App 里就能把 `deviceId` 登记成可信设备，不必再开电脑跑 CLI。页面 `<AppCreds />` → 填账密 → 点「绑定」→ 壳发短信（`AppBind.java`）→ 填 4~6 位码 → 校验通过顺手换一张 30 天票写进两个槽位；扩展里同一套流程换成本地 `fetch`（`appBind.ts`），壳里走 `CampusNotify.appBindStart/appBindSubmit` ↔ `window.__campusBind` | `test/appbind.test.ts` 16 例（init→send→valid 顺序与 body、status 2/3 翻译、限流与网络错、壳桥 code/done/error/超时、`canBindInShell()` 在无窗口环境为 false）；`creds.ts` 增 `trustedAt`，换 deviceId 自动作废；`tsc` 0 错、533 passed / 12 skipped（39 文件） |
| 33 | **修闪退**（0.2.73）：0.2.72 在真机点「绑定」就崩。根因是 Java 侧手写 DER 解析把 AlgorithmIdentifier 的第一个孩子（OID）当成了 BIT STRING，读出的长度是 `1472509587`，`new byte[]` 抛 `OutOfMemoryError`（`Error` 不是 `Exception`，漏过所有 `catch (Exception)`）。修法：按 `alg.length` 正确跳过、`readTlv`/`sub` 严格边界、全链路改 `catch (Throwable)`、`pushBind` 包 try/catch；新增 `CrashLog.java` 把栈记进 SharedPreferences 并经 `CampusNotify.lastCrash()/clearCrash()` 显示在设置页 | `test/appmint.test.ts` 加 3 例（DER 截断、长度字段越界、取出的 n 必须是真 2048 位）；`tsc` 0 错、`vitest` 全绿（新增 5 例，含壳里崩溃文本读写 3 例） |
| 34 | **修「收不到短信」**（0.2.74）：闪退修好后点「绑定」立刻失败、没有短信，界面显示的是自造的「学校没认出这个账号」。真因是 Java 侧 RSA 填充块类型写成 `0x01`（签名用），PKCS#1 v1.5 公钥加密必须是 `0x02`——服务端解不开就回 HTTP 500 `解密字符串[...]`，这个 body 没有 `code` 字段，于是 `optInt("code", -1)` 的 `-1` 命中了「账号不对」分支。修法：块类型改 `0x02`；新增 `AppMint.Resp{status,body}`/`postResp()`，失败提示带上 HTTP 状态码与服务端 message（截 120 字）；换票失败提示补「多半是密码不对」（学校的 detect 对错密码也回 `need:false`）；设置页允许「密码已存、密码框空着」时直接点绑定 | `tsc` 0 错、`vitest` 539 passed、`vite build` ✓；真机待验 |
| 35 | **可信设备会过期**（实测补记）：同一 deviceId 上午 08:43/12:00 都是 `need:false`，17:59 再问变回 `true`；所以「一次短信」换来的是**一张 30 天票**，「免验」只保几小时到十几小时。文档 §10.5.3 记了这张观测表，`docs/cas-long-term-token.md` §10.6 对照表的「人工」一栏改成「30 天一次短信」 | 文档 |
| 36 | **修「换票没成」**（0.2.75）：短信校验通过（status 2）后立刻再 detect，学校仍回 `need:true`（可信设备是本次 passwordLogin 才登记的），于是 `mint()` 卡在 need 判断处 → 真机提示「设备登记成功，但换票没成」。真因是顺序错：必须用**那次 MFA 的 state** 直接登录。修法：`AppBind` 记住 `pendingState`，`submit()` 改调 `AppMint.loginWithState()`（只发 passwordLogin、不 detect）；`AppMint` 拆出 `mintDetailed()` 返回 `MintOut{token,error}`，失败带 `HTTP <status>：<message>`；TS 侧对称加 `mintViaAppState(creds, state, timeoutMs, knownKey?)`，`doVerify()` 用它 | `test/appmint.test.ts` 加 3 例（只在拿到 state 时发公钥+登录两条、不 detect；rejected 带 message；公钥失败报 network）；`tsc` 0 错、`vitest` 542 passed / 12 skipped；`vite build` ✓ |
| 37 | **安卓真机走通**：装 0.2.75 → 设置里填学号密码 → 点「绑定」→ 收到短信 → 填码 → 拿到一张 30 天的票（`X-Id-Token` 通吃 eams-door 与新门户）。附带一条运维教训：误装 0.2.72 会在点「绑定」时闪退（§10.5.1 的 DER bug），升级前先核对设置页上的版本号 | 用户真机回执；文档 §10.5「验证程度」改为「安卓已验证 / 扩展未验证」 |
| 38 | **合并 PR #8 + 0.2.76**（贡献者 Ayaka688）：界面改成底部四栏（主页 / AI / 学期课表 / 我的），主页一屏看今天几节课、图书馆余位、校园卡余额，学期课表整周表格；`public/pwa/pwa-sw.js` 的 `install` 不再 `skipWaiting()`，新 SW 停在 waiting，页面弹「新版本已就绪」等用户点更新（`postMessage({type:'SKIP_WAITING'})` → `controllerchange` 再刷新），更新完按 `pwa/update.ts` 的 `shouldAnnounce()` 弹一次公告，公告内容来自 `public/version.json` | 合并前审过全 patch：只新增一个指向本仓库的 About 链接，唯一 `fetch` 是相对路径 `./version.json`；`tsc` 0 错、`vitest` 553 passed / 12 skipped（`test/update.test.ts` 新增 11 例，含「version.json 与 package.json 版本号必须一致」这道发版检查）、`vite build` ✓；版本统一到 0.2.76（`versionCode 63`、`manifest.json 0.3.10`） |
| 39 | **0.2.77 修四栏改版的几处手感问题**（贡献者 Ayaka688）：主页铃铛改成「从哪页点开、返回就回哪页」（原来固定跳 AI 栏，回来落错地方），AI 页头部多余的铃铛删掉；主页右上角刷新会转圈（1.2s）并真的重拉课表/图书馆/空教室/余额/通知；二级页（账号/通知/外观/设置/关于）改为不透明并压在顶栏之上（原来 `header.top` 的 `z-index: 20` 把 `.subpage` 的 15 盖住，通知页会透出主页顶栏），底部四栏提到 40 让二级页里也能直接切栏；文案「还没有登录态：点右上角「登录态」」统一改成「去「我的 → 账号」登录一次」 | 版本 0.2.77（`versionCode 64`）；`tsc` 0 错、`vitest` 553 passed / 12 skipped（含 version.json 与 package.json 一致性检查）、`vite build` ✓；CDP 实点：点铃铛→通知（tab 仍主页）→返回→主页（不落 AI），点刷新图标转圈且 1.4s 复位 |
| 40 | **0.2.78 手感四件事**（贡献者 Ayaka688）：①主页三个入口（图书馆/空教室/校园卡）改成浅色卡片（薄荷/雾蓝/暖杏渐变 + 内联 SVG 图标），不再是三行小字；②切栏动画改成参考同类 App 的「旧页快照原地淡出 + 新页从下浮 18px 交叉淡入」300ms，底栏不动（`goTab` 里 `cloneNode` 快照 + `.page-snapshot`，不用旧的四栏横推）；③学期课表支持左右滑动换周（`grid-wrap` 指针手势，阈值 56px、竖向优先让页面滚动、到首末周 0.28 阻尼回弹、拖动中顶栏预览目标周次），箭头按钮保留；④手机返回键/侧滑返回接入 History API：跳转前同步压栈（`mark()`），历史里只留一条「哨兵」并每次 pop 后重布防，二级页左上「‹ 返回」与底栏切换都走同一条栈，栈空才交给系统退出 | 版本 0.2.78（`versionCode 65`）；`tsc` 0 错、`vitest` **553 passed / 12 skipped**、`vite build` ✓；CDP 触摸序列实测：滑 120px 1:1 跟手、松手 60ms 时 `flip-left` 位移 15.5px 透明度 0.61、稳定后到第 2 周，反向滑回第 1 周，竖向滑不变；返回链实测 主页→铃铛→返回→再铃铛→我的→设置→‹ 返回→返回→返回 全程不退出 App、`document.body` 未被清空 |
| 41 | **0.2.79 一大轮打磨**（贡献者 Ayaka688）：①入口卡片在三套配色下分别调色（藏青/蓝绿改成深色玻璃质感，米白保持浅色）；②通知红点拆成 seenIds，点过铃铛只清红点、未读仍保留，来新通知按条数亮；③修「我的 → 账号」点不开（登录二级页被误包进 AI 分支），顺带把重复的配色/提醒/模型设置收进各自二级页；④新增「检查更新」（红点 + 本次说明 + 立即更新）；⑤新增「宿舍电量」（一卡通 `host/open → getToken → utilities/account` 链路，照明/空调双表、30 天曲线、20/8 度阈值）；⑥关于页与 README 补「开源与致谢」；⑦主页改「谁先回来谁先上屏」+ 按天快照，冷启动课表 167ms；⑧课前提醒窗口 7→14 天、晚开 App 补弹一条（「X 分钟后」）、回前台与每 30 分钟重排 | 版本 0.2.79（`versionCode 66`）；`tsc` 0 错、`vitest` **580 passed / 12 skipped**、`vite build` ✓ |
| 42 | **0.2.80 宿舍电量能自己认房间了**（贡献者 Ayaka688）：①自动识别原来打的是 `/server/utilities/account` 并留空房间号，服务端不认，永远问不出来；改回 `zzupy.get_default_room()` 的真正路子——`POST /server/utilities/config`（body 只有 `{utilityType:"electric"}`）读 `resultData.location.room`；②认不出来时给「从列表里选」：`POST /server/utilities/location`，按 id 里 `-` 的个数决定 `locationType`（`""`→bigArea、`99`→building、`99-1`→unit、`99-1--2`→room），四级下拉选到底就是房间号，选完自动存下并读数；③手填输入框保留 | 版本 0.2.80（`versionCode 67`）；`tsc` 0 错、`vitest` **586 passed / 12 skipped**（`test/energy.test.ts` 18 条，含「必须打 config 而不是 account」「四级 id 解析」「locationList 洗数据」）、`vite build` ✓；打桩实测：config 不给房间时出现「从列表里选」，点开校区→楼→单元→房间四级下拉，选 101 后卡片收起、读数 12.8 度、房间号存为 `99-1--2-101` |
| 43 | **0.2.81 网页读不到电量时说清楚**（贡献者 Ayaka688）：①`public/manifest.json` 的 `host_permissions` 补上 `https://ecard.v.zzu.edu.cn/*`——一卡通那几个接口不带任何 CORS 头（`OPTIONS` 预检直接 403、无 `Access-Control-Allow-*`），网页里 `fetch` 必被拦，只有扩展（有 host 权限）和壳的原生通道能发；②`src/core/energy.ts` 抽出 `ecardRequest()`：有 `window.CampusNet.http` 走壳通道，否则 `fetch`，`TypeError` 时换成「浏览器不让网页直接访问一卡通（跨域限制）：装安卓壳，或用电脑上的扩展面板。」；③`EnergyView` 在纯网页里多一行说明，不再只丢一句 `Failed to fetch` | 版本 0.2.81（`versionCode 68`、`manifest.json 0.3.11`）；`tsc` 0 错、`vitest` **589 passed / 12 skipped**（新增「跨域被拦时说人话」）、`vite build` ✓ |
| 44 | **0.2.82 电量页的小修**（贡献者 Ayaka688）：`.energy-meta` 改 `align-items:flex-start`，报错文本 `flex:1 1 auto; min-width:0`，按钮 `flex:0 0 auto; white-space:nowrap`——长文案不再把「刷新」挤成竖排 | 版本 0.2.82（`versionCode 69`）；`vite build` ✓、打桩截图核对 |
| 45 | **0.2.83 安卓壳的原生网络通道**（贡献者 Ayaka688）：`CampusNet.java`（`@JavascriptInterface http(method,url,headersJson,body)`，`HttpURLConnection` + 不跟随跳转以保留 `Location` 里的 tid，返回 `{status,body,location,error?}`），`MainActivity` 里 `addJavascriptInterface(new CampusNet(), "CampusNet")`；网页侧 `src/core/energy.ts` 的 `ecardRequest()` 自动优先走它——一卡通接口无 CORS，网页与 WebView 里的 `fetch` 必被拦，只有原生请求能发 | 版本 0.2.83（`versionCode 70`）；`tsc` 0 错、`vitest` 589 passed / 12 skipped、`vite build` ✓；APK 由 CI 编译 |
| 46 | **0.2.84 去掉宿舍电量**（贡献者 Ayaka688）：①`ecard.v.zzu.edu.cn` 不带 CORS，浏览器里的 PWA 永远发不出请求，只有安卓壳的原生通道（0.2.83 的 `CampusNet`）或扩展面板才读得到；②考虑到手机上都装新版 APK 的成本，功能整体撤掉——删 `src/core/energy.ts`、`test/energy.test.ts`、`CampusNet.java`、`EnergyView`/`PlacePicker`/`Spark`、主页第四块入口与全部电量样式；③`manifest.json` 收回 `https://ecard.v.zzu.edu.cn/*` 权限，主页入口恢复一行三列，关于页/README 致谢只保留真正在用的项目。 |
| 47 | **0.2.85 两处手感修复**（贡献者 Ayaka688）：①切到 AI 栏时聊天区重新挂载、`scrollTop` 归零，看起来像「每次都从最上面开始」——现在进入时在绘制前直接 `scrollTop = scrollHeight`，落在最新一条，并把「贴底」标记复位；②主页「今日课表」原来是纯文字列表，改成每节课一张同色系卡片（左侧色条 + 淡底 + 同色课名与时间），颜色按课名哈希分配、撞色顺延，深浅两套主题各一套处理；③顺手修：拉课表失败时不再把缓存清成「今天没有课」，只提示一句。 |

**本轮仍未做（明确记录）**
- 图书馆座位图依赖该站自身登录态（与学校 CAS 是两套账号），且**同一时间只允许一台设备在线**；
- 一层一次问会发 4–5 次请求（每间一次），手机 2–4 秒；
- 下单（`/v4/space/confirm` 的 AES 加密）不复刻，止步于「长按 → 由页面自己发」；
- `code=610` 的真实触发条件仍有不确定性（可能同时受区域开放时间影响），当前只用「日期夹紧 + 明天兜底」缓解。
