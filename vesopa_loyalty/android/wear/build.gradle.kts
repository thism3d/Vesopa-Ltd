import java.util.Properties

/*
 * THE WEAR OS APP: the card, the points, the membership and the news on the
 * wrist, the Android twin of ios/VesopaWatch. Plain Kotlin and Compose for
 * Wear OS, not Flutter: a watch has a second to show a code at a till, and an
 * engine start is most of that second.
 *
 * It is a second app under THE PHONE APP'S OWN applicationId. That is what
 * makes it one product: Play lists it on the Wear OS form factor of the same
 * listing, and the Wearable Data Layer only joins apps with the same package
 * name and the same signing key, so the phone's WearBridge.kt reaches it and
 * nothing else does. tool/make_venue_app.py changes the id below with the
 * phone's; keep the two the same string.
 */
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

// The same upload key as the phone app (app/build.gradle.kts explains it):
// Play refuses a Wear bundle signed by another key, and so does the Data Layer.
val keyProperties = Properties().apply {
    val f = rootProject.file("key.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

/*
 * The phone app's version, read from pubspec.yaml so there is one number to
 * raise. The build number goes up by a million: Play wants every bundle of a
 * listing to have its own versionCode, and the phone's builds will not reach a
 * million.
 */
val pubspecVersion: List<String> = rootProject.file("../pubspec.yaml").readLines()
    .first { it.startsWith("version:") }
    .substringAfter(":").trim().split("+")

android {
    namespace = "uk.co.vesopa.vesopa_loyalty.wear"
    compileSdk = 36

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "com.vesopaepos.thevesopakitchen"
        // Wear OS 3, the first with the Play Store on the watch and the
        // oldest Google still takes new apps for.
        minSdk = 30
        targetSdk = 36
        versionCode = 1_000_000 + (pubspecVersion.getOrNull(1)?.toIntOrNull() ?: 1)
        versionName = pubspecVersion[0]
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
            if (!keyProperties.isEmpty) signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures {
        compose = true
    }

    // The screenshots for Play are drawn from these screens on the JVM
    // (src/test/.../StoreScreenshots.kt), so they cannot drift from the app.
    testOptions {
        unitTests.isIncludeAndroidResources = true
        unitTests.all {
            it.systemProperty("roborazzi.test.record", "true")
            // Where the pictures go: the venue's store folder when the venue
            // build asks for them, else this module's build folder.
            it.systemProperty(
                "wear.screenshots",
                System.getenv("WEAR_SCREENSHOTS") ?: layout.buildDirectory.dir("screenshots").get().asFile.path,
            )
            System.getenv("ROBOLECTRIC_REPO")?.let { repo -> it.systemProperty("robolectric.dependency.repo.url", repo) }
        }
    }
}

// A release without the upload key stops with a message rather than producing
// a bundle Play refuses, as the phone app's does.
tasks.matching { it.name == "bundleRelease" || it.name == "assembleRelease" }.configureEach {
    doFirst {
        if (keyProperties.isEmpty) {
            throw GradleException(
                "android/key.properties is missing: a release must be signed with the " +
                    "Vesopa upload key (see .env.claude-tools, ANDROID_UPLOAD_KEYSTORE)."
            )
        }
    }
}

/*
 * The launcher icon is the phone app's, copied at build time: the venue
 * overlay and tool/make_app_icons.py already write it there, and a watch's
 * round mask suits the same adaptive icon.
 */
val phoneIconsDir: File = layout.buildDirectory.dir("generated/phoneIcons").get().asFile
val phoneIcons = tasks.register<Sync>("phoneIcons") {
    from(rootProject.file("app/src/main/res")) { include("mipmap-*/**") }
    into(phoneIconsDir)
}
android.sourceSets["main"].res.srcDir(phoneIconsDir)
tasks.named("preBuild") { dependsOn(phoneIcons) }

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.06.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.wear.compose:compose-foundation:1.6.2")
    implementation("androidx.wear.compose:compose-material3:1.6.2")
    // The card arrives from the phone over the Wearable Data Layer.
    implementation("com.google.android.gms:play-services-wearable:20.0.1")
    // Drawing the QR code on the watch itself.
    implementation("com.google.zxing:core:3.5.4")
    // The "show my card" Tile and the points complication.
    implementation("androidx.wear.tiles:tiles:1.6.2")
    implementation("androidx.wear.protolayout:protolayout:1.4.2")
    implementation("androidx.wear.watchface:watchface-complications-data-source:1.3.0")
    implementation("androidx.concurrent:concurrent-futures:1.2.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.17")
    testImplementation("io.github.takahirom.roborazzi:roborazzi-compose:1.76.0")
}
