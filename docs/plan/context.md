# Package context

Run `python3 docs/package-context.py WP-019` for a package brief. It lists product features, acceptance case IDs, dependencies and owning paths. Read linked requirements and cases when implementing the feature.

The catalog owns feature, requirement, case and operation assignments. The [DAG](dag.json) selects context and orders packages. The [context manifest](context-manifest.json) indexes the selected IDs. `own_*` lists identify the package's assignments; other selected IDs provide context. `context_case_ids` identifies cases outside the package's dependency chain.

The existing `outputs` and `acceptance_gates` fields remain for evf compatibility. They contain feature descriptions and acceptance case IDs. Packages list features and acceptance case IDs; implementations choose their design. Schema links describe the current schema reference; each feature adds the storage it needs when built.

`depends_on` orders domain work. `ui_depends_on` adds presentation prerequisites. Owning paths identify where a package may change code. Original references and unrelated assets remain preserved.

Read full records with `--part requirements`, `--part operations`, `--part cases` or `--part schema`. Use `--page` for later pages. Selected records retain their IDs and report page counts.

Regenerate the projections after an approved catalog or scope change:

```sh
python3 docs/package-context.py --refresh-manifest
python3 docs/package-context.py --refresh-plan
python3 docs/package-context.py --check-manifest
python3 docs/package-context.py --check-plan
python3 docs/package-context.py --check-ownership
python3 docs/package-context.py --check-case-actions
```

Run `python3 docs/plan/check-scope.py --base <commit>` to compare package IDs, dependencies, owning paths and selected acceptance IDs with a prior commit. Planning estimates remain rough scope estimates. Documentation checks do not establish application acceptance or grant implementation, publication or spending approval.

Store generated briefs and verification evidence outside the repository. Follow the repository verification workflow for actual feature behavior.
