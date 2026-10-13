# Contributing to TrianguLair

Thanks for your interest! The project is in phase 0; contributions are by invitation for now.

## Getting started

1. Read the [specification](docs/SPEC.md): it is the source of truth.
2. Pick a task in [docs/TASKS.md](docs/TASKS.md) or in the issues (`T-xxx` in the title) that is "to do" and whose dependencies are done.
3. Comment on the issue to claim it, so nobody works on the same thing twice.

## Rules

- **One branch per task**, named `t-xxx-short-description`, and a pull request that references the issue (`Closes #n`).
- **Tests are the contract**: a PR is merged only if its own tests and the project's tests pass (`npm test`, `npm run typecheck`).
- **Sensitive areas** (encryption, sync, keys): review by someone who did not write the code is mandatory.
- **Spec first**: any change of behavior or format goes through a PR on `docs/SPEC.md`, discussed before it is coded.
- **Strict TypeScript**, no dependency on proprietary services.
- **English** for code, comments, commits, issues and docs.

## Developer Certificate of Origin (DCO)

Every commit must be signed off with `git commit -s`, which adds:

    Signed-off-by: Your Name <email>

This certifies that you have the right to submit the code under the project's license ([Developer Certificate of Origin 1.1](https://developercertificate.org/)). No copyright assignment is required.

## License

Code under [MPL-2.0](LICENSE). Icons and visuals: CC0 or a compatible license.

## Conduct

See the [code of conduct](CODE_OF_CONDUCT.md). Security vulnerabilities: see [SECURITY.md](SECURITY.md), never in a public issue.
