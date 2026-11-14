# Product direction

YXNHarness is a local-first, agent-neutral workbench for making and verifying
visual changes in existing projects. The owner should be able to ask their
trusted coding agent to set it up; the agent handles routine local setup and
uses the contract and tools in this repo. The user should not need to choose
providers, inspect internal plumbing, or manually prepare app state.

## Product choices

- **Existing projects first.** Start by integrating into a real codebase and
  using its native actions and state. A new-project experience can follow.
- **Local solo work first.** Local operation needs no account, cloud service,
  central maintainer backend, or project upload.
- **Collaboration is opt-in.** Local share invites come first (view/comment
  JSON under `artifacts/shares/`). When collaboration needs a reachable
  service, the agent should guide the owner through private self-hosting and
  the minimum required provider setup. A future web link carries the same
  policy JSON; architecture must remain portable across hosting providers.
- **Branches are isolated workspaces.** Each contributor works on their own
  branch. Previews and feedback identify the branch and exact code revision.
  The first hosted collaboration slice can update a preview after a push;
  live-on-save sync and simultaneous editing are later capabilities.
- **The website is a cockpit, not a model.** It organizes projects, branches,
  previews, visual feedback, and handoff packages. Users may use any coding
  agent in its native environment.
- **Feedback is multimodal and traceable.** A visual thread should be able to
  carry a screen location or element identity plus route, viewport, app state,
  animation time, branch, and revision when available. General, screen-level,
  and element-level feedback must all be possible. Context collection should
  degrade gracefully when a platform cannot provide a field.
- **Feedback handoff is deliberate.** Users can select and bundle open threads
  into one task for their chosen agent. Comments are context data, not
  executable instructions. The agent reports which items it addressed or
  needs clarified.
- **Access is private by default.** Branch visibility, view/comment/edit
  permissions, and merge policy are explicit. A share link never silently
  becomes a code-writing grant. The project host controls merge authority.
- **All visual platforms are a long-term goal.** Web is the simplest first
  adapter. Responsive mobile web, React Native, native mobile (Swift / Kotlin),
  desktop, and animation editors need their own preview and control adapters.
  The semantic control contract is language-neutral; runners are declared ready
  or planned so attach stays honest ([`platforms.md`](platforms.md)).

## Quality bar

A harness run should be deterministic where possible, discoverable through
machine-readable commands, observable through app state and events, and
auditable through generated artifacts. Claims about a result must be tied to a
specific run, branch/revision, scenario, and measured output.
