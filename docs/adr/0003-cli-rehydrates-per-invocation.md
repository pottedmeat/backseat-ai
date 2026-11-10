# The CLI rehydrates each actor from a file per invocation; no process survives between calls

Every drive call locks the root, restores it from a JSON snapshot on disk, acts, and writes it back. Nothing runs in between.

**There is no daemon. Each invocation rehydrates the root from its file, against the code the run pinned when it was created.** We chose this because the machines are purely reactive: `after` and `invoke` are refused when a machine is built, and a transition's effect is awaited inside the call that sends its event. The one thing a daemon adds, advancing timers and in-flight invocations while no agent is calling, buys nothing here, and a daemon's client would still be a fresh Node process paying the same start-up.

The run's `create` call captures the modules of the machines as it loads them, and every later call on that run is served them back, so an edit, a delete or a rename mid-run has no effect until a new run. For that the pin mode is derived from argv and the hooks are registered **before** the catalog is imported: a module already in the ESM cache is never offered to the hooks, so the ordering is the mechanism. A catalog imported too early is refused rather than pinned silently. Backseat itself is not pinned; the definition cannot change, and the runtime is not the definition. A finished run sheds its pin and runs live.

## Considered options

- **On-demand daemon over a Unix socket.** Strongest guarantees and native tailing, but it adds a bootstrap probe, idle teardown, stale-socket handling and version skew, and still needs persistence for crash safety. It saves only the in-process milliseconds. Revisit if a machine ever needs timer- or invoke-driven progression between agent turns; the `Store` seam means a daemon can front the same files.
- **Detached process plus PID file.** PID reuse misread as liveness is a recurring bug in that design, and pm2 and forever both had to add sockets anyway.

## Consequences

- Two agents driving children of one root serialise on a per-root lock file created exclusively; without it the second writer loses the first's progress.
- A machine that needs unattended progression cannot be driven by this CLI until a daemon fronts the store, which is why `after` and `invoke` are refused rather than half-supported.
