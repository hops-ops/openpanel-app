import { defineConfig } from 'vitest/config';

// @openpanel/auth is a pure-Go-with-no-IO-fixtures package: its tests
// (cookie domain parsing, AES-GCM round-trips, etc.) don't need
// Postgres or ClickHouse. Override the root vitest config so we don't
// pay the global Docker-fixtures setup.
export default defineConfig({
  test: {
    globalSetup: [],
  },
});
