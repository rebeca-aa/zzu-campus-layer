/**
 * 图书馆空间预约（order.lib.zzu.edu.cn）的页面内代理。
 *
 * 为什么必须放在页面里：
 * - 站点把登录态放在 `sessionStorage.token`，请求头是 `authorization: bearer<token>`；
 * - 下单一类接口 `/v4/space/confirm` 的请求体是页面自己用 AES 加密的（`isCrypto:true`），
 *   我们不想复制那套密钥，所以**执行动作一律通过操作页面来完成**，让页面自己加密。
 *
 * 这个脚本只做四件事：
 * 1. `lib:probe` —— 用页面自己的 token 拉座位数据（只读），把原始 JSON 交给扩展去解析；
 * 2. `lib:book`  —— 按「区域 + 日期 + 座位号」在页面上走一遍点选并提交（**只在用户长按确认后才调用**）；
 * 3. `lib:open`  —— 把页面导航到指定区域/日期；
 * 4. 下单后**核对回执**：在页面主世界里挂一层 fetch/XHR 钩子，抓 `/v4/space/confirm` 的真实响应，
 *    再回读一次座位图，两条证据都指向成功才算 `confirmed`。绝不"假装成功"。
 *
 * 注意：content script 与页面共享同一个 origin 的 storage，所以能读到 token；
 * 但我们只读 token、不改它。
 */
