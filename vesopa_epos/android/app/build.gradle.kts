plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "com.vesopaepos.app"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "com.vesopaepos.app"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    buildTypes {
        release {
            // TODO: Add your own signing config for the release build.
            // Signing with the debug keys for now, so `flutter run --release` works.
            signingConfig = signingConfigs.getByName("debug")
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }
}

flutter {
    source = "../.."
}

// ---- Dojo card-payment SDK -------------------------------------------------
//
// Dojo's Android SDK lives in a credentialed Cardinal Commerce Maven repo, and
// the credentials are issued by Dojo to onboarded partners. To keep the app
// building for anyone without those credentials, the dependency is applied only
// when `dojo.sdk.enabled=true` is set (see android/gradle.properties) AND the
// Cardinal repo credentials are provided. Without them the Kotlin payment
// handler compiles against a stub and the app falls back to the REST provider.
val dojoEnabled = (project.findProperty("dojo.sdk.enabled") as String?) == "true"

dependencies {
    if (dojoEnabled) {
        // The Dojo SDK is on Maven Central. Its 3-D Secure dependency
        // (org.jfrog.cardinalcommerce:cardinalmobilesdk) lives ONLY in a
        // credentialed Cardinal repo, so it is excluded here — the native
        // drop-in then compiles and runs from public artifacts alone. Card
        // entry works (sandbox and non-3DS live); a 3-D Secure *challenge* needs
        // the Cardinal library, so add the credentials (see build.gradle.kts at
        // android root) and drop these excludes to enable full 3DS.
        implementation("tech.dojo.pay:sdk:1.6.2") {
            exclude(group = "org.jfrog.cardinalcommerce.gradle", module = "cardinalmobilesdk")
        }
        implementation("tech.dojo.pay:uisdk:1.3.5") {
            exclude(group = "org.jfrog.cardinalcommerce.gradle", module = "cardinalmobilesdk")
        }
    }
}
