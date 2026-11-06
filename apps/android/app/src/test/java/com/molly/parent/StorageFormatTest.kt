package com.molly.parent

import java.io.File
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Test

class StorageFormatTest {
    @Test
    fun matchesSharedWebAndIOSContractRegardlessOfLocale() {
        val fixture = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .map { File(it, "tools/fixtures/storage-byte-format.tsv") }
            .first { it.isFile }
        val previous = Locale.getDefault()
        try {
            Locale.setDefault(Locale.FRANCE)
            fixture.readLines().drop(1).filter { it.isNotBlank() }.forEach { row ->
                val (bytes, expected) = row.split('\t')
                assertEquals("$bytes bytes", expected, storageBytes(bytes.toLong()))
            }
        } finally {
            Locale.setDefault(previous)
        }
    }
}
