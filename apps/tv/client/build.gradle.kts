plugins {
    id("com.android.application")
    kotlin("android")
}
android {
    namespace = "com.molly.tv"
    compileSdk = 36
    defaultConfig {
        applicationId = "com.molly.tv"
        minSdk = 23
        targetSdk = 36
        versionCode = 2
        versionName = "0.3.0"
    }
    buildFeatures { buildConfig = true }
    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            manifestPlaceholders["cleartext"] = "true"
        }
        release { manifestPlaceholders["cleartext"] = "false" }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
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
    implementation(libs.androidx.media3.datasource.okhttp)
    implementation(libs.androidx.media3.ui)
    implementation(libs.okhttp)
    testImplementation("junit:junit:4.13.2")
}
