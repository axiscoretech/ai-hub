# Contributing to AI Hub

Bugs and ideas belong in [GitHub issues](https://github.com/axiscoretech/ai-hub/issues).
Security vulnerabilities belong in a [private advisory](https://github.com/axiscoretech/ai-hub/security/advisories/new), as described in [SECURITY.md](SECURITY.md).
How people treat each other is in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Leave secrets out of the report

Do not attach or paste WireGuard `.conf` files, private keys, cookies, site sessions, OpenClaw dashboard tokens, or account passwords. Describe what happened without those files. The README section on privacy lists what the app stores on disk.

## Set up

GitHub Actions uses Node.js 20. npm comes with it.

```bash
git clone https://github.com/axiscoretech/ai-hub
cd ai-hub
npm ci
npm start
```

`npm start` compiles TypeScript and opens the Electron app.

## Checks before a pull request

```bash
npm run typecheck
npm test
```

`npm test` builds the app, then runs the tests in `test/` with the Node.js test runner. The same two commands run on macOS and Ubuntu for every push and pull request.

`npm run smoke:services` opens the live service sites. It is scheduled separately and is not required for every change.

## Pull requests

Open the pull request against `master`. Keep it to one change. When the change alters behavior the suite already covers, add or update a test in `test/`.

Do not bump the version in `package.json` or edit `CHANGELOG.md` unless a maintainer asked for a release.

Do not commit certificates, `.p12` files, or signing passwords. Notes for people who publish signed builds are in [`docs/signing.md`](docs/signing.md).
