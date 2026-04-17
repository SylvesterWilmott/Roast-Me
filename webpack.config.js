"use strict";
const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");
const ZipPlugin = require("zip-webpack-plugin");
const TerserPlugin = require("terser-webpack-plugin");
const pkg = require("./package.json");

module.exports = {
  mode: "production",
  entry: {
    background: path.join(__dirname, "src", "background.js"),
    "sidePanel/main": path.join(__dirname, "src", "sidePanel.js"),
  },
  output: {
    path: path.join(__dirname, "dist"),
    filename: "[name].js",
    publicPath: "",
  },
  optimization: {
    minimize: true,
    minimizer: [
      new TerserPlugin({
        terserOptions: {
          compress: {
            drop_console: false,
            drop_debugger: true,
          },
          format: {
            comments: false,
          },
        },
        extractComments: false,
      }),
    ],
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: "babel-loader",
          options: {
            presets: ["@babel/preset-env"],
          },
        },
      },
      {
        test: /\.css$/,
        use: ["style-loader", "css-loader"],
      },
      {
        test: /\.(png|svg|jpg|gif)$/,
        use: ["file-loader"],
      },
    ],
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        {
          from: "public",
          to: "",
          globOptions: {
            ignore: ["**/.DS_Store", "**/.*"],
          },
        },
      ],
    }),
    new ZipPlugin({
      filename: `${pkg.name}-${pkg.version}.zip`,
    }),
  ],
};