(() => {
  const TOKEN_KEY = 'token';
  const CONFIRM_RE = /\/v4\/space\/(confirm|studyConfirm)/i;

  function token() {
    try {
      return sessionStorage.getItem(TOKEN_KEY) || '';
    } catch {
      return '';
    }
  }

  async function post(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        authorization: `bearer${token()}`,
      },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { code: -1, message: '返回的不是 JSON', raw: text.slice(0, 500) };
    }
    return { status: res.status, json };
  }

  function seatBody(areaId, date) {
    // payload 来自页面实测（2026-10-22）：
    // {id, day, label_id, start_time, end_time, begdate, enddate}
    // 用 `date` 而不是 `day` 会拿到空数组——这是之前"解析出 0 个座位"的第二个原因。
    return {
      id: String(areaId || ''),
      day: String(date || ''),
      label_id: [],
      start_time: '07:30',
      end_time: '22:30',
      begdate: '',
      enddate: '',
    };
  }

  async function fetchSeats(areaId, date) {
    const res = await post('/v4/Space/seat', seatBody(areaId, date));
    return res.json;
  }

  /** 只读：把座位图 + 座位列表的数据原样带出去 */
  async function probe(args) {
    const areaId = String(args.areaId || '');
    const date = String(args.date || '');
    if (!token()) {
      return { ok: false, error: '这个页面还没登录。请先在浏览器里登录图书馆空间预约，再让我查座位。' };
    }
    const body = seatBody(areaId, date);
    const map = await post('/v4/Space/map', body);
    const seat = await post('/v4/Space/seat', body);
    return {
      ok: true,
      areaId,
      date,
      map: map.json,
      seat: seat.json,
    };
  }

  // ---------------------------------------------------------------- 回执捕获

  /**
   * 这段代码被 stringify 后塞进页面主世界执行（content script 拿不到页面的 fetch）。
   * 所以它必须是自包含的：不引用外部变量。
   */
  function pageHook() {
    const w = window;
    if (w.__campusLibTap) return;
    w.__campusLibTap = true;
    const TARGET = /\/v4\/space\/(confirm|studyConfirm)/i;
    const send = (url, status, body) => {
      try {
        w.postMessage({ __campusLib: 'confirm', url: String(url || ''), status: Number(status || 0), body: String(body ?? '') }, '*');
      } catch {
        /* 结构化克隆失败就算了，调用方会退回页面文字判断 */
      }
    };

    const origFetch = w.fetch;
    if (typeof origFetch === 'function') {
      w.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const promise = origFetch.apply(this, arguments);
        if (TARGET.test(String(url))) {
          promise
            .then((res) => {
              res
                .clone()
                .text()
                .then((t) => send(url, res.status, t))
                .catch(() => send(url, res.status, ''));
            })
            .catch(() => undefined);
        }
        return promise;
      };
    }

    const proto = w.XMLHttpRequest && w.XMLHttpRequest.prototype;
    if (proto) {
      const origOpen = proto.open;
      const origSend = proto.send;
      proto.open = function (method, url) {
        this.__campusLibUrl = url;
        return origOpen.apply(this, arguments);
      };
      proto.send = function () {
        const url = String(this.__campusLibUrl || '');
        if (TARGET.test(url)) {
          this.addEventListener('load', () => send(url, this.status, this.responseText));
        }
        return origSend.apply(this, arguments);
      };
    }
  }

  const capture = { records: [] };

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__campusLib !== 'confirm') return;
    capture.records.push({
      url: String(d.url || ''),
      status: Number(d.status || 0),
      body: String(d.body || ''),
      at: Date.now(),
    });
  });

  function installHook() {
    if (document.getElementById('__campus-lib-hook')) return;
    try {
      const s = document.createElement('script');
      s.id = '__campus-lib-hook';
      s.textContent = `(${pageHook.toString()})();`;
      (document.head || document.documentElement).appendChild(s);
      s.remove();
    } catch {
      /* 页面 CSP 挡住内联脚本时，退回「只按页面文字判断」 */
    }
  }

  /** 解析抓到的回执：`{code, message, data}` 或看不懂 */
  function readReceipt(rec) {
    if (!rec) return null;
    try {
      const json = JSON.parse(rec.body);
      if (!json || typeof json !== 'object') return null;
      const code = Number(json.code);
      return {
        code: Number.isFinite(code) ? code : undefined,
        message: typeof json.message === 'string' ? json.message : '',
        success: json.success === true,
        status: rec.status,
      };
    } catch {
      return { code: undefined, message: '', success: false, status: rec.status, unparsed: true };
    }
  }

  /** 在座位数据里找这个座位现在的状态名（宽容解析，字段名不硬猜） */
  function findSeatState(node, seatNo, depth = 0) {
    if (!node || depth > 8) return undefined;
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = findSeatState(item, seatNo, depth + 1);
        if (hit) return hit;
      }
      return undefined;
    }
    if (typeof node !== 'object') return undefined;
    const o = node;
    const no = o.no ?? o.seat_no ?? o.seatNo ?? o.name ?? o.code;
    if (no !== undefined && String(no).trim() === seatNo) {
      const st = o.status_name ?? o.statusName ?? o.status ?? o.state;
      if (st !== undefined && st !== null && String(st).trim()) return String(st).trim();
    }
    for (const v of Object.values(o)) {
      if (v && typeof v === 'object') {
        const hit = findSeatState(v, seatNo, depth + 1);
        if (hit) return hit;
      }
    }
    return undefined;
  }

  const FREE_RE = /空闲|可用|free|空位|无人/i;

  /**
   * 下单后核对：拿到系统回执 + 座位图当前状态，给出三态之一。
   * - confirmed：回执成功 且 座位不再空闲
   * - api_ok / pending：只有一条证据
   * - api_error / no_response：失败
   */
  async function verdict(areaId, date, seatNo) {
    const rec = await waitFor(() => (capture.records.length ? capture.records[0] : null), 12_000, 250);
    const receipt = readReceipt(rec);

    let seatState;
    try {
      const seats = await fetchSeats(areaId, date);
      seatState = findSeatState(seats, seatNo);
    } catch {
      seatState = undefined;
    }
    const base = { seatNo, date, areaId, code: receipt?.code, message: receipt?.message, seatState };

    if (receipt && (receipt.code === 0 || receipt.code === 200 || receipt.success)) {
      if (seatState && !FREE_RE.test(seatState)) return { ...base, cause: 'confirmed' };
      // 接口说成功，但座位图还显示空闲（或读不到座位图）——少一条证据，只能算存疑
      return { ...base, cause: 'api_ok' };
    }
    if (receipt && receipt.code !== undefined && receipt.code !== 0) {
      return { ...base, cause: 'api_error', message: receipt.message || `系统返回 code ${receipt.code}` };
    }
    if (receipt) return { ...base, cause: 'pending' };

    // 一条回执都没抓到：页面文字只能当弱证据，不能判成功
    if (pageSaysSuccess()) return { ...base, cause: 'pending', message: '只在页面上看到「成功」字样' };
    return { ...base, cause: 'no_response' };
  }

  function navigate(areaId, date) {
    const href = `#/seat/appointment?id=${encodeURIComponent(areaId)}&date=${encodeURIComponent(date)}`;
    if (location.hash !== href) location.hash = href;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function byText(re, root = document) {
    const nodes = [...root.querySelectorAll('button,div,span,a')];
    return nodes.filter((n) => n.children.length === 0 && re.test((n.textContent || '').trim()));
  }

  function pageSaysSuccess() {
    return Boolean(
      byText(/预约成功|预约已完成|已为您预约/).find((n) => {
        // 排除「我的预约」「预约记录」这类导航文字被误判
        const t = (n.textContent || '').trim();
        return t.length <= 30;
      }),
    );
  }

  async function waitFor(fn, timeoutMs = 8000, stepMs = 250) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const v = fn();
      if (v) return v;
      await sleep(stepMs);
    }
    return null;
  }

  /**
   * 在页面上完成一次预约：定位座位 → 点选 → 点「立即预约」→ 确认弹窗 → 核对回执。
   * 任何一步失败都会把原因和判定码带回去，绝不"假装成功"。
   */
  async function book(args) {
    const areaId = String(args.areaId || '');
    const date = String(args.date || '');
    const seatNo = String(args.seatNo || '');
    if (!token()) return { ok: true, cause: 'no_token', seatNo, date, areaId };
    if (!seatNo) return { ok: true, cause: 'bad_args', seatNo, date, areaId };

    installHook();
    capture.records.length = 0;

    navigate(areaId, date);

    // 座位图是画布 + 覆盖层，座位元素上带座位号文本
    const seatEl = await waitFor(() => byText(new RegExp(`^${seatNo}$`))[0], 12_000);
    if (!seatEl) return { ok: true, cause: 'seat_missing', seatNo, date, areaId };
    seatEl.click();
    await sleep(600);

    const bookBtn = await waitFor(() => byText(/立即预约/)[0], 6_000);
    if (!bookBtn) return { ok: true, cause: 'no_button', seatNo, date, areaId };
    if (bookBtn.disabled || /disabled/.test(bookBtn.className)) {
      return { ok: true, cause: 'btn_disabled', seatNo, date, areaId };
    }

    // 点「立即预约」前后各清一次，避免把上一单的回执当成本次结果
    capture.records.length = 0;
    bookBtn.click();
    await sleep(800);

    // 规则弹窗 / 确认弹窗：文案里带「预约」「确定」「同意」的按钮
    const confirm = await waitFor(() => byText(/^(确定|确认|同意|继续预约|我知道了)$/)[0], 8_000);
    if (!confirm) return { ok: true, cause: 'no_dialog', seatNo, date, areaId };
    confirm.click();

    // 等回执 + 回读座位图，给三态判定
    const v = await verdict(areaId, date, seatNo);
    return { ok: true, ...v };
  }

  /** 给输入框赋值并让 Vue 收到（直接改 value 不派发事件，框架看不见） */
  function fill(el, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * 用存下来的学号 + 图书馆密码登录一次。
   * 找得到表单就填、找得到「登录」就点，最后看 sessionStorage.token 有没有出来——
   * 有验证码 / 弹窗 / 别的风控时这里会如实失败，交给用户自己点。
   */
  async function autoLogin(args) {
    const account = String(args.account || '').trim();
    const password = String(args.password || '');
    if (!account || !password) return { ok: false, error: '没填学号或密码' };
    if (token()) return { ok: true, token: token(), already: true };

    const inputs = Array.from(document.querySelectorAll('input'));
    const pwdEl = inputs.find((i) => i.type === 'password');
    if (!pwdEl) return { ok: false, error: '没找到登录框（可能已经不在登录页）' };
    const accEl =
      inputs.find((i) => i !== pwdEl && /(账号|学号|用户|手机)/.test(i.placeholder || '')) ||
      inputs.find((i) => i !== pwdEl && (i.type === 'text' || i.type === 'tel' || !i.type));
    if (!accEl) return { ok: false, error: '没找到账号框' };

    fill(accEl, account);
    fill(pwdEl, password);
    await sleep(120);

    const btn =
      byText(/^(登录|登 录|立即登录|登陆)$/)[0] ||
      Array.from(document.querySelectorAll('button')).find((b) => /登录|登陆/.test(b.textContent || ''));
    if (!btn) return { ok: false, error: '没找到「登录」按钮' };
    btn.click();

    const tok = await waitFor(() => token(), 12_000, 300);
    if (!tok) return { ok: false, error: '提交了，但没拿到登录态（可能有验证码或密码不对）' };
    return { ok: true, token: tok };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('lib:')) return undefined;
    (async () => {
      try {
        if (msg.type === 'lib:probe') sendResponse(await probe(msg.args || {}));
        else if (msg.type === 'lib:open') {
          navigate(String(msg.args?.areaId || ''), String(msg.args?.date || ''));
          sendResponse({ ok: true });
        } else if (msg.type === 'lib:book') sendResponse(await book(msg.args || {}));
        else if (msg.type === 'lib:autologin') sendResponse(await autoLogin(msg.args || {}));
        else sendResponse({ ok: false, error: `未知指令 ${msg.type}` });
      } catch (e) {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true; // 异步回复
  });

  // 让扩展知道这页就绪（也是「能不能用」的信号）
  try {
    chrome.runtime.sendMessage({ type: 'lib:ready', href: location.href, hasToken: Boolean(token()) });
  } catch {
    /* 扩展没起来时会抛，忽略 */
  }
})();
