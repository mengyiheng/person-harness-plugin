plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.happyharness.app"
    compileSdk = 34
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "com.happyharness.app"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "2.0.0"
    }

    val releaseStoreFile = System.getenv("PH_ANDROID_STORE_FILE")
    val releaseSigningConfigured = listOf(
        releaseStoreFile,
        System.getenv("PH_ANDROID_STORE_PASSWORD"),
        System.getenv("PH_ANDROID_KEY_ALIAS"),
        System.getenv("PH_ANDROID_KEY_PASSWORD")
    ).all { !it.isNullOrBlank() }

    signingConfigs {
        if (releaseSigningConfigured) {
            create("release") {
                storeFile = file(requireNotNull(releaseStoreFile))
                storePassword = System.getenv("PH_ANDROID_STORE_PASSWORD")
                keyAlias = System.getenv("PH_ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("PH_ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (releaseSigningConfigured) {
                signingConfig = signingConfigs.getByName("release")
            }
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    buildFeatures {
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    packaging {
        resources.excludes += "META-INF/*.SF"
        resources.excludes += "META-INF/*.DSA"
        resources.excludes += "META-INF/*.RSA"
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.core:core-ktx:1.13.1")

    // WS + HTTP（中继隧道 / 配对 REST）
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // X25519 / Ed25519（minSdk 26 无平台实现，API 33+ 才有；统一走 BC 保证行为一致）
    implementation("org.bouncycastle:bcprov-jdk18on:1.78.1")

    // 协程
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // 扫码（对齐鸿蒙 ScanKit：配对码 / myapp://remote-link|remote-login 二维码）
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
}
