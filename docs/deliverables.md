# Documentation deliverables and upkeep

[README](../README.md) and [START-HERE](START-HERE.md) index current product, architecture, schema, contracts, acceptance, reference and plan inputs. Use [package contexts](plan/context-manifest.json) and `python3 docs/package-context.py WP-019 --output /tmp/WP-019.json` for bounded assigned work. Generated packets stay on demand outside the repository.

Current machine catalogs own requirements/cases/operations/schema/DAG once; the offline explorer is a compact deterministic projection. `refresh-explorer-plan.py` compiles only the explicit current input manifest; `render-build-explorer.py` applies the maintained UI template; `update-build-explorer.py` preserves evidence-backed canonical progress. Run maintenance sequentially because each acquires the same lock. See [build-agent workflow](build-agent-workflow.md).

The preserved product-design HTML and assets are unrelated to consolidation edits. Every implementation package remainsnot_started/revision0. Documentation and explorer verification do not complete future application gates.

[Verification](verification.json) records the passed independent documentation reviews and bounded checks. Actual application gates remain future-not-run; no package progress was advanced.
