# Governance

This is a small project with one maintainer. This document says who decides
what, who holds which access, and what happens if the maintainer becomes
unavailable. It describes how things are today and makes no claim beyond that.

## How decisions are made

The maintainer makes all final decisions about the project's direction, its
releases and what gets merged.

- Changes arrive as pull requests. Every pull request runs the full CI matrix
  listed in [CONTRIBUTING.md](CONTRIBUTING.md), and the maintainer's own changes
  go through the same pull requests and the same checks.
- A new gate starts as an issue using the gate proposal template, so the design
  is discussed before code is written (CONTRIBUTING.md, ground rule 6).
- Decisions are recorded where a reader will find them: in the
  [CHANGELOG](CHANGELOG.md) entry for the release that ships them, and for
  longer-lived design facts, in the files under `design/`.
- Disagreement is raised on the pull request or issue concerned. The maintainer
  decides, and writes down why.

## Roles

| Role | Held by | Responsibilities |
|---|---|---|
| Maintainer | [@BhodiSea](https://github.com/BhodiSea) (Cogvera Labs) | Reviews and merges pull requests, triages issues, sets direction. Code owner for every path in `.github/CODEOWNERS`. |
| Security contact | The maintainer | Receives private vulnerability reports and answers them within the times stated in [SECURITY.md](SECURITY.md). Publishes advisories. |
| Release manager | The maintainer | Cuts releases by the procedure in CONTRIBUTING.md, "Releases", tags the merge commit, and runs the post-tag follow-ups. |
| Contributor | Anyone | Opens issues, discussions and pull requests under the [Code of Conduct](CODE_OF_CONDUCT.md). Contributors hold no repository permissions. |

## Who has access to what

- **Repository administration**, which includes merging, settings, the security
  advisory queue and the ability to push tags: the maintainer's GitHub account
  only. There are no other collaborators.
- **Release signing**: nobody holds a signing key, because there is none.
  `.github/workflows/release.yml` builds the release asset and signs its
  provenance attestation with a short-lived identity issued to the workflow run.
  The workflow uses only the token GitHub issues to that run.
- **Secrets**: the repository's own workflows use no long-lived secrets.

### Granting access

Nobody else has write access today. If that changes, it will be granted only
to someone with a record of reviewed contributions to this repository, with
two-factor authentication enabled on their account, and at the lowest
permission level that lets them do the work. Administrator access stays with
the project owner. This document will name every person who holds access.

## Continuity

**There is no named successor today.** If the maintainer became unavailable,
nobody else could merge a change, close an issue or publish a release in this
repository. That is a real limitation of a single-maintainer project, and
anyone depending on this project should weigh it.

What does not depend on the maintainer:

- **Anyone can continue the work in a fork.** The repository is licensed
  Apache-2.0, with `template/**` additionally under 0BSD, and it is a GitHub
  template repository. [docs/forking.md](docs/forking.md) lists every place a
  fork has to rename.
- **No credential needs handing over to publish a release.** Release signing
  uses the workflow's own short-lived identity, so a successor with write access
  could cut a release on their first day.
- **Installed projects keep working.** A scaffolded project carries its own
  copy of every gate, hook and workflow. It contacts this repository only when
  someone runs `update`.

Closing this gap means adding a second person with administrator access and
naming them here. Until that happens this section stays as written.

## Changing this document

Changes to governance are made by pull request like any other change, and are
noted in the CHANGELOG.
