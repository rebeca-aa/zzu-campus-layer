/**
 * 模型设置表单（扩展侧边栏与手机 PWA 共用）。
 *
 * 只负责「展示 + 收集」，不碰存储：父组件传 `value` 与 `onChange`，
 * 由各自决定写哪个 KV（扩展走 chrome.storage，手机走 localStorage）。
 */
import { canSeeImages, LLM_PROVIDERS, resolveProvider, type LlmSettings } from '../core/llm';

interface Props {
  value: LlmSettings;
  onChange: (patch: Partial<LlmSettings>) => void;
  /** https 页面调 http 服务会被浏览器拦，这里就地提示 */
  httpsPage?: boolean;
}

export function LlmFields({ value, onChange, httpsPage = false }: Props) {
  const provider = resolveProvider(value.provider);
  const blocked = httpsPage && provider.baseUrl.startsWith('http:');
  // 填的模型看不了图、但这家有识图模型：提前说一声，别等用「读图」才发现换了模型
  const visionSwap = provider.vision && value.model.trim() && !canSeeImages(value.model);
  return (
    <div class="llm-fields">
      <label class="toggle">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => onChange({ enabled: (e.currentTarget as HTMLInputElement).checked })}
        />
        <span>用模型兜底（规则没命中时判意图）</span>
      </label>

      <label class="row">
        <span>服务商</span>
        <select
          value={provider.id}
          onChange={(e) => {
            const next = resolveProvider((e.currentTarget as HTMLSelectElement).value);
            // 换服务商时把模型名换成新预设的默认值，避免残留旧模型名
            onChange({ provider: next.id, model: next.model });
          }}
        >
          {LLM_PROVIDERS.map((p) => (
            <option value={p.id}>{p.label}</option>
          ))}
        </select>
      </label>

      <label class="row">
        <span>API Key</span>
        <input
          type="password"
          class="key"
          placeholder="sk-…（存在本机，不上传）"
          value={value.apiKey}
          onChange={(e) => onChange({ apiKey: (e.currentTarget as HTMLInputElement).value })}
        />
      </label>

      <label class="row">
        <span>模型</span>
        <input
          class="key"
          placeholder={provider.model}
          value={value.model}
          onChange={(e) => onChange({ model: (e.currentTarget as HTMLInputElement).value })}
        />
      </label>

      {blocked ? (
        <p class="hint warn">
          {provider.label} 走 http，当前页面是 HTTPS，浏览器会按混合内容拦掉。换成 https 的服务商，或用 http 打开。
        </p>
      ) : null}
      {provider.hint ? <p class="hint">{provider.hint}</p> : null}
      {visionSwap ? (
        <p class="hint">这个模型只能读文字；用「读图」认作业时会自动换成 {provider.vision}（同一个 Key）。</p>
      ) : null}
    </div>
  );
}
