package cn.zzu.campuslayer;

import android.app.Activity;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 课前提醒的定时器管理。
 *
 * 纯 AlarmManager + BroadcastReceiver，不引 AndroidX（和这个壳其它部分保持一致：
 * 依赖越少，CI 越不容易炸）。提醒块由网页侧的 buildReminderBlocks 算好，
 * 通过 JS 桥传进来：{at(毫秒), title, body}——一节课一条，互不合并。
 *
 * 每次 apply 都会先把上一批闹钟全部撤掉再重排，避免改了课表以后旧闹钟还在响。
 */
public final class ReminderScheduler {

    private static final String PREFS = "reminders";
    private static final String KEY_JSON = "json";

    private ReminderScheduler() {}

    /** 网页算好一批提醒后调这里：存起来 + 撤旧闹钟 + 逐条设新闹钟。 */
    public static void apply(Context ctx, String json) {
        String prev = prefs(ctx).getString(KEY_JSON, "");
        if (prev != null && !prev.isEmpty()) cancelAll(ctx, prev);
        prefs(ctx).edit().putString(KEY_JSON, json).apply();
        scheduleAll(ctx, json);
    }

    /** 开机/重装之后从存档里恢复（AlarmManager 的闹钟在重启后会丢）。 */
    public static void restore(Context ctx) {
        String json = prefs(ctx).getString(KEY_JSON, "");
        if (json != null && !json.isEmpty()) scheduleAll(ctx, json);
    }

    /**
     * 有没有「闹钟和提醒」权限。
     *
     * Android 12 起这条权限默认不给：拿不到就只能排不精确的闹钟，
     * 省电模式下会被压到几十分钟后甚至丢掉 —— 页面要据此提示用户去开。
     */
    public static boolean exactAllowed(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        return am != null && am.canScheduleExactAlarms();
    }

    /** 打开系统的「闹钟和提醒」授权页。 */
    public static void openExactSettings(Activity a) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return;
        try {
            Intent i = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
                    Uri.parse("package:" + a.getPackageName()));
            a.startActivity(i);
        } catch (Exception e) {
            try {
                a.startActivity(new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM));
            } catch (Exception ignored) {
                /* 个别系统没有这个设置页，忽略 */
            }
        }
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /**
     * 一条提醒的 requestCode：按「分钟」粒度避开同一条提醒重复挂号，再混入序号，
     * 让同一时刻的两节课（撞课）也能各响各的。
     */
    private static int reqOf(long at, int index) {
        return (int) (((at / 60_000L) * 37L + index) % Integer.MAX_VALUE);
    }

    /** 0.2.69 及更早的公式（只按时间点算），升级上来时要把它排的旧闹钟一并撤掉。 */
    private static int legacyReqOf(long at) {
        return (int) (at % Integer.MAX_VALUE);
    }

    private static PendingIntent pendingFor(Context ctx, int req, long at, JSONObject o) {
        Intent i2 = new Intent(ctx, ReminderReceiver.class);
        if (o != null) {
            i2.putExtra("title", o.optString("title", "快到上课时间了"));
            i2.putExtra("body", o.optString("body", ""));
            i2.putExtra("at", at);
        }
        return PendingIntent.getBroadcast(
                ctx, req, i2,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** 撤掉一批提醒对应的闹钟（改课表 / 关开关时用）。 */
    private static void cancelAll(Context ctx, String json) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        JSONArray arr;
        try {
            arr = new JSONArray(json);
        } catch (Exception e) {
            return;
        }
        for (int i = 0; i < arr.length(); i += 1) {
            JSONObject o = arr.optJSONObject(i);
            if (o == null) continue;
            long at = o.optLong("at", 0);
            if (at <= 0) continue;
            try {
                am.cancel(pendingFor(ctx, reqOf(at, i), at, null));
                // 旧版本用 at % MAX 当 requestCode，留着会继续按「合并版」文案弹
                am.cancel(pendingFor(ctx, legacyReqOf(at), at, null));
            } catch (Exception ignored) {
                /* 撤不掉也不影响新闹钟 */
            }
        }
    }

    private static void scheduleAll(Context ctx, String json) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        long now = System.currentTimeMillis();

        JSONArray arr;
        try {
            arr = new JSONArray(json);
        } catch (Exception e) {
            return;
        }

        boolean exact = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            exact = am.canScheduleExactAlarms();
        }

        for (int i = 0; i < arr.length(); i += 1) {
            JSONObject o = arr.optJSONObject(i);
            if (o == null) continue;
            long at = o.optLong("at", 0);
            if (at <= now + 60_000L) continue; // 已经过点了，别补弹

            PendingIntent pi = pendingFor(ctx, reqOf(at, i), at, o);
            try {
                if (exact) {
                    /*
                     * 有精确闹钟权限时用「闹钟」而不是普通精确闹钟：setAlarmClock 在状态栏显示闹钟图标，
                     * 省电模式/Doze 下也照响，是唯一能让「课前 30 分钟」准点的写法。
                     */
                    try {
                        am.setAlarmClock(new AlarmManager.AlarmClockInfo(at, pi), pi);
                    } catch (SecurityException noExact) {
                        am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                    }
                } else {
                    // 没拿到精确闹钟权限就退而求其次：可能晚几分钟，但不会完全不响
                    am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                }
            } catch (SecurityException ignored) {
                try {
                    am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                } catch (Exception ignoredToo) {
                    /* 单个闹钟设不上不该拖垮整批 */
                }
            }
        }
    }
}
