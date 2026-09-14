import { expect, test } from "@playwright/test";

const healthUrl =
  process.env.FIXLAB_EXAMPLE_HEALTH_URL ?? "http://127.0.0.1:3000/health";

test("configured application health endpoint is ready", async ({ request }) => {
  const response = await request.get(healthUrl);

  expect(response.ok()).toBeTruthy();
});
