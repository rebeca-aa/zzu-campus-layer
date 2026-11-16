package cn.zzu.campuslayer;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/**
 * 壳自己的更新通道。
 *
 * <p>网页那套（Pages 上的 version.json + Service Worker）只能换前端；原生代码、权限、
 * WebView 的补丁都必须装新 APK。这里把「发现新版 → 下载 → 让系统装」全做完，用户只需要点两下。
 *
 * <p>版本信息是 shell.json：
 * <pre>{"versionCode":112,"versionName":"0.2.127","apkUrl":"https://github.com/.../campus-layer-debug.apk"}</pre>
 * 它和 APK 一起挂在 Release 的滚动 tag apk-latest 上（先传 APK、后传 shell.json，
 * 所以读到清单时包一定已经就位，不会出现「提示有新版、下下来还是旧签名」）。
 * 刻意只用这一个地址：网页那边（Pages）不参与壳的版本号，免得两边对不上。
 *
 * <p>签名：以前每次 CI 都用随机 debug 钥匙，包与包之间签名不一致，根本没法覆盖安装。
 * 现在 CI 第一次构建时会生成一把固定的钥匙并提交进仓库，之后所有包互相可覆盖升级；
 * 也正因为换了钥匙，老用户第一次要先卸载再装（数据会被清掉，重登一次即可）。
 */
final class AppUpdater {

    /** 版本清单和 APK 放在同一个 Release 里：读到的版本号一定对应得到能装的包。 */
    static final String META_URL =
            "https://github.com/rebeca-aa/zzu-campus-layer/releases/download/apk-latest/shell.json";

    private static final String PREFS = "campus_layer";
    private static final String KEY_LAST = "shell_check_ms";
    /** 自动检查的间隔：同一个版本反复弹窗很烦，6 小时一次足够 */
    private static final long AUTO_EVERY_MS = 6L * 60 * 60 * 1000;
    private static final int TIMEOUT_MS = 12000;

    private static volatile boolean checking = false;

    private AppUpdater() {
    }

    static int versionCode(Context c) {
        try {
            return c.getPackageManager().getPackageInfo(c.getPackageName(), 0).versionCode;
        } catch (Throwable t) {
            return 0;
        }
    }

    static String versionName(Context c) {
        try {
            return c.getPackageManager().getPackageInfo(c.getPackageName(), 0).versionName;
        } catch (Throwable t) {
            return "?";
        }
    }

    /** 启动时调用：6 小时内查过就不再查，也不打扰用户。 */
    static void maybeCheck(Activity a) {
        SharedPreferences sp = a.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (System.currentTimeMillis() - sp.getLong(KEY_LAST, 0L) < AUTO_EVERY_MS) {
            return;
        }
        check(a, false);
    }

