# Personal cloud push

The Android shell reads the already-bound personal Supabase configuration from the WebView IndexedDB, stores it in the app-private preferences, registers a `shell:owner` subscription through the personal `ai-phone-push` gateway, and keeps a native Supabase Realtime connection alive for offline notifications.
