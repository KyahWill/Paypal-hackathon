type DeployState = {
  projectCount: number;
  // DEMO_RESET_COMMIT: the commit someone asked to reset the demo on.
  resetCommit?: string;
  // RENDER_GIT_COMMIT: the commit being deployed.
  deployCommit?: string;
};

// A reset needs the exact commit being deployed, so a value left behind in the
// dashboard cannot wipe the demo again on the next push.
export function seedAction({ projectCount, resetCommit, deployCommit }: DeployState) {
  if (resetCommit && resetCommit === deployCommit) return "reset";
  return projectCount === 0 ? "first-seed" : "keep";
}
