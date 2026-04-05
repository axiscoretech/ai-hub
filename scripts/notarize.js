const path = require("path");
const { execFileSync } = require("child_process");
const { notarize } = require("@electron/notarize");

function getCodeSignDetails(appPath) {
  try {
    return execFileSync("codesign", ["-d", "--verbose=4", appPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return `${error.stdout || ""}\n${error.stderr || ""}`;
  }
}

exports.default = async function notarizeApp(context) {
  const { electronPlatformName, appOutDir, packager } = context;

  if (electronPlatformName !== "darwin") {
    return;
  }

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);
  const codeSignDetails = getCodeSignDetails(appPath);
  const hasRealSigningAuthority = codeSignDetails.includes("Authority=");

  if (!hasRealSigningAuthority) {
    console.log(`No Developer ID signature found for ${appName}.app. Applying a valid ad-hoc bundle signature.`);
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
      stdio: "inherit",
    });
  }

  if (!appleId || !appleIdPassword || !teamId) {
    console.log("Skipping notarization: Apple notarization credentials are not set.");
    return;
  }

  console.log(`Submitting ${appName}.app for notarization...`);

  await notarize({
    appPath,
    appleId,
    appleIdPassword,
    teamId,
    tool: "notarytool",
  });

  console.log(`${appName}.app notarized successfully.`);
};
