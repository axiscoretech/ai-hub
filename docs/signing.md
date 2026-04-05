# macOS Signing and Notarization

This project is prepared for `Developer ID Application` signing and Apple notarization in GitHub Actions.

## Required GitHub Actions secrets

- `APPLE_SIGNING_CERTIFICATE_P12_BASE64`
- `APPLE_SIGNING_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

## What each secret means

- `APPLE_SIGNING_CERTIFICATE_P12_BASE64`: base64-encoded exported `.p12` certificate
- `APPLE_SIGNING_CERTIFICATE_PASSWORD`: password used when exporting the `.p12`
- `APPLE_SIGNING_IDENTITY`: exact certificate name, usually `Developer ID Application: Your Name (TEAMID)`
- `APPLE_ID`: Apple ID email used for notarization
- `APPLE_APP_SPECIFIC_PASSWORD`: app-specific password generated for that Apple ID
- `APPLE_TEAM_ID`: Apple Developer team identifier

## Export the signing certificate

1. Open Keychain Access on the Mac that has the `Developer ID Application` certificate installed.
2. Export the certificate as `.p12` with a password.
3. Convert it to base64:

```bash
base64 -i developer-id-application.p12 | pbcopy
```

4. Paste that value into the `APPLE_SIGNING_CERTIFICATE_P12_BASE64` GitHub secret.

## Release flow

1. Bump `version` in `package.json`.
2. Push `master`.
3. Create and push a tag:

```bash
git tag v1.1.0
git push origin v1.1.0
```

4. GitHub Actions will:
   - import the certificate into a temporary keychain
   - sign the app with `Developer ID Application`
   - notarize the built `.app` with Apple
   - publish signed DMG and ZIP files to the GitHub release

## Validate the released app

Download the built app or mount the DMG, then run:

```bash
spctl --assess --type open --context context:primary-signature -v "/Applications/AI Hub.app"
codesign --verify --deep --strict --verbose=2 "/Applications/AI Hub.app"
xcrun stapler validate "/Applications/AI Hub.app"
```

## Notes

- If the Apple secrets are missing, the workflow still builds an unsigned release.
- The notarization hook is implemented in `scripts/notarize.js`.
- Electron entitlements are defined in `assets/entitlements.mac.plist` and `assets/entitlements.mac.inherit.plist`.
