# Backseat reads XState's private `_transitions`

The trace and a call's journey need facts that the state an actor lands in can't show. They need to know which of two guarded transitions to one target was taken, whether an `always` state was passed straight through, and whether a transition acted without moving. XState's public routes don't say this. `getMicrosteps` returns snapshots and actions but not which transitions fired. `getNextTransitions` lists candidates without checking their guards. `getTransitionData` would run the guards a second time and is never consulted for `always` steps.

**The runtime learns which transitions a call fired from the private `_transitions` field of XState's `@xstate.microstep` inspection event, and the `xstate` peer range is `^5.32.6`.**

We considered deriving it ourselves: add a no-op action to every transition definition once the machine is built, then read it back from the public `@xstate.action` event. It records the same steps on every machine we tried, and the Stately export and the lint come out byte-identical. We still didn't adopt it, for two reasons:

- It trades one undocumented dependency for two others: changing `.actions` after the machine is built, and relying on an action with no implementation being a silent no-op. Anything that counts a transition's actions would also have to skip it.
- Its steps differ in two cases. When a parallel conflict drops a transition, `_transitions` still lists it but the recorder doesn't. When a target's entry action throws, `_transitions` records nothing, while the recorder records a step even though the actor stayed put.

Adding the action in the compiler instead would miss machines built with plain `setup()`, and it would show up in `machine.config`, which the Stately export reads.

**An XState without the field is refused with a clear error, not a crash.** If a microstep's `_transitions` is not an array, the call fails with a message that names the field and says to install a supported XState or a `backseat-ai` that supports this one. Nothing from the call is saved, and the run can still be resumed. Without this check, the inspector threw inside the actor, errored it, and handed the driver XState's `TypeError`. A test that drives an `always` chain checks that the transitions arrive, and another checks the error and that the run can be resumed.

The cost is the range. A tilde range would have shut out XState's current release, so a new user could hit a peer conflict on a plain install. We accept a caret and the risk that a later 5.x drops the field. CI covers that risk with a job that upgrades to the latest XState 5.x and runs the typecheck and tests against it. The lockfile still pins one version.
