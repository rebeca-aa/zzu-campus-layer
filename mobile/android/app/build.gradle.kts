plugins {
  id("com.android.application")
}

android {
  namespace = "cn.zzu.campuslayer"
  compileSdk = 34

  defaultConfig {
    applicationId = "cn.zzu.campuslayer"
    minSdk = 24
    targetSdk = 34
    versionCode = 70
    versionName = "0.2.83"
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  buildTypes {
    debug {
      isMinifyEnabled = false
    }
    release {
      isMinifyEnabled = false
    }
  }
}

/*
 * 有意不引任何第三方依赖（没有 AndroidX、没有 Kotlin 插件）：
 * 壳只做三件事——显示网页、拉一个登录页取 token、把 token 塞回网页。
 * 依赖越少，CI 里构建越不容易炸。
 */
