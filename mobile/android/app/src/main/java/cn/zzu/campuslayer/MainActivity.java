package cn.zzu.campuslayer;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

/**
 * 主界面 = 一块 WebView，装的是我们自己的 PWA。
 *
 * 登录现在直接在壳里做（菜单第一项「登录（推荐）」）：
 *   LoginActivity 打开「CAS + 静态样式文件」的入口，登录成功那一刻地址里带着
 *   ?ticket=<JWT>（ticket 的 payload 里就是 idToken），壳把这个地址原样交给
 *   页面的 window.__campusImport 去解析、解码、落库。
 *
 * 另外还留着两条备选：「从剪贴板导入」（用户在外面复制了带 token 的地址）、
 * 「用系统浏览器登录」（壳内 CAS 出问题时的兜底）。
 */
public class MainActivity extends Activity {

    private static final int REQ_LIB_LOGIN = 3002;
    /** 等登录完成后要补答的那次座位查询（没有登录态时先挂起，不要立刻回错误） */
    private String pendingSeatArea = null;
    private String pendingSeatDate = null;
    private String pendingSeatReq = null;
    private static final int REQ_LIB_BOOK = 3003;
    private boolean renewAsked = false;
    private boolean renewing = false;
    private String PENDING_BOOK_REQ = null;
    private static final int REQ_LOGIN = 3001;

