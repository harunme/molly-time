package com.molly.parent

/** Exact iOS invalidation rules. Scheduling and all side effects stay in ordinary code. */
data class ParentInvalidation(val library: Boolean = false, val storage: Boolean = false, val devices: Boolean = false) {
    companion object {
        fun forRequest(path: String, method: String): ParentInvalidation {
            if (method in listOf("GET", "HEAD")) return ParentInvalidation()
            val resources = path == "/api/manage/resources" || path.startsWith("/api/manage/resources/")
            val trash = path.startsWith("/api/manage/trash/")
            val shares = path == "/api/manage/shares" || path.startsWith("/api/manage/shares/")
            val uploadStorage = path == "/api/manage/uploads" || (path.startsWith("/api/manage/uploads/") && (path.endsWith("/complete") || path.endsWith("/cancel")))
            val devices = path.startsWith("/api/manage/devices/") || path.startsWith("/api/manage/watch-control/") || path == "/api/manage/pairing/confirm" || path.startsWith("/api/manage/reminders/")
            return ParentInvalidation(resources || trash || shares, resources || trash || shares || uploadStorage || path == "/api/manage/settings", devices)
        }
    }
}
