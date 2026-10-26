# Backend performance iteration

User targets: improve overall backend performance by at least 50% and bring gateway startup below 30 seconds. Lightweight patches to the pinned kernel are permitted. The preceding release is v2026.1025.0, source 35d36034aa9ac5962cb7fd5778f2e7fb75047abc, pushed and published before this iteration began.

## Measurement contract

- Keep standalone Node 24.22.1, OpenClaw 2026.10.6, the physical gateway, the same machine, installed location and configuration for baseline/candidate comparisons. Record actual versions and configuration fingerprints without exposing credentials.
- Measure real readyz and authenticated backend usability. Count the first sessions, model catalog, command catalog, configuration and dashboard reads. Moving imports after readyz does not remove them from the measured workflow.
- Overall latency is the wall time of that fixed workflow, from process launch through those backend reads and graceful shutdown. Require at least 50% reduction against the comparable unprofiled baseline. Also record each phase, steady RPC median/p95, throughput, CPU and gateway process memory so a startup improvement cannot hide a substantial regression elsewhere.
- Target readyz and successful initial backend reads below 30 seconds in repeated runs. Report first/warm launches separately; retain failures and outliers. A visible window and a cached or already running gateway are insufficient proof.
- Diagnostic CPU profiles and full startup tracing locate work but are not comparable timing results. The initial profiled run took 70.4s to healthz, 89.0s to readyz and 105.6s to usable UI; the previous unprofiled three-run readyz median was 68.3s. Do not mix these populations.

## Safety and implementation constraints

- Preserve admission, source/boundary checks, credentials, plugin generation ownership and retirement, clean database/worker shutdown, update locks, journals, complete backup and rollback.
- Do not skip checks, weaken timeouts, kill workers earlier or mark readiness before mandatory backend capabilities work.
- Prefer fewer duplicate traversals and module acquisitions, narrower dependency graphs and bounded generation-scoped reuse. Test invalidation, replacement/symlink changes, cancellation and the first real use of any delayed work.
- Node 24.22.1 already caches default resolution by specifier, parent URL and import attributes. An identical extra cache needs measured additional hits to justify it.

## Work

- [x] Publish and push the preceding desktop release.
- [x] Capture a current, owned gateway CPU profile and identify phase costs.
- [ ] Finish preceding website deployment and installed video playback acceptance.
- [ ] Add a reusable, privacy-preserving benchmark and collect an unprofiled baseline.
- [ ] Enable existing full startup tracing in a diagnostic launch to split currently hidden bootstrap/runtime phases.
- [ ] Reproduce and reduce the largest verified module-resolution, source-capture and registry costs with bounded patches.
- [ ] Run functional, mutation/invalidation and shutdown/update regressions.
- [ ] Build/install the final candidate and repeat the same benchmark to prove both numeric targets without a functional or resource regression.

Current diagnostic evidence is under `.cache/backend-next/`. It indicates heavy synchronous filesystem work (lstat, module stat, realpath and source admission), rather than expensive V8 compilation. Inclusive profile stacks overlap and must not be added together as independent savings.
