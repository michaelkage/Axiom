"use strict";

/** Prevent integrating a task file when the destination moved beyond the task's base revision. */
function classifyWorkspaceDrift({ taskBaseBlob, workspaceHeadBlob, destinationDirty = false, destinationExists = false }) {
  if (destinationDirty) return { safe: false, reason: "the destination has uncommitted local changes" };
  if (taskBaseBlob !== workspaceHeadBlob) return { safe: false, reason: "the workspace file changed after this worker started (base revision no longer matches)" };
  if (taskBaseBlob == null && destinationExists) return { safe: false, reason: "an untracked or ignored destination file already exists" };
  return { safe: true, reason: null };
}
module.exports = { classifyWorkspaceDrift };
