# Mission recovery fencing build — 2026-10-06

This build follows the green runtime safety baseline in PR #111. It reviews the
recovery intent in PRs #106–108 and integrates the useful behavior with the
current mission store's transactional loading and atomic replacement.

Every mission write now takes a local filesystem directory lock, reloads the
latest records, checks the expected version, then atomically replaces the file.
An update must provide its expected version. A missing file after the store has
observed one is an error rather than an empty database. The atomic writer fsyncs
the containing directory after rename.

Recovery claims increment the mission version and mint an unpredictable token.
An active claim rejects even the same owner name. Recovery writes must carry
the current token and an unexpired lease; release requires that exact token.
After a lease expires, a new claim replaces the token and old workers cannot
commit or release it. The mission engine claims before resuming and releases
after completion or error; a concurrent engine cannot start the same recovery.

Regression coverage exercises independent stores, separate Node processes,
stale versions, repeated owner names, expired-owner fencing, and concurrent
engine recovery. The root `npm test` gate passes with 256 tests (13 core,
238 runtime, 3 repository analyst, 2 CLI) on Node 24.

The lock requires all writers to share a reliable local filesystem. A process
that crashes while holding the directory lock leaves it behind and writes fail
closed after the timeout; operator-guided stale-lock recovery remains future
work. The lease fences mission-state commits, but cannot stop external side
effects already in progress. Long recoveries need lease renewal or a sufficiently
bounded execution; expiry deliberately prevents their final state commit.
This is not a distributed consensus protocol.
