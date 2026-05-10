export const manifest = (() => {
function __memo(fn) {
	let value;
	return () => value ??= (value = fn());
}

return {
	appDir: "_app",
	appPath: "_app",
	assets: new Set([]),
	mimeTypes: {},
	_: {
		client: {start:"_app/immutable/entry/start.Cdyumq5F.js",app:"_app/immutable/entry/app.DukCfUjO.js",imports:["_app/immutable/entry/start.Cdyumq5F.js","_app/immutable/chunks/CpIn2oQ2.js","_app/immutable/chunks/DE8tGRaY.js","_app/immutable/entry/app.DukCfUjO.js","_app/immutable/chunks/DE8tGRaY.js","_app/immutable/chunks/B2WcDiD7.js"],stylesheets:[],fonts:[],uses_env_dynamic_public:false},
		nodes: [
			__memo(() => import('./nodes/0.js')),
			__memo(() => import('./nodes/1.js')),
			__memo(() => import('./nodes/2.js'))
		],
		remotes: {
			
		},
		routes: [
			{
				id: "/",
				pattern: /^\/$/,
				params: [],
				page: { layouts: [0,], errors: [1,], leaf: 2 },
				endpoint: null
			},
			{
				id: "/api/plans",
				pattern: /^\/api\/plans\/?$/,
				params: [],
				page: null,
				endpoint: __memo(() => import('./entries/endpoints/api/plans/_server.ts.js'))
			}
		],
		prerendered_routes: new Set([]),
		matchers: async () => {
			
			return {  };
		},
		server_assets: {}
	}
}
})();
