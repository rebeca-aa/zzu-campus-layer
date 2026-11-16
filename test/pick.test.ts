import { describe, expect, it } from 'vitest';
import { canPickNatively, pickImagesNative, type PickBridgeWindow } from '../src/core/pick';

/** 造一个假的壳：pickImages 被调用时立刻回一条结果 */
function fakeShell(box: unknown): PickBridgeWindow {
  const w: PickBridgeWindow = {
    CampusNotify: {
      pickImages: (reqId: string) => {
        // 真实壳是异步回的（读完图才回），这里同步调一次就够验协议
        w.__pickImages?.(reqId, JSON.stringify(box));
      },
    },
  };
  return w;
}

describe('pickImagesNative', () => {
  it('没有桥时返回 null（调用方退回 <input type="file">）', () => {
    expect(pickImagesNative(4, {} as PickBridgeWindow)).toBeNull();
    expect(canPickNatively({} as PickBridgeWindow)).toBe(false);
  });

  it('把壳回的 data URL 交出来', async () => {
    const w = fakeShell({ ok: true, urls: ['data:image/jpeg;base64,AAA', 'data:image/png;base64,BBB'] });
    expect(canPickNatively(w)).toBe(true);
    await expect(pickImagesNative(4, w)).resolves.toEqual([
      'data:image/jpeg;base64,AAA',
      'data:image/png;base64,BBB',
    ]);
  });

  it('用户取消 → 空数组', async () => {
    const w = fakeShell({ ok: true, urls: [] });
    await expect(pickImagesNative(4, w)).resolves.toEqual([]);
  });

  it('壳回 ok:false → 抛出壳给的原因', async () => {
    const w = fakeShell({ ok: false, error: '读不出这张图：换成 JPG / PNG 再试' });
    await expect(pickImagesNative(4, w)).rejects.toThrow('读不出这张图');
  });

  it('只收 data:image/ 开头的东西（挡住壳给的脏数据）', async () => {
    const w = fakeShell({ ok: true, urls: ['javascript:alert(1)', 'data:image/jpeg;base64,OK'] });
    await expect(pickImagesNative(4, w)).resolves.toEqual(['data:image/jpeg;base64,OK']);
  });
});
