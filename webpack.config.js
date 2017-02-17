const path = require("path");
const webpack = require("webpack");
const pkg = require("./package.json");

module.exports = {
    entry: "./src/index.js",

    module: {
        rules: [{
            test: /\.js$/,
            exclude: /node_modules/,
            use: {
                loader: "babel-loader",
                options: Object.assign(pkg.babel, {
                    presets: [
                        ["es2015", { modules: false }],
                        "es2016",
                        "es2017",
                        "stage-0"
                    ]
                })
            }
        }]
    },

    output: {
        path: path.resolve(__dirname, "./dist"),
        filename: "TeamworkChat.dist.js",
    },

    externals: {
        ws: "WebSocket",
        "node-fetch": "fetch"
    },

    resolve: {
        mainFields: ["jsnext:main", "browser", "module", "main"]
    }
};