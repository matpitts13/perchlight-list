import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(root, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            SITE_URL: "https://list.test",
            MAIL_FROM: "Test List <hello@list.test>",
            LIST_NAME: "the Test list",
            MAIL_POSTAL_ADDRESS: "1 Test Street, Testville",
            RESEND_API_KEY: "re_test_key",
            // The Svix documentation's example secret, so signatures can be
            // checked against their published example.
            RESEND_WEBHOOK_SECRET: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
            IP_SALT: "test-salt",
            // No pacing delays in tests.
            REQUESTS_PER_SECOND: "100000",
            MAILGUN_WEBHOOK_SIGNING_KEY: "mailgun-test-signing-key",
            POSTMARK_WEBHOOK_USER: "pm-user",
            POSTMARK_WEBHOOK_PASSWORD: "pm-pass",
            SES_SNS_TOPIC_ARN: "arn:aws:sns:us-east-1:123456789012:perchlight-ses",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.js"],
    },
  };
});
