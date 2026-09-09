package app.floatphone.shell.reality.domain.validation

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class SupabaseKeyClassifierTest {
    @Test
    fun `recognizes legacy service role JWT without plaintext role`() {
        val token = "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0." +
            "eyJyb2xlIjoic2VydmljZV9yb2xlIiwicmVmIjoiYnJpZGdlLXByb2plY3QiLCJpc3MiOiJzdXBhYmFzZSJ9." +
            "test-signature"

        assertFalse(token.contains("service_role"))
        assertTrue(SupabaseKeyClassifier.isElevatedKey(token))

        val urlSafeToken = "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0." +
            "eyJyb2xlIjoic2VydmljZV9yb2xlIiwic2NvcGUiOiJ-Xz8ifQ." +
            "test-signature"
        assertTrue(SupabaseKeyClassifier.isElevatedKey(urlSafeToken))
    }

    @Test
    fun `recognizes current secret key and allows public shapes`() {
        assertTrue(SupabaseKeyClassifier.isElevatedKey("sb_secret_live_key_shape"))
        assertFalse(SupabaseKeyClassifier.isElevatedKey("sb_publishable_live_key_shape"))
        assertFalse(SupabaseKeyClassifier.isElevatedKey("opaque-service_role-like-value"))
        assertFalse(
            SupabaseKeyClassifier.isElevatedKey(
                "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0." +
                    "eyJyb2xlIjoiYXV0aGVudGljYXRlZCIsInJlZiI6ImJyaWRnZS1wcm9qZWN0In0." +
                    "test-signature",
            ),
        )
    }
}
