export function workItemsRequest(workItems) {
  const separator = "\n\n==============================\n\n";
  const blockBudget = Math.floor(
    (9800 - separator.length * (workItems.length - 1)) / workItems.length
  );
  return workItems.map((workItem) => {
    const header = [
      `Azure DevOps ${workItem.workItemType || "Work Item"} ${workItem.id}: ${workItem.title}`,
      `URL: ${workItem.webUrl}`,
      workItem.state ? `State: ${workItem.state}` : ""
    ].filter(Boolean).join("\n");
    const evidence = [
      workItem.acceptanceCriteria ? `Acceptance criteria:\n${workItem.acceptanceCriteria}` : "",
      workItem.description ? `Description:\n${workItem.description}` : "",
      workItem.reproduction ? `Reproduction steps:\n${workItem.reproduction}` : "",
      workItem.commentsWarning, workItem.imagesWarning,
      ...(workItem.comments ?? []).map((comment) =>
        `Comment by ${comment.author || "Unknown"}${comment.createdAt ? ` at ${comment.createdAt}` : ""}:\n${comment.text}`)
    ].filter(Boolean).join("\n\n");
    const evidenceBudget = Math.max(0, blockBudget - header.length - "\nEvidence:\n".length);
    return evidenceBudget > 0 && evidence
      ? `${header}\nEvidence:\n${evidence.slice(0, evidenceBudget)}` : header.slice(0, blockBudget);
  }).join(separator);
}
