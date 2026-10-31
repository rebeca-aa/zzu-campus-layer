package cn.zzu.campuslayer;

import android.webkit.JavascriptInterface;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Iterator;

/**
 * 网页 → 壳的网络通道。
 *
 * 一卡通（ecard.v.zzu.edu.cn）那几个接口**没有 CORS 头**（OPTIONS 预检直接 403、
 * 响应里没有 Access-Control-Allow-Origin），所以网页里 fetch 一定会被浏览器拦掉。
 * 只有扩展面板（有 host_permissions）和壳的原生请求能真的发出去。
 *
 * addJavascriptInterface 的回调跑在 WebView 的 JavaBridge 私有线程上（不是 UI 线程），
 * 所以这里可以同步阻塞地把请求做完，再把结果作为字符串还给页面。
 *
 * 返回的 JSON：{status, body, location, error?}
 *   - status：HTTP 状态码，0 表示请求没发出去
 *   - body：响应正文（UTF-8）
 *   - location：Location 响应头（一卡通换票要靠它拿 tid）
 */
public class CampusNet {

    @JavascriptInterface
    public String http(String method, String url, String headersJson, String body) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod(method == null || method.isEmpty() ? "GET" : method.toUpperCase());
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(15000);
            /* 一卡通换票靠 302 的 Location，这里不跟随，交给页面自己判断 */
            conn.setInstanceFollowRedirects(false);
            conn.setRequestProperty("accept", "application/json, text/plain, */*");
            if (headersJson != null && !headersJson.isEmpty()) {
                JSONObject headers = new JSONObject(headersJson);
                Iterator<String> keys = headers.keys();
                while (keys.hasNext()) {
                    String k = keys.next();
                    if ("content-type".equalsIgnoreCase(k)) {
                        conn.setRequestProperty("content-type", "application/json; charset=utf-8");
                    } else {
                        conn.setRequestProperty(k, headers.optString(k, ""));
                    }
                }
            }
            if (body != null && !body.isEmpty()) {
                conn.setDoOutput(true);
                if (conn.getRequestProperty("content-type") == null) {
                    conn.setRequestProperty("content-type", "application/json; charset=utf-8");
                }
                OutputStream os = conn.getOutputStream();
                try {
                    os.write(body.getBytes("UTF-8"));
                    os.flush();
                } finally {
                    try {
                        os.close();
                    } catch (Exception ignored) {
                    }
                }
            }

            int status = conn.getResponseCode();
            String location = conn.getHeaderField("Location");
            InputStream is = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String text = is == null ? "" : readAll(is);

            JSONObject out = new JSONObject();
            out.put("status", status);
            out.put("body", text);
            out.put("location", location == null ? "" : location);
            return out.toString();
        } catch (Exception e) {
            try {
                JSONObject out = new JSONObject();
                out.put("status", 0);
                out.put("body", "");
                out.put("location", "");
                out.put("error", String.valueOf(e.getMessage()));
                return out.toString();
            } catch (Exception ignored) {
                return "{\"status\":0,\"body\":\"\",\"location\":\"\",\"error\":\"unknown\"}";
            }
        } finally {
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Exception ignored) {
                }
            }
        }
    }

    private static String readAll(InputStream is) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) > 0) {
            bos.write(buf, 0, n);
        }
        try {
            is.close();
        } catch (Exception ignored) {
        }
        return new String(bos.toByteArray(), "UTF-8");
    }
}
