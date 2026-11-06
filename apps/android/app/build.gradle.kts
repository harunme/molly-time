import java.security.MessageDigest
import java.io.File
import java.util.Properties
import java.time.Duration

plugins { id("com.android.application"); kotlin("android"); id("org.jetbrains.kotlin.plugin.compose") }
val clientVersion = Properties().apply { file("version.properties").inputStream().use { load(it) } }
// Signing material stays outside versioned source. An override also supports CI.
val releaseSigningFile = providers.environmentVariable("MOLLYTIME_SIGNING_PROPERTIES")
    .map { rootProject.file(it) }
    .getOrElse(rootProject.file("../../.local/signing/release.properties"))
val releaseSigning = Properties().apply {
    if (releaseSigningFile.isFile) releaseSigningFile.inputStream().use { load(it) }
}
val releaseKeyStore = releaseSigning.getProperty("storeFile")?.takeIf { it.isNotBlank() }
    ?.let { path ->
        File(path).let { if (it.isAbsolute) it else releaseSigningFile.parentFile.resolve(path) }
    }
val signingFields = listOf("storeFile", "storePassword", "keyAlias", "keyPassword")
val hasReleaseSigning = signingFields.all { !releaseSigning.getProperty(it).isNullOrBlank() }
val validateReleaseSigning = tasks.register("validateReleaseSigning") {
    doLast {
        check(releaseSigningFile.isFile) {
            "Missing release signing properties. See client/README.md: release signing."
        }
        check(hasReleaseSigning) { "Release signing requires: ${signingFields.joinToString()}." }
        check(releaseKeyStore?.isFile == true) { "Release signing keystore does not exist." }
    }
}

android {
    namespace = "com.molly.parent"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.molly.parent"
        minSdk = 26
        targetSdk = 36
        versionCode = providers.gradleProperty("mollyVersionCode").getOrElse(clientVersion.getProperty("versionCode")).toInt()
        require(versionCode in 1..2100000000)
        versionName = providers.gradleProperty("mollyVersionName").getOrElse(clientVersion.getProperty("versionName"))
    }
    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = releaseKeyStore
                storePassword = releaseSigning.getProperty("storePassword")
                keyAlias = releaseSigning.getProperty("keyAlias")
                keyPassword = releaseSigning.getProperty("keyPassword")
            }
        }
    }
    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
        }
        release {
            if (hasReleaseSigning) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    sourceSets.getByName("main").assets.srcDir(layout.buildDirectory.dir("generated/startupSoundAssets"))
    androidResources { noCompress += "mp3" }
    buildFeatures { compose = true; buildConfig = true }
    testOptions { unitTests.isIncludeAndroidResources = true }
}
kotlin { jvmToolchain(21) }
tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinJvmCompile>().configureEach {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}
dependencies {
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.4")
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.4")
    implementation("androidx.compose.ui:ui:1.9.4")
    implementation("androidx.compose.foundation:foundation:1.9.4")
    implementation("androidx.compose.material3:material3:1.4.0")
    implementation("androidx.compose.material:material-icons-extended:1.7.8")
    debugImplementation("androidx.compose.ui:ui-test-manifest:1.9.4")
    testImplementation("androidx.compose.ui:ui-test-junit4:1.9.4")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("androidx.media3:media3-exoplayer:1.8.0")
    implementation("androidx.media3:media3-exoplayer-hls:1.8.0")
    implementation("androidx.media3:media3-datasource-okhttp:1.8.0")
    implementation("androidx.media3:media3-ui:1.8.0")
    implementation("androidx.media3:media3-transformer:1.8.0")
    implementation("androidx.exifinterface:exifinterface:1.4.1")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.16.1")
}

val validateStartupAssets = tasks.register("validateStartupAssets") {
    doLast {
        val directory = layout.buildDirectory.dir("generated/startupSoundAssets/startup").get().asFile
        val manifest = directory.resolve("config.json")
        check(manifest.isFile) { "Startup assets missing; run tools/build-android.sh" }
        val config = groovy.json.JsonSlurper().parse(manifest) as Map<*, *>
        check(config["configured"] is Boolean) { "Invalid startup sound manifest" }
        if (config["configured"] == true) {
            val audio = directory.resolve("sound.mp3")
            check(audio.isFile && audio.length() in 1L..131072L) { "Invalid startup audio" }
            check(MessageDigest.getInstance("SHA-256").digest(audio.readBytes()).joinToString("") { "%02x".format(it) } == config["version"]) { "Startup audio checksum mismatch" }
        }
    }
}
tasks.named("preBuild").configure { dependsOn(validateStartupAssets) }

tasks.configureEach {
    if(name=="preReleaseBuild"||name=="validateSigningRelease")dependsOn(validateReleaseSigning)
}

// Robolectric downloads its Android runtimes separately from Gradle dependencies.
// Use the canonical Central host and bound CI waits; never leave a test task silent.
tasks.withType<org.gradle.api.tasks.testing.Test>().configureEach {
    systemProperty("robolectric.dependency.repo.url", "https://repo.maven.apache.org/maven2")
    timeout.set(Duration.ofMinutes(8))
    testLogging {
        events("started", "passed", "skipped", "failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
