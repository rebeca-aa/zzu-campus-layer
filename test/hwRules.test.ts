import { describe, expect, it } from 'vitest';
import { detectShape, parseByStructure } from '../src/core/hwRules';
import { parseDueAt } from '../src/core/homework';

/** 固定「现在」：2026-11-13（周五）10:00 */
const NOW = new Date('2026-11-13T10:00:00+08:00').getTime();
const at = (m: string, d: string, h = '23', mi = '59') =>
  new Date(`2026-${m}-${d}T${h}:${mi}:00+08:00`).getTime();

const S1 = `作业通知:
微积分:2.1的课后习题（11.15）
心理健康课程作业（学习通提交）（11.16）
高级语言程序设计:PTA实验2（11.23）`;

const S2 = `各科近期作业汇总:
英语:iwrite3（11.14）
U校园第二单元（11.14）
微积分:2.1的课后习题（11.15）
高级语言程序设计:PTA实验2（11.23）
心理健康课程作业（学习通提交）（11.16）
⚠️请同学们注意截止时间，不要逾期提交作业`;

const S3 = `📢 作业通知
请大家去应用商城下载中国大学 MOOC，找到线性代数课程完成任务，操作步骤见录屏哦

作业内容：《行列式》单元测试
⏰ 截止时间：2027.1.14

如果提交遇到问题可以私聊我`;

const S4 = `另外提醒：线性代数第0章、第一章作业（学习通上提交）
⏰ 截止：本周日晚上23:59
⚠️ 逾期无法提交，请大家按时完成！`;

describe('日期解析扩展', () => {
  it('点分隔 11.15', () => {
    expect(parseDueAt('（11.15）', NOW)).toBe(at('11', '15'));
  });
  it('带年份 2027.1.14', () => {
    expect(parseDueAt('截止时间：2027.1.14', NOW)).toBe(
      new Date('2027-01-14T23:59:00+08:00').getTime(),
    );
  });
  it('本周日晚上23:59', () => {
    // NOW 是周五（2026-11-13），本周日 = 11-15
    expect(parseDueAt('本周日晚上23:59', NOW)).toBe(at('11', '15'));
  });
  it('章节号 3.1–3.4 不能当日期', () => {
    expect(parseDueAt('习题册 3.1–3.4 周五前交', NOW)).toBe(at('11', '13'));
  });
  it('2.1的课后习题 不能当 2 月 1 日', () => {
    expect(parseDueAt('微积分:2.1的课后习题（11.15）', NOW)).toBe(at('11', '15'));
  });
});

describe('结构判定', () => {
  it('标签 → 块型', () => expect(detectShape(S3)).toBe('block'));
  it('多行带日期 → 列表型', () => expect(detectShape(S2)).toBe('list'));
  it('样例 1 也是列表型', () => expect(detectShape(S1)).toBe('list'));
});

describe('样例 1：列表 + 课程前缀', () => {
  const r = parseByStructure(S1, NOW);
  it('出 3 条', () => expect(r.drafts).toHaveLength(3));
  it('第 1 条：微积分 / 2.1的课后习题 / 11-15', () => {
    expect(r.drafts[0]).toMatchObject({
      course: '微积分',
      title: '2.1的课后习题',
      dueAt: at('11', '15'),
    });
  });
  it('第 2 条：心理健康（不继承微积分）', () => {
    expect(r.drafts[1]).toMatchObject({
      course: '心理健康',
      title: '心理健康课程作业',
      dueAt: at('11', '16'),
    });
  });
  it('第 3 条：高级语言程序设计 / PTA实验2 / 11-23', () => {
    expect(r.drafts[2]).toMatchObject({
      course: '高级语言程序设计',
      title: 'PTA实验2',
      dueAt: at('11', '23'),
    });
  });
});

describe('样例 2：列表 + 继承 + 丢弃提醒行', () => {
  const r = parseByStructure(S2, NOW);
  it('出 5 条', () => expect(r.drafts).toHaveLength(5));
  it('U校园那行继承英语', () => {
    expect(r.drafts[1]).toMatchObject({
      course: '英语',
      title: 'U校园第二单元',
      dueAt: at('11', '14'),
    });
  });
  it('提醒行没有变成作业', () => {
    expect(r.drafts.some((d) => /逾期/.test(d.title))).toBe(false);
  });
  it('提示里说了几条', () => expect(r.info).toContain('5 条'));
});

describe('样例 3：块型（课程在正文里）', () => {
  const r = parseByStructure(S3, NOW);
  it('出 1 条', () => expect(r.drafts).toHaveLength(1));
  it('课程=线性代数，标题=《行列式》单元测试，截止 2027-01-14', () => {
    expect(r.drafts[0]).toMatchObject({
      course: '线性代数',
      title: '《行列式》单元测试',
      dueAt: new Date('2027-01-14T23:59:00+08:00').getTime(),
    });
  });
});

describe('样例 4：单条 + 相对日期', () => {
  const r = parseByStructure(S4, NOW);
  it('出 1 条', () => expect(r.drafts).toHaveLength(1));
  it('课程=线性代数，截止=本周日 23:59', () => {
    expect(r.drafts[0]).toMatchObject({
      course: '线性代数',
      dueAt: at('11', '15'),
    });
    expect(r.drafts[0]!.title).toContain('第0章');
  });
  it('顿号不拆成两条', () => expect(r.drafts[0]!.title).toContain('第一章'));
});
