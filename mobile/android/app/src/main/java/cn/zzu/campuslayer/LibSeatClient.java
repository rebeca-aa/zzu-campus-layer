package cn.zzu.campuslayer;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * 图书馆座位查询：原生侧代 PWA 发 http 请求。
 *
 * 为什么需要它：图书馆站是纯 http，且它对跨源请求不带 CORS 头（实测 POST 200 但 ACAO: null），
 * 所以 https 页面（我们的 PWA）里既被混合内容拦、也会被 CORS 拦。原生 HTTP 客户端两者都不受限制。
 *
 * 登录态（sessionStorage.token）由 LibLoginActivity 里的 WebView 抓一次，存在本地 prefs。
 * 本类是只读的：只查座位表，不下单。
 */
final class LibSeatClient {
    private static final String API = "http://order.lib.zzu.edu.cn/v4/Space/seat";
    private static final String PREFS = "campus_layer";
    /** 老版本存明文的键（只在迁移时读一次） */
    private static final String KEY_TOKEN_LEGACY = "lib_token";
    /** 加密后的 token（SecretStore 封出来的 v1: 信封） */
    private static final String KEY_TOKEN_SEALED = "lib_token_v2";

    private LibSeatClient() {}

    static void saveToken(Context ctx, String token) {
        if (token == null || token.trim().isEmpty()) return;
        String clean = token.trim();
        SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String sealed = SecretStore.seal(clean);
        if (sealed != null) {
            /* 加密成功：顺手把老版本的明文删掉，别留两份 */
            sp.edit().putString(KEY_TOKEN_SEALED, sealed).remove(KEY_TOKEN_LEGACY).apply();
        } else {
            /* Keystore 不可用（极少数老机器）：退回明文，不能让登录直接坏掉 */
            sp.edit().putString(KEY_TOKEN_LEGACY, clean).apply();
        }
    }

    static String token(Context ctx) {
        SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String sealed = sp.getString(KEY_TOKEN_SEALED, "");
        if (sealed == null || sealed.isEmpty()) {
            /* 老版本存的是明文：读到就迁成密文，再把读出来的明文照常返回 */
            SecretStore.migrateLegacy(sp, KEY_TOKEN_LEGACY, KEY_TOKEN_SEALED);
            sealed = sp.getString(KEY_TOKEN_SEALED, "");
        }
        if (sealed != null && !sealed.isEmpty()) {
            String opened = SecretStore.open(sealed);
            /* 解不开说明钥匙没了（清了 Keystore / 换签名装过），当没登录，让用户重新登一次 */
            return opened == null ? "" : opened;
        }
        String legacy = sp.getString(KEY_TOKEN_LEGACY, "");
        return legacy == null ? "" : legacy;
    }

    static boolean loggedIn(Context ctx) {
        return !token(ctx).isEmpty();
    }

    /** 后台线程取座位表，回到主线程用 window.__libSeats(reqId, json) 交回 PWA。 */
    static void fetchAsync(final WebView web, final Context ctx, final String areaId,
                           final String date, final String reqId) {
        new Thread(new Runnable() {
            @Override public void run() {
                String payload;
                try {
                    payload = request(ctx, areaId, date);
                } catch (Throwable t) {
                    JSONObject err = new JSONObject();
                    try {
                        err.put("ok", false);
                        err.put("error", describe(t));
                    } catch (Exception ignored) {}
                    payload = err.toString();
                }
                final String out = payload;
                new Handler(Looper.getMainLooper()).post(new Runnable() {
                    @Override public void run() {
                        deliver(web, reqId, out);
                    }
                });
            }
        }, "lib-seat-fetch").start();
    }

    private static String describe(Throwable t) {
        String m = t.getMessage();
        if (m == null || m.isEmpty()) m = t.getClass().getSimpleName();
        if (m.contains("Cleartext") || m.contains("cleartext")) {
            return "系统禁止明文 http 请求（NetworkSecurityConfig 未放行该域名）";
        }
        if (m.contains("timed out") || m.contains("timeout")) {
            return "连不上图书馆预约系统（需要连校园网或学校 VPN）";
        }
        return m;
    }

