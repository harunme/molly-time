plugins {
	`kotlin-dsl`
}

kotlin {
	jvmToolchain {
		languageVersion.set(JavaLanguageVersion.of(libs.versions.java.jdk.get()))
	}
}

repositories {
	maven("https://maven-central.storage-download.googleapis.com/maven2/")
	mavenCentral()
}
