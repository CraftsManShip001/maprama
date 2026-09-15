# Contributing to Maprama

Thanks for helping out. This is a short guide; the root [README](./README.md)
describes the repository layout.

## Setup

- Node.js 22.12+ and npm (the repository uses npm workspaces).
- For `packages/engine-native` tests: a C++17 compiler (`clang++` or `c++`).
- For the example app: Xcode and CocoaPods (iOS) or Android Studio (Android).

```sh
npm install
npm run build
```

## Commands

Run from the repository root:

| Command | What it does |
| --- | --- |
| `npm run build` | Builds `@maprama/protocol` first, then every workspace. |
| `npm run typecheck` | Type-checks every workspace (including `example`). |
| `npm test` | Runs every workspace's tests and checks the `LICENSE` / `NOTICE` copies. |
| `npm run docs:dev` / `npm run docs:build` | Documentation site (installs `docs/` dependencies on first use). |
| `npm run <script> -w <package>` | Runs a script in one workspace, e.g. `npm test -w @maprama/engine-web`. |

CI (`.github/workflows/ci.yml`) runs `npm ci`, `build`, `typecheck`, `test`
and `docs:build` on Node 22 and 24.

## Licence files in packages

Each published package carries checked-in copies of the root `LICENSE` and
`NOTICE` so they end up in its npm tarball. After editing the root files, run
`node scripts/check-legal-files.mjs --write` to refresh the copies;
`npm test` fails while they differ.

## Commits

Commit messages use the format `type :: 설명` (a short description, in
Korean), for example:

```
feat :: 이동 timeScale 추가
fix :: 모델 없이 생성된 캐릭터에 기본 몸체가 생기지 않던 문제 수정
docs :: 설치 안내 보강
```

Common types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `merge`.
Keep each commit focused, and make sure `npm run build`, `npm run typecheck`
and `npm test` pass before opening a pull request.

## Licence

By contributing you agree that your contributions are licensed under the
Apache License 2.0 (see [LICENSE](./LICENSE)). Do not add map data or assets
that cannot be redistributed; OpenStreetMap-derived data must keep its ODbL
attribution.