    private static String request(Context ctx, String areaId, String date) throws Exception {
        String token = token(ctx);
        if (token.isEmpty()) {
            JSONObject o = new JSONObject();
            o.put("ok", false);
            o.put("error", "还没登录图书馆：点设置面板里的「登录图书馆」，在打开的页面里登录一次");
            return o.toString();
        }
        JSONObject body = new JSONObject();
        body.put("id", areaId);
        body.put("day", date);
        body.put("label_id", new org.json.JSONArray());
        body.put("start_time", "07:30");
        body.put("end_time", "22:30");
        body.put("begdate", "");
        body.put("enddate", "");

        HttpURLConnection conn = (HttpURLConnection) new URL(API).openConnection();
        conn.setRequestMethod("POST");
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(12000);
        conn.setDoOutput(true);
        conn.setRequestProperty("content-type", "application/json");
        conn.setRequestProperty("X-Requested-With", "XMLHttpRequest");
        conn.setRequestProperty("authorization", "bearer" + token);
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        conn.setFixedLengthStreamingMode(bytes.length);
        try (OutputStream os = conn.getOutputStream()) {
            os.write(bytes);
        }
        int code = conn.getResponseCode();
        InputStream is = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
        StringBuilder sb = new StringBuilder();
        if (is != null) {
            try (BufferedReader br = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
                String line;
                while ((line = br.readLine()) != null) sb.append(line);
            }
        }
        conn.disconnect();

        String raw = sb.toString();
        if (code >= 400) {
            JSONObject o = new JSONObject();
            o.put("ok", false);
            o.put("error", "图书馆接口 HTTP " + code);
            return o.toString();
        }
        JSONObject wrap = new JSONObject();
        wrap.put("ok", true);
        wrap.put("raw", new JSONObject(raw));
        return wrap.toString();
    }

    /** 馆级余量（pcTopFor）：不需要登录票据。 */
    static void fetchTopAsync(final WebView web, final Context ctx, final String areaId,
                              final String date, final String reqId) {
        new Thread(new Runnable() {
            @Override public void run() {
                String payload;
                try {
                    payload = requestTop(areaId, date);
                } catch (Throwable t) {
                    JSONObject err = new JSONObject();
                    try {
                        err.put("ok", false);
                        err.put("error", describe(t));
                    } catch (Exception ignored) {}
                    payload = err.toString();
                }
                final String out = payload;
                new Handler(Looper.getMainLooper()).post(new Runnable() {
                    @Override public void run() { deliver(web, reqId, out); }
                });
            }
        }, "lib-top-fetch").start();
    }

    static String requestTop(String areaId, String date) throws Exception {
        JSONObject body = new JSONObject();
        body.put("id", areaId == null || areaId.isEmpty() ? "1" : areaId);
        if (date != null && !date.isEmpty()) body.put("date", date);
        HttpURLConnection conn = (HttpURLConnection) new URL(
                "http://order.lib.zzu.edu.cn/v4/space/pcTopFor").openConnection();
        conn.setRequestMethod("POST");
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(12000);
        conn.setDoOutput(true);
        conn.setRequestProperty("content-type", "application/json");
        conn.setRequestProperty("X-Requested-With", "XMLHttpRequest");
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        conn.setFixedLengthStreamingMode(bytes.length);
        try (OutputStream os = conn.getOutputStream()) { os.write(bytes); }
        int code = conn.getResponseCode();
        InputStream is = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
        StringBuilder sb = new StringBuilder();
        if (is != null) {
            try (BufferedReader br = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
                String line;
                while ((line = br.readLine()) != null) sb.append(line);
            }
        }
        conn.disconnect();
        if (code >= 400) {
            JSONObject o = new JSONObject();
            o.put("ok", false);
            o.put("error", "图书馆接口 HTTP " + code);
            return o.toString();
        }
        JSONObject wrap = new JSONObject();
        wrap.put("ok", true);
        wrap.put("raw", new JSONObject(sb.toString()));
        return wrap.toString();
    }

    static boolean hasToken(Context ctx) { return loggedIn(ctx); }
    static void deliverPublic(WebView web, String reqId, String json) { deliver(web, reqId, json); }

    static void reply(WebView web, String reqId, boolean ok, String msg) {
        deliver(web, reqId, "{\"ok\":" + ok + ",\"error\":" + q(msg) + "}");
    }

    private static String q(String v) {
        if (v == null) return "null";
        return "\"" + v.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    private static void deliver(WebView web, String reqId, String json) {
        if (web == null || reqId == null || reqId.isEmpty()) return;
        String fn = "window.__libSeats&&window.__libSeats(" + JSONObject.quote(reqId) + "," + JSONObject.quote(json) + ")";
        web.evaluateJavascript(fn, null);
    }
}
