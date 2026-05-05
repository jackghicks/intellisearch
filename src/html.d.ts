// Allow TypeScript to understand `import html from './webview/panel.html'`
// which webpack resolves via the `asset/source` rule (returns the file as a string).
declare module '*.html' {
	const content: string;
	export default content;
}
