import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  auth: true,
  preview: {
    // Upgrade to a paid plan to enable AI Gateway for this project.
    // aiGateway: true,
    buckets: {
      quietwatcher: { access: "public_read" },
    },
    functions: {
      api: { name: "api", source: "./hello.ts" },
    },
  },
});
