// A bounded demo capability, not a general bypass of host approval or merge policy.
export function canAutoApprove(mode, agent, proposal) {
  return mode === "auto" && agent?.adapter?.adapterId === "workspace-edit" &&
    agent.adapter.source === "builtin:workspace-edit" &&
    proposal?.status === "pending" && proposal.files?.length === 1 &&
    proposal.files[0].path === "examples/foreign-booking/styles.css";
}
