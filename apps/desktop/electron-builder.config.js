const macSigningEnabled = process.env.MACOS_SIGNING_ENABLED === "true";
const macNotarizationEnabled =
  macSigningEnabled &&
  Boolean(process.env.APPLE_ID && process.env.APPLE_ID_PASSWORD && process.env.APPLE_TEAM_ID);
const packageVersion = require("./package.json").version;
const prereleaseChannel = packageVersion.match(/-\d*([A-Za-z][0-9A-Za-z]*)(?:[.-]|$)/)?.[1];
const publishChannel = prereleaseChannel || "latest";

module.exports = {
  appId: "com.rifqi2320.repttyl",
  productName: "Repttyl",
  asar: true,
  generateUpdatesFilesForAllChannels: true,
  directories: {
    output: "out",
  },
  files: ["dist/**/*", "package.json"],
  publish: [
    {
      provider: "github",
      owner: "rifqi2320",
      repo: "repttyl",
      channel: publishChannel,
    },
  ],
  mac: {
    target: ["dmg", "zip"],
    category: "public.app-category.developer-tools",
    artifactName: "repttyl-desktop-darwin-${arch}-${version}.${ext}",
    identity: macSigningEnabled ? process.env.MACOS_SIGNING_IDENTITY || undefined : null,
    hardenedRuntime: macSigningEnabled,
    gatekeeperAssess: false,
    notarize: macNotarizationEnabled
      ? {
          appleId: process.env.APPLE_ID,
          appleIdPassword: process.env.APPLE_ID_PASSWORD,
          teamId: process.env.APPLE_TEAM_ID,
        }
      : false,
  },
  win: {
    target: "nsis",
    artifactName: "repttyl-desktop-win32-${arch}-${version}.${ext}",
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
  },
  linux: {
    target: ["tar.gz", "deb", "rpm"],
    category: "Development",
    executableName: "repttyl-desktop",
    artifactName: "repttyl-desktop-linux-${arch}-${version}.${ext}",
  },
};
