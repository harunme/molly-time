import java.io.File
import java.util.Properties

plugins {
    id("com.android.application")
    kotlin("android")
}

val clientVersion = Properties().apply {
    file("version.properties").inputStream().use { load(it) }
}
val prepareTvWebAssets = tasks.register<Sync>("prepareTvWebAssets") {
    doFirst {
        check(file("../web/dist/index.html").isFile && file("../web/dist/web-release.json").isFile) {
            "TV Web assets are missing; run tools/build-tv-web.sh before building the client"
        }
    }
    from("../web/dist")
    exclude("web-bundle.zip")
    into(layout.buildDirectory.dir("generated/tvWebAssets"))
}

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
    namespace = "com.molly.tv"
    compileSdk = 36
    defaultConfig {
        // Keep the installed app identity so MollyTime upgrades retain local state.
        applicationId = "com.molly.tv"
        minSdk = 23
        targetSdk = 36
        versionCode = providers.gradleProperty("mollyVersionCode")
            .getOrElse(clientVersion.getProperty("versionCode")).toInt()
        require(versionCode in 1..2100000000) { "Invalid Android versionCode" }
        versionName = providers.gradleProperty("mollyVersionName")
            .getOrElse(clientVersion.getProperty("versionName"))
    }
    buildFeatures { buildConfig = true }
    sourceSets.getByName("main").assets.srcDir(prepareTvWebAssets.map { it.destinationDir })
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
            manifestPlaceholders["cleartext"] = "true"
        }
        release {
            manifestPlaceholders["cleartext"] = "false"
            if (hasReleaseSigning) signingConfig = signingConfigs.getByName("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
tasks.named("preBuild").configure { dependsOn(prepareTvWebAssets) }
// Never silently produce an unsigned release when signing material is absent.
tasks.configureEach {
    if (name == "preReleaseBuild" || name == "validateSigningRelease") {
        dependsOn(validateReleaseSigning)
    }
}
kotlin { jvmToolchain(21) }
tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinJvmCompile>().configureEach {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}
dependencies {
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.activity)
    implementation(libs.androidx.core)
    implementation("androidx.webkit:webkit:1.14.0")
    implementation(libs.androidx.media3.exoplayer)
    implementation("androidx.media3:media3-database:1.8.0")
    implementation(libs.androidx.media3.datasource.okhttp)
    implementation(libs.androidx.media3.ui)
    implementation(libs.okhttp)
    testImplementation("junit:junit:4.13.2")
}
