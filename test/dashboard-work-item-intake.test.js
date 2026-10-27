import assert from "node:assert/strict";
import test from "node:test";
import { workItemsRequest } from "../dashboard/public/work-item-intake.js";

test("intake preserves story, task, feature and bug types and prioritizes acceptance criteria", () => {
  for (const workItemType of ["Bug", "User Story", "Task", "Feature"]) {
    const request = workItemsRequest([{ id: 42, workItemType, title: "Bounded change", state: "Active",
      webUrl: "https://dev.azure.com/org/project/_workitems/edit/42",
      acceptanceCriteria: "The approved behavior is observable.", description: "x".repeat(20000) }]);
    assert.ok(request.startsWith(`Azure DevOps ${workItemType} 42: Bounded change`));
    assert.match(request, /Acceptance criteria:\nThe approved behavior is observable\./u);
    assert.ok(request.length <= 9800);
  }
  assert.match(workItemsRequest([{ id: 43, title: "Untyped" }]), /^Azure DevOps Work Item 43:/u);
});

test("mixed-type batches stay bounded and retain each work item's identity", () => {
  const items = Array.from({ length: 20 }, (_, index) => ({ id: index + 1,
    workItemType: ["Bug", "User Story", "Task", "Feature"][index % 4],
    title: `Scoped ${index}`, webUrl: `https://dev.azure.com/org/project/_workitems/edit/${index + 1}`,
    acceptanceCriteria: "Check the specific acceptance contract.", description: "x".repeat(20000) }));
  const request = workItemsRequest(items);
  assert.ok(request.length <= 9800);
  for (const item of items) {
    assert.ok(request.includes(`Azure DevOps ${item.workItemType} ${item.id}: ${item.title}`));
  }
});
