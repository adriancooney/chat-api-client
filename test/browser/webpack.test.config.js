const path = require("path");
const webpack = require("webpack");
const { merge } = require("lodash");
const defaultConfig = require("../../webpack.config");

module.exports = merge({}, defaultConfig, {
    entry: path.resolve(__dirname, "./index.js"),

    output: {
        path: path.join(__dirname, "dist"),
        filename: "index.js",
    },

    devtool: "source-map",
    
    plugins: [
        new webpack.LoaderOptionsPlugin({
            debug: true
        })
   ]
});