import java.util.Properties

plugins {
    id("com.android.application")
    // Turns google-services.json into the resources Firebase Messaging reads
    // at start-up. Without the file in android/app/ the build FAILS rather
    // than degrading, which is why the plugin was not applied until there was
    // a Firebase project to point it at (2026-09-14).
    id("com.google.gms.google-services")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

/*
 * THE UPLOAD KEY, from android/key.properties (gitignored; the keystore itself
 * lives outside the repository in Documents\Vesopa-Keys, recorded in
 * .env.claude-tools). One key, held by Vesopa Spare Ltd, signs every Vesopa
 * Android app: Play keeps its own signing key per app and only ever sees this
 * one as the upload identity, so sharing it between apps costs nothing and
 * means one file to keep safe rather than one per venue.
 *
 * A release with no key.properties stops here with a message, rather than
 * quietly signing with the debug key and producing a bundle Play refuses.
 */
val keyProperties = Properties().apply {
    val f = rootProject.file("key.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    // The code's own package (R class, MainActivity's Kotlin package). This is
    // NOT the identity the phone or Play know the app by -- that is
    // applicationId below -- so it stays the same across every venue's build.
    namespace = "uk.co.vesopa.vesopa_loyalty"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        /*
         * THIS BUILD IS THE VESOPA KITCHEN, the demonstration venue, and this
         * is the one line that makes it so on Android. Each venue's app is its
         * own Play listing under its own package name; to build another
         * venue's, change this, drop in that venue's google-services.json
         * (Firebase binds the file to the package name), set its label in
         * AndroidManifest.xml and rerun tool/make_app_icons.py with its mark.
         * The Dart side takes the venue from --dart-define=LOYALTY_SLUG.
         */
        applicationId = "com.vesopaepos.thevesopakitchen"
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        create("release") {
            if (keyProperties.isEmpty) return@create
            keyAlias = keyProperties.getProperty("keyAlias")
            keyPassword = keyProperties.getProperty("keyPassword")
            storeFile = file(keyProperties.getProperty("storeFile"))
            storePassword = keyProperties.getProperty("storePassword")
        }
    }

    buildTypes {
        release {
            if (keyProperties.isEmpty) {
                throw GradleException(
                    "android/key.properties is missing: a release must be signed with the " +
                        "Vesopa upload key (see .env.claude-tools, ANDROID_UPLOAD_KEYSTORE)."
                )
            }
            signingConfig = signingConfigs.getByName("release")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

dependencies {
    // Firebase is here only as the delivery pipe for notifications: Android
    // has no other way to wake an app that is not running. The BoM pins every
    // Firebase artefact to versions known to work together.
    implementation(platform("com.google.firebase:firebase-bom:34.3.0"))
    implementation("com.google.firebase:firebase-messaging")
}

flutter {
    source = "../.."
}
