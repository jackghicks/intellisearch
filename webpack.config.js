//@ts-check

'use strict';

const path = require('path');
const webpack = require('webpack');

/** @typedef {import('webpack').Configuration} WebpackConfig **/

/** @type WebpackConfig */
const webExtensionConfig = {
	mode: 'none', // this leaves the source code as close as possible to the original (when packaging we set this to 'production')
	target: 'webworker', // extensions run in a webworker context
	entry: {
		extension: './src/extension.ts',
	},
	output: {
		filename: '[name].js',
		path: path.join(__dirname, './dist/web'),
		libraryTarget: 'commonjs',
	},
	resolve: {
		mainFields: ['browser', 'module', 'main'], // look for `browser` entry point in imported node modules
		extensions: ['.ts', '.js'],
		alias: {},
		fallback: {
			// Webpack 5 no longer polyfills Node.js core modules automatically.
			// see https://webpack.js.org/configuration/resolve/#resolvefallback
			assert: require.resolve('assert'),
		},
	},
	module: {
		rules: [
			{
				test: /\.ts$/,
				exclude: /node_modules/,
				use: [
					{
						loader: 'ts-loader',
					},
				],
			},
		],
	},
	plugins: [
		new webpack.optimize.LimitChunkCountPlugin({
			maxChunks: 1, // web extensions must be a single bundle
		}),
		new webpack.ProvidePlugin({
			process: 'process/browser', // shim for the global `process` variable
		}),
	],
	externals: {
		vscode: 'commonjs vscode', // the vscode-module is created on-the-fly and must be excluded
	},
	performance: {
		hints: false,
	},
	devtool: 'nosources-source-map',
	infrastructureLogging: {
		level: 'log', // enables logging required for problem matchers
	},
};

module.exports = [webExtensionConfig];
