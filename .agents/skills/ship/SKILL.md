---
name: ship
description: "Apply when a reviewed task is ready to open or merge a PR. Require current authorization, exact-head full independent scoped proof, verified protection and human review for feedback; ordinary builds may merge automatically after final-head tests and independent approved review."
---

# Ship

The author opens one PR only after explicit external authorization and current full author proof. The verifier supplies a distinct trusted provider identity/model family and reproduces the reviewed current-stage case/gate portions at the same head/current main/policy fingerprint. Tooling checks do not qualify application acceptance.

The owner approved automatic ordinary build PR merge on 2026-10-13. `evf ship` requires final-head full tests, a distinct trusted verifier identity/model family and an approved review receipt bound to that head and reviewed risk classification. Feedback requires a configured human's approval at the exact final head, no outstanding requested changes, strict enforced branch protection and full author/verifier proofs. Comments/pending reviews do not erase a prior requested change. Never merge your own work, push directly to main or force-push.

WP-097 alone has the owner's 2026-10-14 fast-track exception to signed evf proof. After normal tests, cross-model approval and Sebastian's preview/configuration/go-live approval, the coordinator imports documentary evidence with `evf shipped --fast-track WP-097 --evidence <file>`. The reviewed commit must already be on current main. The file records `commit`, passing `checks: [{command, result: "passed", evidence}]`, `author: {actor, model_family}`, `verifier: {actor, model_family, verdict: "approved", commit, evidence}` and `owner_go_live: {actor: "Sebastian", commit, evidence}`. Evidence fields link to the actual logs and approval notes at that commit. This owner-reviewed documentary import is unsigned and does not authenticate provider identities; the coordinator checks those references before importing. evf retains the approvals through its normal progress writer, marks only WP-097 done and unlocks WP-087. Merge the generated progress through reviewed maintenance and refresh the root before delegating WP-087; this import has no retained signed milestone to survive restoring the old progress bytes. Other packages retain signed proof, kickoff gates and normal merge requirements.

If main/branch changes, stop for new full author/verifier proof and renewed final-head human review for feedback PRs. Quick checks support iteration and cannot reuse historical full proof. Prototypes stay drafts for owner product review.

Shipped records retain exact proven/deferred portions and merge commit; `package_completion` remains false. evf alone writes canonical progress on ship and coordinator acknowledgement. `evf shipped --clear` records the reviewed milestone and preserves provenance. Producer/interface milestones unlock dependent tasks. Full package closure is recorded when the coordinator acknowledges a full-target shipped integration plan with reviewed `packageClosures`, all target gates/cases, acknowledged parts and done direct prerequisites. No package-owner patch or explorer checklist is required. Maintenance (`OPS-n`) uses independently attested tooling proof and review, with no application cases or package gates.

Protection configuration and paid providers remain separate owner actions. `evf github setup` reports a blocked policy receipt and performs no writes. See `tools/evf/README.md` for remaining setup and recovery boundaries.
