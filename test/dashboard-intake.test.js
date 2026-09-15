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
      if (url.includes("/comments?")) {
        return {
          comments: [
            {
              createdBy: { displayName: "<b>Reviewer</b>" },
              createdDate: "2026-03-09T10:00:00Z",
              text: "<p>Newest &amp; useful</p>"
            },
            {
              isDeleted: true,
              createdBy: { displayName: "Deleted" },
              text: "Do not include"
            }
          ]
        };
      }
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
  assert.deepEqual(item.comments, [
    {
      author: "Reviewer",
      createdAt: "2026-03-09T10:00:00Z",
      text: "Newest & useful"
    }
  ]);
  assert.equal(item.commentsWarning, "");

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

test("Azure DevOps batch loader authenticates once and loads unique bugs concurrently", async () => {
  let tokenCalls = 0;
  const requestedUrls = [];
  const loader = createAzureDevOpsLoader({
    tokenProvider: () => {
      tokenCalls += 1;
      return "batch-token";
    },
    requestJson: async (url) => {
      const id = Number(url.match(/workitems\/(\d+)/i)?.[1]);
      requestedUrls.push(url);
      if (url.includes("/comments?")) {
        return { comments: [] };
      }
      return {
        id,
        fields: {
          "System.Id": id,
          "System.Title": `Bug ${id}`,
          "System.State": "Active",
          "System.WorkItemType": "Bug"
        }
      };
    }
  });

  const workItems = await loader.loadMany({
    workItems: ["101", "202", "303"],
    profile: {
      azureDevOps: {
        organization: "profile-org",
        project: "Profile Project"
      }
    }
  });

  assert.equal(tokenCalls, 1);
  assert.equal(requestedUrls.length, 6);
  assert.deepEqual(
    requestedUrls
      .map((url) => Number(url.match(/workitems\/(\d+)/i)?.[1]))
      .filter((id, index, values) => values.indexOf(id) === index)
      .sort((left, right) => left - right),
    [
    101,
    202,
    303
    ]
  );
  assert.deepEqual(
    workItems.map((item) => item.title),
    ["Bug 101", "Bug 202", "Bug 303"]
  );
});

test("Azure DevOps loader bounds comments and reports comment-only failures", async () => {
  const comments = Array.from({ length: 25 }, (_, index) => ({
    createdBy: { displayName: `Author ${index}` },
    createdDate: `2026-03-09T10:${String(index).padStart(2, "0")}:00Z`,
    text: `<p>${"x".repeat(2100)} ${index}</p>`
  }));
  const loader = createAzureDevOpsLoader({
    tokenProvider: () => "comment-token",
    requestJson: async (url, token) => {
      assert.equal(token, "comment-token");
      if (url.includes("/comments?")) {
        return { comments };
      }
      return {
        id: 91,
        fields: {
          "System.Id": 91,
          "System.Title": "Commented bug"
        }
      };
    }
  });
  const profile = {
    azureDevOps: {
      organization: "profile-org",
      project: "Profile Project"
    }
  };
  const item = await loader({ workItem: "91", profile });
  assert.equal(item.comments.length, 20);
  assert.equal(item.comments[0].text.length, 2000);

  const warningLoader = createAzureDevOpsLoader({
    tokenProvider: () => "secret-comment-token",
    requestJson: async (url) => {
      if (url.includes("/comments?")) {
        throw new Error("failed with secret-comment-token");
      }
      return {
        id: 92,
        fields: {
          "System.Id": 92,
          "System.Title": "Accessible bug"
        }
      };
    }
  });
  const warningItem = await warningLoader({
    workItem: "92",
    profile
  });
  assert.deepEqual(warningItem.comments, []);
  assert.match(warningItem.commentsWarning, /could not be loaded/);
  assert.doesNotMatch(
    warningItem.commentsWarning,
    /secret-comment-token/
  );
});

test("Azure DevOps loader includes bounded attached and embedded images", async () => {
  const requestedImages = [];
  const loader = createAzureDevOpsLoader({
    tokenProvider: () => "image-token",
    requestJson: async (url) => {
      if (url.includes("/comments?")) {
        return {
          comments: [
            {
              text:
                '<p>Inline</p><img src="https://dev.azure.com/profile-org/Profile%20Project/_apis/wit/attachments/inline?fileName=inline.png&amp;download=true">'
            }
          ]
        };
      }
      return {
        id: 93,
        fields: {
          "System.Id": 93,
          "System.Title": "Bug with images"
        },
        relations: [
          {
            rel: "AttachedFile",
            url:
              "https://dev.azure.com/profile-org/Profile%20Project/_apis/wit/attachments/attached",
            attributes: { name: "evidence.png" }
          },
          {
            rel: "AttachedFile",
            url:
              "https://dev.azure.com/profile-org/Profile%20Project/_apis/wit/attachments/ignored",
            attributes: { name: "notes.txt" }
          }
        ]
      };
    },
    requestBuffer: async (url, token) => {
      assert.equal(token, "image-token");
      requestedImages.push(url);
      return { buffer: png, contentType: "image/png" };
    }
  });

  const item = await loader({
    workItem: "93",
    profile: {
      azureDevOps: {
        organization: "profile-org",
        project: "Profile Project"
      }
    }
  });

  assert.equal(requestedImages.length, 2);
  assert.deepEqual(
    item.screenshots.map(({ name, mimeType, base64 }) => ({
      name,
      mimeType,
      bytes: Buffer.from(base64, "base64").length
    })),
    [
      { name: "93-evidence.png", mimeType: "image/png", bytes: 8 },
      { name: "93-inline.png", mimeType: "image/png", bytes: 8 }
    ]
  );
  assert.equal(item.imagesWarning, "");
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
