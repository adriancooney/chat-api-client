const path = require("path");
const webpack = require("webpack");

module.exports = {
    entry: "./src/index.js",

    module: {
        rules: [{
            test: /\.js$/,
            exclude: /node_modules/,
            use: "babel-loader"
        }]
    },

    output: {
        path: path.resolve(__dirname, "./dist"),
        filename: "TeamworkChat.dist.js",
    },

    externals: {
        ws: "WebSocket",
        fetch: "fetch"
    },

    resolve: {
        mainFields: ["jsnext:main", "browser", "module", "main"]
    }
};