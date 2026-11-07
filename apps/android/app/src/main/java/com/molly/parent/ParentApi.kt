package com.molly.parent

import java.io.IOException
import java.util.concurrent.TimeUnit
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

class ApiFailure(val status: Int, message: String) : IOException(message)

/** All credential-bearing requests stay at a validated HTTPS origin; redirects are rejected. */
class Endpoint(value: String) {
    val origin: HttpUrl =
        value.trim().toHttpUrl().also {
            require(
                it.isHttps &&
                    it.username.isEmpty() &&
                    it.password.isEmpty() &&
                    it.encodedPath == "/" &&
                    it.query == null &&
                    it.fragment == null
            ) {
                "请输入完整的 HTTPS 服务地址"
            }
        }

    fun sameOrigin(url: HttpUrl) =
        url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port

    fun resolve(value: String): HttpUrl =
        requireNotNull(origin.resolve(value)).also {
            require(
                it.isHttps && it.username.isEmpty() && it.password.isEmpty() && it.fragment == null
            ) {
                "服务返回了不安全的地址"
            }
        }

    fun api(path: String): HttpUrl =
        resolve(path).also {
            require(sameOrigin(it) && it.encodedPath.startsWith("/api/")) { "服务地址不受信任" }
        }

    fun pairingCode(value: String): String? {
        val input = value.trim()
        if (input.matches(Regex("[0-9]{4}"))) return input
        val url = runCatching { input.toHttpUrl() }.getOrNull() ?: return null
        if (
            !sameOrigin(url) ||
                url.username.isNotEmpty() ||
                url.password.isNotEmpty() ||
                url.fragment != null ||
                url.encodedPath !in listOf("/manage", "/manage/")
        )
            return null
        return url.queryParameter("pair")?.takeIf { it.matches(Regex("[0-9]{4}")) }
    }
}

class ParentApi(
    val endpoint: Endpoint,
    initialCookie: String = "",
    private val saveCookie: (String) -> Unit = {},
    transport: OkHttpClient? = null,
) {
    @Volatile
    var cookie: String = initialCookie
        private set

    @Volatile var csrf = ""
    var diskRoot: java.io.File? = null
    var accountScope = endpoint.origin.toString()
    var onUnauthorized: (() -> Unit)? = null
    var onMutation: ((ParentInvalidation) -> Unit)? = null
    var onDiagnostic: ((Throwable, String) -> Unit)? = null
    var onBreadcrumb: ((String) -> Unit)? = null
    val artwork by lazy { ArtworkStore(this) }
    val artworkUploads by lazy { ArtworkUploadQueue(this) }
    val anonymous =
        (transport?.newBuilder() ?: com.molly.network.MollyHttp.newBuilder())
            .followRedirects(false)
            .followSslRedirects(false)
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .build()
    // Also used by images and Media3. Each request is evaluated separately, never default Cookie
    // headers.
    val mediaClient =
        anonymous
            .newBuilder()
            .addInterceptor { chain ->
                val request =
                    chain
                        .request()
                        .newBuilder()
                        .removeHeader("Cookie")
                        .removeHeader("Authorization")
                        .removeHeader("X-CSRF-Token")
                if (endpoint.sameOrigin(chain.request().url) && cookie.isNotEmpty())
                    request.header("Cookie", "molly_parent=$cookie")
                chain.proceed(request.build())
            }
            .build()

    fun request(path: String, method: String = "GET", body: JSONObject? = null): JSONObject =
        raw(
                path,
                method,
                if (method == "GET" || method == "HEAD") null
                else (body ?: JSONObject()).toString().toByteArray(),
                "application/json",
            )
            .let { if (it.isEmpty()) JSONObject() else JSONObject(it.toString(Charsets.UTF_8)) }

    fun raw(
        path: String,
        method: String,
        bytes: ByteArray?,
        mime: String,
        headers: Map<String, String> = emptyMap(),
    ): ByteArray {
        val builder =
            Request.Builder()
                .url(endpoint.api(path))
                .header("Accept", "application/json")
                .header("User-Agent", "MollyTime-Android/0.1")
        if (cookie.isNotEmpty()) builder.header("Cookie", "molly_parent=$cookie")
        if (method !in listOf("GET", "HEAD") && csrf.isNotEmpty())
            builder.header("X-CSRF-Token", csrf)
        headers.forEach { (key, value) -> builder.header(key, value) }
        builder.method(method, bytes?.toRequestBody(mime.toMediaType()))
        anonymous.newCall(builder.build()).execute().use { response ->
            val data = response.body?.bytes() ?: byteArrayOf()
            if (!response.isSuccessful) {
                if (response.code == 401) onUnauthorized?.invoke()
                val detail =
                    runCatching { JSONObject(data.toString(Charsets.UTF_8)).optString("detail") }
                        .getOrDefault("")
                throw ApiFailure(
                    response.code,
                    detail.ifEmpty {
                        if (response.code == 401) "登录已过期，请重新登录" else "请求未完成（${response.code}），请重试"
                    },
                )
            }
            Cookie.parseAll(response.request.url, response.headers)
                .firstOrNull { it.name == "molly_parent" }
                ?.let {
                    cookie = it.value
                    saveCookie(it.value)
                }
            if (response.code != 202)
                onMutation?.invoke(ParentInvalidation.forRequest(path.substringBefore('?'), method))
            return data
        }
    }

    fun login(username: String, password: String) =
        request(
                "/api/manage/auth/login",
                "POST",
                json("username" to username, "password" to password),
            )
            .also { csrf = it.getString("csrfToken") }

    fun restore() = request("/api/manage/auth/session").also { csrf = it.getString("csrfToken") }

    fun resources(folder: String?, page: Int, search: String = ""): JSONObject {
        val url =
            endpoint
                .api("/api/manage/resources")
                .newBuilder()
                .addQueryParameter("page", "$page")
                .addQueryParameter("pageSize", "30")
                .addQueryParameter("sort", "manual")
        if (folder != null) url.addQueryParameter("parentId", folder)
        if (search.isNotBlank()) url.addQueryParameter("q", search.take(256))
        return request(url.build().toString())
    }

    companion object {
        fun segment(value: String): String =
            HttpUrl.Builder()
                .scheme("https")
                .host("local.invalid")
                .addPathSegment(value)
                .build()
                .encodedPath
                .drop(1)
    }
}

fun json(vararg pairs: Pair<String, Any?>) =
    JSONObject().apply { pairs.forEach { (key, value) -> put(key, value ?: JSONObject.NULL) } }

fun org.json.JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }
