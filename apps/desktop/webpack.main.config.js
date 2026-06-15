const path = require("node:path");

const tsRule = { test: /\.ts$/, use: "ts-loader", exclude: /node_modules/ };

module.exports = [
  {
    mode: process.env.NODE_ENV === "production" ? "production" : "development",
    target: "electron-main",
    entry: "./src/main/index.ts",
    output: {
      path: path.resolve(__dirname, "dist/main"),
      filename: "index.js",
    },
    module: {
      rules: [tsRule],
    },
    resolve: {
      extensions: [".ts", ".js"],
    },
  },
  {
    mode: process.env.NODE_ENV === "production" ? "production" : "development",
    target: "electron-preload",
    entry: "./src/preload/index.ts",
    output: {
      path: path.resolve(__dirname, "dist/preload"),
      filename: "index.js",
    },
    module: {
      rules: [tsRule],
    },
    resolve: {
      extensions: [".ts", ".js"],
    },
  },
];