    /**
     * 查一次线上 shell.json。
     *
     * @param manual 用户主动点「检查更新」：无论结果都给一句反馈（自动检查只在有新版时说话）
     */
    static void check(final Activity a, final boolean manual) {
        if (checking) {
            return;
        }
        checking = true;
        a.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putLong(KEY_LAST, System.currentTimeMillis()).apply();

        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    JSONObject meta = fetchMeta(a);
                    final int remote = meta.optInt("versionCode", 0);
                    final String name = meta.optString("versionName", "");
                    final String url = meta.optString("apkUrl", "");
                    final int local = versionCode(a);
                    a.runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            if (a.isFinishing() || a.isDestroyed()) {
                                return;
                            }
                            if (remote > local && url.startsWith("https://")) {
                                askUpdate(a, name, remote, local, url);
                            } else if (manual) {
                                toast(a, "壳已经是最新的 v" + versionName(a) + "（网页会自动更新）");
                            }
                        }
                    });
                } catch (final Throwable t) {
                    if (manual) {
                        a.runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                if (!a.isFinishing()) {
                                    toast(a, "检查壳更新失败：" + brief(t));
                                }
                            }
                        });
                    }
                } finally {
                    checking = false;
                }
            }
        }, "shell-update-check").start();
    }

    // ---- 下载 + 安装 ----

    private static void askUpdate(final Activity a, final String name, int remote, int local, final String url) {
        String msg = "壳可以升到 v" + name + "（当前 v" + versionName(a) + "）。\n"
                + "下载后点系统弹的「安装」，登录态和设置都不会丢。";
        new AlertDialog.Builder(a)
                .setTitle("壳有新版本")
                .setMessage(msg)
                .setPositiveButton("现在更新", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface d, int w) {
                        download(a, url, name);
                    }
                })
                .setNegativeButton("稍后", null)
                .show();
    }

    private static void download(final Activity a, final String url, final String name) {
        toast(a, "正在下载 v" + name + "…");
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    File dir = ApkProvider.dirFor(a);
                    //noinspection ResultOfMethodCallIgnored
                    dir.mkdirs();
                    final File out = new File(dir, "campus-layer-" + name + ".apk");
                    fetchTo(url, out, a);
                    final String problem = checkApk(a, out);
                    a.runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            if (a.isFinishing() || a.isDestroyed()) {
                                return;
                            }
                            if (problem != null) {
                                showFail(a, problem);
                            } else if (!sameSigner(a, out)) {
                                askUninstallFirst(a, name, url);
                            } else {
                                install(a, out);
                            }
                        }
                    });
                } catch (final Throwable t) {
                    a.runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            if (!a.isFinishing()) {
                                showFail(a, "下载没成功：" + brief(t));
                            }
                        }
                    });
                }
            }
        }, "shell-update-download").start();
    }

    private static void showFail(Activity a, String why) {
        new AlertDialog.Builder(a)
                .setTitle("更新没成")
                .setMessage(why + "\n\n过一会儿再点「我的 → 检查更新」重试就行。")
                .setPositiveButton("知道了", null)
                .show();
    }

    /** 第一次换签名：系统不允许直接覆盖，只能先卸载（数据会清掉）。 */
    private static void askUninstallFirst(final Activity a, String name, final String url) {
        new AlertDialog.Builder(a)
                .setTitle("这次要先卸载再装")
                .setMessage("v" + name + " 换了签名（统一成一把固定的钥匙，以后就能直接覆盖升级了）。\n"
                        + "系统不允许换签名的包覆盖安装，所以这次得先卸载再装一次：卸载会清掉本机的登录态、"
                        + "图书馆票据和设置，装好后重新登录一次就好。")
                .setPositiveButton("去卸载", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface d, int w) {
                        try {
                            a.startActivity(new Intent(Intent.ACTION_DELETE, Uri.parse("package:" + a.getPackageName())));
                        } catch (Throwable t) {
                            toast(a, "打不开卸载界面：" + brief(t));
                        }
                        toast(a, "卸载后重开下载页装一次：" + url);
                    }
                })
                .setNegativeButton("稍后", null)
                .show();
    }

    private static void install(Activity a, File apk) {
        // Android 8+ 必须用户先允许「安装未知应用」，否则安装器直接拒
        if (Build.VERSION.SDK_INT >= 26) {
            try {
                if (!a.getPackageManager().canRequestPackageInstalls()) {
                    toast(a, "先打开「允许安装未知应用」，再点一次「检查更新」");
                    a.startActivity(new Intent(
                            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                            Uri.parse("package:" + a.getPackageName())));
                    return;
                }
            } catch (Throwable ignored) {
                // 有些 ROM 没有这个页面：继续往下试，安装器自己会拦
            }
        }
        Intent it = new Intent(Intent.ACTION_VIEW);
        it.setDataAndType(ApkProvider.uriFor(a, apk), "application/vnd.android.package-archive");
        it.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            a.startActivity(it);
        } catch (Throwable t) {
            showFail(a, "打不开系统安装界面：" + brief(t));
        }
    }

    // ---- 校验 ----

    /** 下载下来的必须还是我们这个包名、版本号也对得上，免得把别的 APK 塞给安装器。 */
    private static String checkApk(Context c, File apk) {
        try {
            PackageManager pm = c.getPackageManager();
            PackageInfo info = pm.getPackageArchiveInfo(apk.getAbsolutePath(), PackageManager.GET_SIGNATURES);
            if (info == null || info.applicationInfo == null) {
                return "下载的东西不是安装包（可能被网络拦截了）";
            }
            if (!c.getPackageName().equals(info.applicationInfo.packageName)) {
                return "下载到的不是这个 App 的安装包";
            }
            return null;
        } catch (Throwable t) {
            return "安装包读不出来：" + brief(t);
        }
    }

    /** 我们的证书 vs 新包的证书：一致才能覆盖安装（数据保留）。 */
    private static boolean sameSigner(Context c, File apk) {
        try {
            PackageManager pm = c.getPackageManager();
            PackageInfo mine = pm.getPackageInfo(c.getPackageName(), PackageManager.GET_SIGNATURES);
            PackageInfo theirs = pm.getPackageArchiveInfo(apk.getAbsolutePath(), PackageManager.GET_SIGNATURES);
            if (mine.signatures == null || theirs == null || theirs.signatures == null) {
                return false;
            }
            String ours = fingerprint(mine.signatures[0]);
            for (Signature s : theirs.signatures) {
                if (ours.equals(fingerprint(s))) {
                    return true;
                }
            }
            return false;
        } catch (Throwable t) {
            return false;
        }
    }

    private static String fingerprint(Signature s) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        byte[] dig = md.digest(s.toByteArray());
        StringBuilder sb = new StringBuilder(dig.length * 2);
        for (byte b : dig) {
            sb.append(Character.forDigit((b >> 4) & 0xf, 16)).append(Character.forDigit(b & 0xf, 16));
        }
        return sb.toString();
    }

    // ---- 网络 ----

    private static JSONObject fetchMeta(Context c) throws Exception {
        HttpURLConnection conn = open(META_URL, c);
        try {
            InputStream in = conn.getInputStream();
            byte[] buf = readAll(in, 64 * 1024);
            return new JSONObject(new String(buf, "UTF-8"));
        } finally {
            conn.disconnect();
        }
    }

    private static void fetchTo(String url, File out, Context c) throws Exception {
        HttpURLConnection conn = open(url, c);
        FileOutputStream fos = new FileOutputStream(out);
        try {
            InputStream in = conn.getInputStream();
            byte[] buf = new byte[64 * 1024];
            int n;
            long total = 0;
            while ((n = in.read(buf)) > 0) {
                fos.write(buf, 0, n);
                total += n;
                if (total > 80L * 1024 * 1024) {
                    throw new java.io.IOException("包太大了，先停");
                }
            }
            fos.flush();
        } finally {
            try {
                fos.close();
            } catch (Throwable ignored) {
            }
            conn.disconnect();
        }
    }

    private static HttpURLConnection open(String url, Context c) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(TIMEOUT_MS);
        conn.setReadTimeout(TIMEOUT_MS);
        conn.setInstanceFollowRedirects(true);
        conn.setRequestProperty("User-Agent", "campus-layer-shell/" + versionName(c));
        conn.setRequestProperty("Cache-Control", "no-cache");
        conn.connect();
        int code = conn.getResponseCode();
        if (code != 200) {
            conn.disconnect();
            throw new java.io.IOException("HTTP " + code);
        }
        return conn;
    }

    private static byte[] readAll(InputStream in, int cap) throws Exception {
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) {
            bos.write(buf, 0, n);
            if (bos.size() > cap) {
                throw new java.io.IOException("响应太大");
            }
        }
        return bos.toByteArray();
    }

    private static void toast(final Activity a, final String msg) {
        try {
            Toast.makeText(a.getApplicationContext(), msg, Toast.LENGTH_LONG).show();
        } catch (Throwable ignored) {
        }
    }

    private static String brief(Throwable t) {
        String m = t.getMessage();
        return (t.getClass().getSimpleName() + (m == null ? "" : "：" + m)).trim();
    }

    /** 页面要显示「壳 v0.2.127」时用。 */
    static String infoJson(Context c) {
        try {
            JSONObject o = new JSONObject();
            o.put("versionCode", versionCode(c));
            o.put("versionName", versionName(c));
            return o.toString();
        } catch (Throwable t) {
            return "{}";
        }
    }


}
