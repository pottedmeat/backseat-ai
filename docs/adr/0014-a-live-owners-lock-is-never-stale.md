# A live owner's lock is never stale

Every call that touches a root loads it, acts and saves it back, under a per-root lock (`withLock`). An effect can hold that lock for a long time; a search took 85–92s. Judging a lock stale by age alone lets a waiter take it mid-call, write its own record, and then lose that write when the long call saves the root it loaded earlier.

**The lock file holds `{ pid, token, at }`, and a waiter takes it over only when that pid is dead** (`process.kill(pid, 0)` fails with `ESRCH`; `EPERM` counts as alive). Only when no pid can be read, as with an empty file mid-write or something unparseable, does age decide: a lock whose mtime is older than 30s is abandoned.

**The holder refreshes the lock's mtime every 5s while its call runs**, on an unref'd interval cleared when the call ends, so a lock judged by age stays fresh. A synchronous effect blocks the heartbeat; the pid check covers that case.

**A waiter behind a live owner waits up to 180s**, long enough to outlast a known long effect, then fails loudly. It never takes a live owner's lock.

**Removal checks what it judged.** A waiter removes a stale lock only if the file still holds the content it judged, and a holder releases the lock only if it still carries its own token.

A dead owner's lock is taken at once. The cost: a dead owner whose pid has been reused by an unrelated live process holds its lock until waiters time out, which is loud and rare.
