import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { WebpackPlugin } from "@electron-forge/plugin-webpack";

const macSigningEnabled = process.env.MACOS_SIGNING_ENABLED === "true";
const macNotarizationEnabled =
  macSigningEnabled &&
  Boolean(process.env.APPLE_ID && process.env.APPLE_ID_PASSWORD && process.env.APPLE_TEAM_ID);

const packagerConfig: Record<string, unknown> = {
  asar: true,
  executableName: "repttyl-desktop",
  name: "Repttyl",
};

if (macSigningEnabled) {
  packagerConfig.osxSign = {
    identity: process.env.MACOS_SIGNING_IDENTITY || undefined,
  };
}

if (macNotarizationEnabled) {
  packagerConfig.osxNotarize = {
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_ID_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
  };
}

const config = {
  packagerConfig,
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ["darwin"]),
    new MakerDMG({ format: "ULFO" }, ["darwin"]),
    new MakerDeb({}),
    new MakerRpm({}),
  ],
  plugins: [
    new WebpackPlugin({
      devServer: {
        client: {
          overlay: {
            errors: true,
            warnings: false,
            runtimeErrors: (error: Error) => error.message !== "ResizeObserver loop completed with undelivered notifications.",
          },
        },
      },
      mainConfig: "./webpack.main.config.js",
      renderer: {
        config: "./webpack.renderer.config.js",
        entryPoints: [
          {
            html: "./src/renderer/index.html",
            js: "./src/renderer/index.ts",
            name: "main_window",
            preload: {
              js: "./src/preload/index.ts",
            },
          },
        ],
      },
    }),
  ],
};

export default config;
