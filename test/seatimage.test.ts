import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSeatMap, seatMapDataUri, seatMapSvg } from '../src/core/library';

const seat = (no: string, x: number, y: number, status = '空闲') => ({
  no,
  name: no,
  status: status === '空闲' ? 1 : 6,
  status_name: status,
  point_x: x,
  point_y: y,
});

describe('parseSeatMap 保留坐标', () => {
  it('point_x/point_y 变成 x/y', () => {
    const m = parseSeatMap({ data: { list: [seat('001', 10, 20), seat('002', 30, 40)] } });
    expect(m.seats.map((s) => [s.no, s.x, s.y])).toEqual([
      ['001', 10, 20],
      ['002', 30, 40],
    ]);
  });

  it('没有坐标时不编造 x/y', () => {
    const m = parseSeatMap({ data: { list: [{ no: '001', status: 1, status_name: '空闲' }] } });
    expect(m.seats[0]!.x).toBeUndefined();
  });
});

describe('seatMapSvg', () => {
  const map = parseSeatMap({
    data: {
      list: [
        seat('001', 100, 100),
        seat('002', 160, 100),
        seat('003', 100, 160, '使用中'),
        seat('004', 160, 160, '使用中'),
        seat('005', 220, 160),
        seat('006', 220, 100),
      ],
    },
  });

  it('画出与座位数一致的圆点，空闲绿、占用灰', () => {
    const svg = seatMapSvg(map);
    expect(svg).toBeTruthy();
    /* 空位多画一圈淡淡的光晕，所以只数带 data-seat 的那颗 */
    const seats = svg!.match(/data-seat="/g) ?? [];
    expect(seats.length).toBe(6);
    expect((svg!.match(/fill="#3ddc84"/g) ?? []).length).toBeGreaterThanOrEqual(4);
    /* 图例里也有一颗灰点，所以用「至少 2 颗」而不是精确相等 */
    expect((svg!.match(/fill="#3c4654"/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('坐标被归一化进画布（不出现负数或超出宽度）', () => {
    const svg = seatMapSvg(map, { width: 400 })!;
    const xs = [...svg.matchAll(/cx="([\d.]+)"/g)].map((m) => Number(m[1]));
    const ys = [...svg.matchAll(/cy="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThanOrEqual(400);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
  });

  it('座位太少或没有坐标就不画', () => {
    expect(seatMapSvg(parseSeatMap({ data: { list: [seat('001', 1, 1)] } }))).toBeUndefined();
    expect(seatMapSvg(parseSeatMap({ data: { list: [{ no: '001', status_name: '空闲' }] } }))).toBeUndefined();
  });

  it('data URI 可直接给 img 用，且带 svg 头', () => {
    const uri = seatMapDataUri(map)!;
    expect(uri.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
    expect(decodeURIComponent(uri.split(',')[1]!)).toContain('<svg');
  });
});

describe('宽而扁的房间（座位横排、纵向跨度很小时）', () => {
  const wide = parseSeatMap({
    data: {
      list: [
        seat('001', 0, 0),
        seat('002', 300, 0),
        seat('003', 600, 0),
        seat('004', 0, 40, '使用中'),
        seat('005', 300, 40),
        seat('006', 600, 40),
      ],
    },
  });

  it('按内容收高度，座位不会被画到画布下沿外面', () => {
    const svg = seatMapSvg(wide, { width: 400 })!;
    const m = /width="(\d+)" height="(\d+)"/.exec(svg)!;
    const h = Number(m[2]);
    const ys = [...svg.matchAll(/ cy="([\d.]+)"/g)].map((mm) => Number(mm[1]));
    expect(ys.length).toBeGreaterThanOrEqual(6);
    expect(Math.max(...ys)).toBeLessThan(h);
  });

  it('图例落在底板下沿的留白里，不压最后一排座位', () => {
    const svg = seatMapSvg(wide, { width: 400 })!;
    const h = Number(/height="(\d+)"/.exec(svg)![1]);
    const legendY = h - 41; /* seatMapSvg 把图例画在 H-41 这一行 */
    const ys = [...svg.matchAll(/ cy="([\d.]+)"/g)].map((mm) => Number(mm[1]));
    const seatYs = ys.filter((y) => Math.abs(y - legendY) > 0.01);
    expect(Math.max(...seatYs)).toBeLessThan(legendY - 6);
  });
});

describe('真实一楼大厅 216 个座位', () => {
  const raw = JSON.parse(readFileSync(new URL('./fixtures/library-seat-full.json', import.meta.url), 'utf8'));

  it('解析出 216 个座位、58 个空闲，并画出 216 个点', () => {
    const map = parseSeatMap(raw);
    expect(map.seats.length).toBe(216);
    expect(map.seats.filter((s) => s.free).length).toBe(58);
    const svg = seatMapSvg(map)!;
    expect((svg.match(/data-seat="/g) ?? []).length).toBe(216);
  });

  it('坐标跨度还原成一整张图（宽 720、总高不超过 760，且不裁掉底部）', () => {
    const svg = seatMapSvg(parseSeatMap(raw))!;
    const m = /width="(\d+)" height="(\d+)"/.exec(svg)!;
    expect(Number(m[1])).toBe(720);
    expect(Number(m[2])).toBeLessThanOrEqual(760);
    /* 所有座位点都落在画布里 */
    const h = Number(m[2]);
    for (const mm of svg.matchAll(/ cy="([\d.]+)"/g)) {
      expect(Number(mm[1])).toBeLessThanOrEqual(h);
    }
  });
});

describe('标号（只标空座位）', () => {
  const raw = JSON.parse(readFileSync(new URL('./fixtures/library-seat-full.json', import.meta.url), 'utf8'));
  const map = parseSeatMap(raw);
  const freeNos = new Set(map.seats.filter((s) => s.free).map((s) => s.no));
  const svg = seatMapSvg(map)!;
  const labels = [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>(\d+)<\/text>/g)];

  it('标出来的号全是空闲座位，一个占用都不出现', () => {
    expect(labels.length).toBeGreaterThan(0);
    for (const m of labels) expect(freeNos.has(m[3]!)).toBe(true);
  });

  it('真实一楼大厅能把绝大多数空座标上（挤不下的宁可不标）', () => {
    /* 一张 720 宽的图里 216 个座位，允许个别空位找不到不压点的位置 */
    expect(labels.length).toBeGreaterThanOrEqual(freeNos.size - 6);
    expect(labels.length).toBeLessThanOrEqual(freeNos.size);
  });

  it('标号互不重叠（估宽算盒子）', () => {
    const boxes = labels.map((m) => {
      const x = Number(m[1]);
      const y = Number(m[2]);
      const w = m[3]!.length * 9 * 0.62;
      return { x1: x, y1: y - 7, x2: x + w, y2: y + 2 };
    });
    let overlaps = 0;
    for (let a = 0; a < boxes.length; a++) {
      for (let b = a + 1; b < boxes.length; b++) {
        const A = boxes[a]!;
        const B = boxes[b]!;
        if (!(A.x2 <= B.x1 || A.x1 >= B.x2 || A.y2 <= B.y1 || A.y1 >= B.y2)) overlaps++;
      }
    }
    expect(overlaps).toBe(0);
  });

  it('每个座位都带 <title> 悬停提示', () => {
    expect((svg.match(/<title>/g) ?? []).length).toBe(map.seats.length);
  });

  it('labels:false 时不画标号', () => {
    const bare = seatMapSvg(map, { labels: false })!;
    expect((bare.match(/<text [^>]*>\d+<\/text>/g) ?? []).length).toBe(0);
  });
});
