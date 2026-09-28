import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	// Медленные ответы модели в тестах ждут INLINE_WAIT_MS (2,5 с) на каждый запрос.
	test: { testTimeout: 15000 },
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
		}),
	],
});
