import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { WebpackPlugin } from "@electron-forge/plugin-webpack";

const config = {
  packagerConfig: {
    asar: true,
  },
  makers: [new MakerSquirrel({}), new MakerZIP({}, ["darwin"]), new MakerDeb({}), new MakerRpm({})],
  plugins: [
    new WebpackPlugin({
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