    private WebView web;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        web = new WebView(this);
        setContentView(web, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setUserAgentString(AppConfig.USER_AGENT);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return false;
            }
        });

        /* 课前提醒：网页侧算好时间点，通过这个桥交给壳去设闹钟。 */
        // App 版本变化就清一次 WebView 的 HTTP 缓存：壳是长期不关的 WebView，
        // 旧 chunk / 旧 SW 会一直活着（cookie 与 localStorage 不动，登录态保留）。
        try {
            String vn = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            String last = getSharedPreferences("campus_layer", MODE_PRIVATE).getString("web_cache_ver", "");
            if (!vn.equals(last)) {
                web.clearCache(true);
                // 只清 HTTP 缓存不够：旧 Service Worker 仍会拿缓存里的 index.html，
                // 于是前端永远停在旧 chunk。这里注销 SW + 清 caches，随后重载一次。
                web.evaluateJavascript(
                    "(async()=>{try{const rs=await navigator.serviceWorker.getRegistrations();for(const r of rs)await r.unregister();const ks=await caches.keys();for(const k of ks)await caches.delete(k);}catch(e){}})()",
                    null);
                getSharedPreferences("campus_layer", MODE_PRIVATE).edit().putString("web_cache_ver", vn).apply();
            }
        } catch (Exception ignored) {
        }
        web.addJavascriptInterface(new NotifyBridge(), "CampusNotify");

        CrashLog.install(this);

        web.loadUrl(AppConfig.APP_URL);

        askNotificationPermission();
        ReminderScheduler.restore(this);

        /* 第一次打开时给个提示，而不是把登录页硬推上来。 */
        if (!getPreferences(MODE_PRIVATE).getBoolean("hinted", false)) {
            getPreferences(MODE_PRIVATE).edit().putBoolean("hinted", true).apply();
            Toast.makeText(this,
                    "点页面里的「用学校账号登录」，登录一次就行——登录完会自动回来",
                    Toast.LENGTH_LONG).show();
        }
    }

    /** 网页 → 壳：一批课前提醒（{at,title,body} 的数组）。JS 接口在各线程回调，切回主线程。 */
    private class NotifyBridge {
        /** 页面 → 壳：立刻弹一条系统通知（有新通知时用）。 */
        /** 图书馆馆级余量（免登录）。 */
        @android.webkit.JavascriptInterface
        public void libTopFor(final String areaId, final String date, final String reqId) {
            web.post(new Runnable() {
                @Override public void run() {
            LibSeatClient.fetchTopAsync(web, MainActivity.this, areaId, date, reqId);
        
                }
            });
        }

        /** 是否已抓过图书馆票据。 */
        @android.webkit.JavascriptInterface
        public boolean libLoggedIn() {
            return LibSeatClient.hasToken(MainActivity.this);
        }

        /** 直接打开图书馆登录页。 */
        @android.webkit.JavascriptInterface
        public void loginLibrary() {
            runOnUiThread(new Runnable() {
                @Override public void run() { openLibraryLogin(); }
            });
        }

        /** 长按确认后真正下单：交给 LibBookActivity，由页面自己发 confirm（含 AES）。 */
        @JavascriptInterface
        public void bookSeat(final String areaId, final String date, final String seatNo, final String reqId) {
            web.post(new Runnable() {
                @Override public void run() {
                    if (!LibSeatClient.hasToken(MainActivity.this)) {
                        LibSeatClient.reply(web, reqId, false, "还没登录图书馆：先点菜单里的「登录图书馆」登录一次");
                        openLibraryLogin();
                        return;
                    }
                    PENDING_BOOK_REQ = reqId;
                    Intent it = new Intent(MainActivity.this, LibBookActivity.class);
                    it.putExtra("areaId", areaId);
                    it.putExtra("date", date);
                    it.putExtra("seatNo", seatNo);
                    startActivityForResult(it, REQ_LIB_BOOK);
                }
            });
        }
        /** 图书馆座位（只读）：有票据就原生直连取，没有就引导去登录。 */
        @android.webkit.JavascriptInterface
        public void libSeats(final String areaId, final String date, final String reqId) {
            web.post(new Runnable() {
                @Override public void run() {
            if (!LibSeatClient.loggedIn(MainActivity.this)) {
                // 先不回答：等这次登录完成后，用同一个 reqId 把座位表补答回去。
                pendingSeatArea = areaId;
                pendingSeatDate = date;
                pendingSeatReq = reqId;
                openLibraryLogin();
                return;
            }
            LibSeatClient.fetchAsync(web, MainActivity.this, areaId, date, reqId);
        
                }
            });
        }

        @JavascriptInterface
        public void notify(String title, String body) {
            runOnUiThread(() -> ReminderReceiver.showNow(MainActivity.this, title, body));
        }

        /** 页面 → 壳：请求通知权限（用户打开开关时才问）。 */
        @JavascriptInterface
        public void askNotify() {
            runOnUiThread(MainActivity.this::askNotificationPermission);
        }

        /** 网页里的「用学校账号登录」按钮 → 壳：走壳内登录页，登录完自动回灌。 */
        @JavascriptInterface
        public void login() {
            runOnUiThread(MainActivity.this::openLogin);
        }

        @JavascriptInterface
        public void setReminders(String json) {
            runOnUiThread(() -> {
                ReminderScheduler.apply(MainActivity.this, json);
                Toast.makeText(MainActivity.this, "课前提醒已排好", Toast.LENGTH_SHORT).show();
            });
        }
        /** PWA 面板上的「立即续期」按钮：走这里（壳没有可用的右上角菜单）。 */
        @android.webkit.JavascriptInterface
        public void renewLogin() {
            web.post(new Runnable() {
                @Override
                public void run() {
                    forceRenew();
                }
            });
        }

        /**
         * 绑定向导第一步：页面把学号密码丢过来，原生去问学校「这台设备要不要验证」，
         * 要就顺手把短信发出去。结果经 {@code window.__campusBind(json)} 回给页面。
         *
         * <p>为什么不让页面自己发：{@code cas.s.zzu.edu.cn} 不给我们 ACAO，浏览器里
         * 一个 POST 都发不出去（预检直接 403）。
         */
        @JavascriptInterface
        public void appBindStart(String credsJson) {
            final String json = credsJson == null ? "" : credsJson;
            new Thread(() -> {
                String out;
                try {
                    out = AppBind.start(json);
                } catch (Throwable t) {
                    out = bindError(t);
                }
                final String result = out;
                runOnUiThread(() -> pushBind(result));
            }, "bind-start").start();
        }

        /** 绑定向导第二步：校验短信码。过了原生顺手换一张 30 天票，idToken 一起回给页面。 */
        @JavascriptInterface
        public void appBindSubmit(String code) {
            final String digits = code == null ? "" : code;
            new Thread(() -> {
                String out;
                try {
                    out = AppBind.submit(digits);
                } catch (Throwable t) {
                    out = bindError(t);
                }
                final String result = out;
                runOnUiThread(() -> pushBind(result));
            }, "bind-submit").start();
        }

        /** 上次崩溃的栈文本（没崩过就是空串）；页面把它显示出来，用户能直接复制给开发者。 */
        @JavascriptInterface
        public String lastCrash() {
            return CrashLog.last(MainActivity.this);
        }

        /** 用户点「已读」后清掉，免得老崩溃一直挂在设置页。 */
        @JavascriptInterface
        public void clearCrash() {
            CrashLog.clear(MainActivity.this);
        }
    }

    /** 后台线程里的兜底：任何 Throwable 都变成一条给页面看的错误，绝不让进程退。 */
    private static String bindError(Throwable t) {
        return "{\"step\":\"error\",\"message\":\"壳里出错：" + t.getClass().getSimpleName() + "\"}";
    }

    /** 把绑定向导的一步结果交回页面。 */
    private void pushBind(String json) {
        if (web == null || json == null) {
            return;
        }
        try {
            web.evaluateJavascript(
                    "window.__campusBind&&window.__campusBind(" + org.json.JSONObject.quote(json) + ")", null);
        } catch (Throwable ignored) {
            // 页面刚好在重载 / WebView 已销毁：丢掉这一步就行，别为它崩掉整个 App
        }
    }

    /**
     * 登录态快到期（<2 小时）时，在后台静默续一次：
     * CAS 的 TGT cookie 还在的话，一条请求就能换新票，不用你重登、也不闪页面。
     */
    private void maybeSilentRenew() {
        if (renewAsked || web == null) {
            return;
        }
        renewAsked = true;
        web.evaluateJavascript("(function(){try{var raw=localStorage.getItem('campus-layer:tokens');if(!raw)return '{\"need\":false}';var o=JSON.parse(raw);var j=(o.jwxt&&o.jwxt.token)||'';if(!j)return '{\"need\":false}';var b=j.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');var p=JSON.parse(decodeURIComponent(escape(atob(b))));var left=Math.round((p.exp*1000-Date.now())/60000);return JSON.stringify({need:left<120,leftMin:left});}catch(e){return '{\"need\":false}'}})()", value -> {
            String s = value == null ? "" : value;
            if (s.contains("\"need\":true")) {
                renewQuickly();
            }
        });
    }

    /**
     * 续票的三级台阶，越靠前越省事：
     * 1. {@link AppMint}：学号密码直换 **30 天**的票（学校 App 那套接口；设备可信时不需要验证码）；
     * 2. {@link CasMint}：CAS 的 TGT cookie 还在的话，一条请求换 8 小时的票（不闪页面）；
     * 3. 都不行才让 LoginActivity 静默走一遍登录页，那里可能还得补一次 MFA。
     */
    private void renewQuickly() {
        renewQuickly(false);
    }

    /**
     * @param userAsked 用户自己点的「立即续期」（要弹「续期成功/失败」），而不是静默兜底
     */
    private void renewQuickly(boolean userAsked) {
        if (web == null) {
            return;
        }
        // 先把 PWA 存在 localStorage 里的学号密码读出来（没绑过就是空串，直接跳过第一级）
        web.evaluateJavascript("(function(){try{return localStorage.getItem('campus-layer:appCreds')||''}catch(e){return ''}})()",
                value -> {
                    final String credsJson = jsString(value);
                    /* 必须按 /cas/ 这个路径取：TGC / SESSION / CAS_TRACE_ID 的 Path 都是 /cas/，
                       用站点根路径去问只会拿到空串（CookieManager 是按路径匹配的）。 */
                    final String cookies = CookieManager.getInstance().getCookie("https://cas.s.zzu.edu.cn/cas/");
                    new Thread(() -> {
                        String link = null;
                        if (!credsJson.isEmpty()) {
                            link = AppMint.mint(credsJson);
                        }
                        if (link == null) {
                            link = CasMint.mint(cookies);
                        }
                        final String out = link;
                        runOnUiThread(() -> {
                            if (out != null) {
                                if (userAsked) {
                                    Toast.makeText(MainActivity.this, "登录态已刷新", Toast.LENGTH_SHORT).show();
                                    web.evaluateJavascript(
                                            "window.__campusRenew&&window.__campusRenew('ok')", null);
                                }
                                inject(out, false);
                            } else {
                                // 静默那条路不打扰用户；用户自己点的那条要让他知道接下来可能要 MFA
                                renewing = userAsked;
                                if (userAsked) {
                                    Toast.makeText(MainActivity.this, "需要在学校登录页确认一次", Toast.LENGTH_SHORT).show();
                                }
                                startActivityForResult(new Intent(MainActivity.this, LoginActivity.class)
                                        .putExtra("silent", true), REQ_LOGIN);
                            }
                        });
                    }, "renew-mint").start();
                });
    }

    /** evaluateJavascript 的结果是 JSON 字面量（带引号或 null），拆成普通字符串。 */
    private static String jsString(String value) {
        if (value == null || value.isEmpty() || "null".equals(value)) {
            return "";
        }
        try {
            return new org.json.JSONArray("[" + value + "]").getString(0);
        } catch (Exception e) {
            return "";
        }
    }

    /** Android 13+ 通知要用户授权，没有就当场问一次。 */
    private void askNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        if (checkSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED) return;
        requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 2001);
    }

    /** 用系统浏览器打开登录页（CAS → 教学管理平台，登录成功后地址栏里就带着 idToken）。 */
    private void openInBrowser(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception e) {
            Toast.makeText(this, "没有可用的浏览器：" + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    /** 读系统剪贴板，交给 PWA 自己解析（它认同步码、裸 token、学校页面网址三种）。 */
    private void importFromClipboard() {
        ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
        if (cm == null || !cm.hasPrimaryClip()) {
            Toast.makeText(this, "剪贴板是空的：先在浏览器登录，再长按地址栏复制", Toast.LENGTH_LONG).show();
            return;
        }
        ClipData clip = cm.getPrimaryClip();
        if (clip == null || clip.getItemCount() == 0) {
            Toast.makeText(this, "剪贴板里没有文本", Toast.LENGTH_LONG).show();
            return;
        }
        CharSequence text = clip.getItemAt(0).coerceToText(this);
        String raw = text == null ? "" : text.toString().trim();
        if (raw.isEmpty()) {
            Toast.makeText(this, "剪贴板里没有文本", Toast.LENGTH_LONG).show();
            return;
        }
        inject(raw);
    }

    /** 把内容交给网页里的 PWA：window.__campusImport("…")，由它负责解析与报错。 */
    private void inject(String raw) {
        inject(raw, true);
    }

    /** @param toast 静默续期时传 false，别在用户没操作的时候弹 Toast */
    private void inject(String raw, boolean toast) {
        String js = "window." + AppConfig.IMPORT_FN + " && window." + AppConfig.IMPORT_FN
                + "(" + quote(raw) + ")";
        web.evaluateJavascript(js, value -> {
            if (toast) {
                Toast.makeText(this, "已交给页面处理", Toast.LENGTH_SHORT).show();
            }
        });
    }

    /** 最小可用的 JS 字符串字面量转义（token / URL 只含可打印字符，够用）。 */
    private static String quote(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                default: sb.append(c);
            }
        }
        return sb.append('"').toString();
    }

    @Override
    public boolean onCreateOptionsMenu(android.view.Menu menu) {
        menu.add(0, 1, 0, "登录（推荐）");
        menu.add(0, 2, 1, "从剪贴板导入");
        menu.add(0, 4, 2, "用系统浏览器登录");
        menu.add(0, 5, 2, "登录图书馆");
        menu.add(0, 6, 3, "立即续期（验登录）");
        menu.add(0, 3, 3, "刷新");
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(android.view.MenuItem item) {
        switch (item.getItemId()) {
            case 1: openLogin(); return true;
            case 4: openInBrowser(AppConfig.LOGIN_URL); return true;
            case 2: importFromClipboard(); return true;
            case 3: web.reload(); return true;
            case 5: openLibraryLogin(); return true;
            case 6: forceRenew(); return true;
            default: return super.onOptionsItemSelected(item);
        }
    }

    /** 壳内登录：登录页在 WebView 里跑，拿到票就自动回来（不用复制地址）。 */
    /** 菜单「立即续期」：不管剩多久，立刻走一次静默续期，用来当场验证。 */
    private void forceRenew() {
        Toast.makeText(this, "正在后台续期…", Toast.LENGTH_SHORT).show();
        renewQuickly(true);
    }

    private void openLogin() {
        startActivityForResult(new Intent(this, LoginActivity.class), REQ_LOGIN);
    }

    private void openLibraryLogin() {
        startActivityForResult(new Intent(this, LibLoginActivity.class), REQ_LIB_LOGIN);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_LIB_BOOK) {
            String req = PENDING_BOOK_REQ;
            PENDING_BOOK_REQ = null;
            String payload = (data == null) ? null : data.getStringExtra("result");
            if (resultCode == RESULT_OK && payload != null) {
                LibSeatClient.deliverPublic(web, req, payload);
                Toast.makeText(this, "已提交，请核对图书馆页面上的结果", Toast.LENGTH_LONG).show();
            } else {
                LibSeatClient.reply(web, req, false, "已取消，没有提交预约");
            }
            return;
        }

        if (requestCode == REQ_LIB_LOGIN) {
            if (resultCode == RESULT_OK) {
                Toast.makeText(this, pendingSeatReq != null ? "图书馆登录成功，正在取座位表…" : "图书馆登录成功。现在问「一楼座位图」就行", Toast.LENGTH_LONG).show();
            }
            final String pArea = pendingSeatArea;
            final String pDate = pendingSeatDate;
            final String pReq = pendingSeatReq;
            pendingSeatArea = null;
            pendingSeatDate = null;
            pendingSeatReq = null;
            if (pReq != null && LibSeatClient.loggedIn(this)) {
                LibSeatClient.fetchAsync(web, this, pArea, pDate, pReq);
            } else if (pReq != null) {
                String js = "window.__libSeats&&window.__libSeats("
                        + org.json.JSONObject.quote(pReq) + ","
                        + org.json.JSONObject.quote("{\"ok\":false,\"error\":\"图书馆登录没拿到票据：请重开「登录图书馆」，登录后停留两秒再退回\"}")
                        + ")";
                web.evaluateJavascript(js, null);
            }
            return;
        }
        if (requestCode != REQ_LOGIN || resultCode != RESULT_OK || data == null) {
            return;
        }
        String payload = data.getStringExtra("payload");
        if (payload == null || payload.trim().isEmpty()) {
            if (renewing) {
            // 续不上了：直接把人送到学校登录页（静默失败最常见的原因是 TGT 也过期）
            renewing = false;
            boolean autoFallbackLogin = resultCode != RESULT_OK;
            if (autoFallbackLogin) {
                Toast.makeText(this, "自动续期没成功，请在学校登录页重新登录一次", Toast.LENGTH_LONG).show();
                startActivityForResult(new Intent(this, LoginActivity.class), REQ_LOGIN);
                return;
            }
                renewing = false;
                Toast.makeText(this, "续期失败：没拿到票，可能要在设置里重登一次", Toast.LENGTH_LONG).show();
                web.evaluateJavascript("window.__campusRenew&&window.__campusRenew('fail')", null);
            } else {
                Toast.makeText(this, "没拿到登录信息，再试一次", Toast.LENGTH_LONG).show();
            }
            return;
        }
        if (renewing) {
            renewing = false;
            Toast.makeText(this, "续期成功，登录态已刷新", Toast.LENGTH_SHORT).show();
            web.evaluateJavascript("window.__campusRenew&&window.__campusRenew('ok')", null);
        }
        inject(payload.trim());
    }

    @Override
    protected void onResume() {
        super.onResume();
        maybeSilentRenew();
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
