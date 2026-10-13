package com.molly.tv

object UpdatePolicy {
    const val MAX_APK_BYTES = 512L * 1024 * 1024
    fun validate(packageName: String, versionCode: Long, minSdk: Int, size: Long, sha256: String,
                 installedPackage: String, installedVersion: Long, sdk: Int) {
        require(packageName == installedPackage) { "更新包不属于当前客户端" }
        require(versionCode > installedVersion && versionCode <= 2100000000) { "更新版本无效" }
        require(minSdk in 23..sdk) { "电视系统版本不支持这个更新" }
        require(size in 1..MAX_APK_BYTES) { "更新包大小无效" }
        require(Regex("[a-f0-9]{64}").matches(sha256)) { "更新包校验信息无效" }
    }
}
