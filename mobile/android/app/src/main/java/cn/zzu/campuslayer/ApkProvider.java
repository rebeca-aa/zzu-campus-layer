package cn.zzu.campuslayer;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * 把私有目录里的 APK 借给系统安装器读。
 *
 * <p>为什么不加 androidx 的 FileProvider：这个壳刻意不带任何第三方依赖（见 build.gradle.kts
 * 末尾那段说明），而且只需要「读一个文件」这一件事，四十行自己写更稳。
 * 网页那边永远不会拿到这个 authority，exported=false + 一次性授权就够。
 */
public class ApkProvider extends ContentProvider {

    /** 安装器读到的包在这：files/update/<文件名> */
    static File dirFor(Context c) {
        return new File(c.getFilesDir(), "update");
    }

    static Uri uriFor(Context c, File f) {
        return new Uri.Builder()
                .scheme("content")
                .authority(c.getPackageName() + ".apk")
                .appendPath(f.getName())
                .build();
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        Context c = getContext();
        if (c == null) {
            throw new FileNotFoundException("没有上下文");
        }
        String name = uri.getLastPathSegment();
        if (name == null || name.contains("/") || name.contains("..")) {
            throw new FileNotFoundException("路径不对");
        }
        File f = new File(dirFor(c), name);
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public String getType(Uri uri) {
        return "application/vnd.android.package-archive";
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection,
                        String[] selectionArgs, String sortOrder) {
        return null;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}
