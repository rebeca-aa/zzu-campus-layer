package cn.zzu.campuslayer;

import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * 本地小秘密的加解密（目前是图书馆的登录 token）。
 *
 * 为什么不在 Java 里自己存一把钥匙：那样钥匙和密文都在 prefs / 代码里，等于没加。
 * Android Keystore 的钥匙由系统（多数机型是 TEE/StrongBox）保管，
 * 应用只能拿到「用它加密 / 解密」的能力，导不出裸字节；root 之后拷走 prefs 也只是密文。
 *
 * prefs 里存的是 "v1:" + base64(iv) + ":" + base64(密文)，AES-256-GCM、128 位 tag。
 * 任何一步失败都返回 null，调用方退回自己的兜底逻辑 —— 不能因为加密把登录弄坏。
 */
final class SecretStore {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String ALIAS = "campus-layer-secret-v1";
    private static final String TRANSFORM = "AES/GCM/NoPadding";
    private static final String PREFIX = "v1:";
    private static final int TAG_BITS = 128;

    private SecretStore() {}

    private static SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        if (ks.containsAlias(ALIAS)) {
            java.security.Key existing = ks.getKey(ALIAS, null);
            if (existing instanceof SecretKey) return (SecretKey) existing;
        }
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        gen.init(new KeyGenParameterSpec.Builder(
                ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return gen.generateKey();
    }

    /** 明文 → "v1:iv:ct"。环境不支持时返回 null。 */
    static String seal(String plain) {
        if (plain == null || plain.isEmpty()) return null;
        try {
            Cipher cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = cipher.getIV();
            byte[] ct = cipher.doFinal(plain.getBytes(StandardCharsets.UTF_8));
            return PREFIX + b64(iv) + ":" + b64(ct);
        } catch (Throwable t) {
            return null;
        }
    }

    /** "v1:iv:ct" → 明文。解不开返回 null。 */
    static String open(String body) {
        if (body == null || !body.startsWith(PREFIX)) return null;
        try {
            String rest = body.substring(PREFIX.length());
            int cut = rest.indexOf(':');
            if (cut <= 0) return null;
            byte[] iv = unb64(rest.substring(0, cut));
            byte[] ct = unb64(rest.substring(cut + 1));
            Cipher cipher = Cipher.getInstance(TRANSFORM);
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(TAG_BITS, iv));
            return new String(cipher.doFinal(ct), StandardCharsets.UTF_8);
        } catch (Throwable t) {
            return null;
        }
    }

    private static String b64(byte[] raw) {
        return android.util.Base64.encodeToString(raw, android.util.Base64.NO_WRAP);
    }

    private static byte[] unb64(String text) {
        return android.util.Base64.decode(text, android.util.Base64.NO_WRAP);
    }

    /** 老版本 prefs 里的明文 token 迁移成密文（迁移失败就留着，不影响用）。 */
    static void migrateLegacy(SharedPreferences sp, String legacyKey, String sealedKey) {
        try {
            String legacy = sp.getString(legacyKey, "");
            if (legacy == null || legacy.isEmpty()) return;
            String sealed = seal(legacy.trim());
            if (sealed == null) return;
            sp.edit().putString(sealedKey, sealed).remove(legacyKey).apply();
        } catch (Throwable ignored) {
            /* 迁移是顺手的事，失败下次再说 */
        }
    }
}
