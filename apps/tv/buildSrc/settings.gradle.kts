// buildSrc is a separate build: root plugin repositories do not apply here.
pluginManagement {
	repositories {
		maven("https://maven-central.storage-download.googleapis.com/maven2/")
		mavenCentral()
		gradlePluginPortal()
	}
}

dependencyResolutionManagement {
	versionCatalogs {
		create("libs") {
			from(files("../gradle/libs.versions.toml"))
		}
	}
}
