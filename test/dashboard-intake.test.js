import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAzureDevOpsLoader,
  MAX_SCREENSHOT_BYTES,
  MAX_SCREENSHOT_TOTAL_BYTES,
  MAX_SCREENSHOTS,
  parseAzureDevOpsWorkItem,
  removeArtifactDirectory,
  sanitizeAzureDevOpsHtml,
  storeScreenshots
} from "../dashboard/intake.js";

const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
]);

function screenshot(overrides = {}) {
  return {
    name: "evidence.png",
    mimeType: "image/png",
    base64: png.toString("base64"),
    ...overrides
  };
}

test("parses Azure DevOps URL and ID profile fallback", () => {
  assert.deepEqual(
    parseAzureDevOpsWorkItem(
      "https://dev.azure.com/example-org/Example%20Project/_workitems/edit/123"
    ),
    {
      organization: "example-org",
      project: "Example Project",
      id: 123
    }
  );
  assert.deepEqual(
    parseAzureDevOpsWorkItem("456", {
      azureDevOps: {
        organization: "profile-org",
        project: "Profile Project"
      }
    }),
    {
      organization: "profile-org",
      project: "Profile Project",
      id: 456
    }
  );
  assert.throws(
    () => parseAzureDevOpsWorkItem("456", {}),
    /azureDevOps\.organization/
  );
  assert.throws(
    () => parseAzureDevOpsWorkItem("https://example.com/item/1"),
    /dev\.azure\.com/
  );
});

test("sanitizes Azure DevOps HTML into readable text", () => {
  const result = sanitizeAzureDevOpsHtml(
    "<p>First &amp; second</p><ul><li>Step &#49;</li></ul><script>bad()</script>"
  );

  assert.equal(result, "First & second\n- Step 1");
});

test("Azure DevOps loader returns safe fields without exposing tokens", async () => {
  const token = "sensitive-access-token";
  let authorizationToken;
  const loader = createAzureDevOpsLoader({
    tokenProvider: () => token,
    requestJson: async (url, suppliedToken) => {
      authorizationToken = suppliedToken;
      assert.match(url, /profile-org\/Profile%20Project/);
      return {
        id: 42,
        fields: {
          "System.Id": 42,
          "System.Title": "<b>Broken save</b>",
          "System.Description": "<p>Save &amp; continue fails.</p>",
          "Microsoft.VSTS.TCM.ReproSteps": "<ol><li>Open</li></ol>",
          "Microsoft.VSTS.Common.AcceptanceCriteria": "<p>Save succeeds.</p>",
          "System.State": "Active",
          "System.WorkItemType": "Bug"
        },
        _links: {
          html: {
            href: "https://dev.azure.com/profile-org/Profile%20Project/_workitems/edit/42"
          }
        }
      };
    }
  });

  const item = await loader({
    workItem: "42",
    profile: {
      azureDevOps: {
        organization: "profile-org",
        project: "Profile Project"
      }
    }
  });

  assert.equal(authorizationToken, token);
  assert.equal(item.title, "Broken save");
  assert.equal(item.description, "Save & continue fails.");
  assert.equal(item.reproduction, "- Open");
  assert.equal(item.acceptanceCriteria, "Save succeeds.");

  const failingLoader = createAzureDevOpsLoader({
    tokenProvider: () => token,
    requestJson: async () => {
      throw new Error(`request failed with Bearer ${token}`);
    }
  });
  await assert.rejects(
    failingLoader({
      workItem: "42",
      profile: {
        azureDevOps: {
          organization: "profile-org",
          project: "Profile Project"
        }
      }
    }),
    (error) => {
      assert.doesNotMatch(error.message, new RegExp(token));
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    }
  );
});

test("stores generated screenshot files and rejects unsafe uploads", () => {
  const repository = mkdtempSync(join(tmpdir(), "fixlab-artifacts-"));
  let stored;

  try {
    stored = storeScreenshots({
      repository,
      jobId: "1234567890123-abcdef",
      screenshots: [screenshot()]
    });
    assert.equal(stored.files.length, 1);
    assert.equal(stored.files[0].name, "evidence.png");
    assert.equal(existsSync(stored.files[0].path), true);
    assert.doesNotMatch(stored.files[0].path, /evidence\.png$/);

    assert.throws(
      () =>
        storeScreenshots({
          repository,
          jobId: "1234567890124-abcdef",
          screenshots: [screenshot({ name: "..\\secret.png" })]
        }),
      /paths or traversal/
    );
    assert.throws(
      () =>
        storeScreenshots({
          repository,
          jobId: "1234567890125-abcdef",
          screenshots: [screenshot({ mimeType: "text/plain" })]
        }),
      /PNG, JPEG, or WebP/
    );
    assert.throws(
      () =>
        storeScreenshots({
          repository,
          jobId: "1234567890126-abcdef",
          screenshots: [screenshot({ base64: "not base64!" })]
        }),
      /valid base64/
    );
    assert.throws(
      () =>
        storeScreenshots({
          repository,
          jobId: "1234567890127-abcdef",
          screenshots: [screenshot({ base64: Buffer.from("fake").toString("base64") })]
        }),
      /does not match/
    );
    assert.throws(
      () =>
        storeScreenshots({
          repository,
          jobId: "1234567890128-abcdef",
          screenshots: Array.from(
            { length: MAX_SCREENSHOTS + 1 },
            () => screenshot()
          )
        }),
      /at most/
    );
    const oversized = Buffer.concat([
      png,
      Buffer.alloc(MAX_SCREENSHOT_BYTES - png.length + 1)
    ]);
    assert.throws(
      () =>
        storeScreenshots({
          repository,
          jobId: "1234567890129-abcdef",
          screenshots: [
            screenshot({ base64: oversized.toString("base64") })
          ]
        }),
      /at most/
    );
    const totalChunk = Buffer.concat([
      png,
      Buffer.alloc(Math.floor(MAX_SCREENSHOT_TOTAL_BYTES / 5) - png.length + 1)
    ]);
    assert.throws(
      () =>
        storeScreenshots({
          repository,
          jobId: "1234567890130-abcdef",
          screenshots: Array.from({ length: 5 }, (_, index) =>
            screenshot({
              name: `evidence-${index}.png`,
              base64: totalChunk.toString("base64")
            })
          )
        }),
      /total at most/
    );
  } finally {
    removeArtifactDirectory(stored?.directory);
    rmSync(repository, { recursive: true, force: true });
  }
});
