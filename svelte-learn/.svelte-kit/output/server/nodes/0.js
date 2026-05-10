

export const index = 0;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/_layout.svelte.js')).default;
export const imports = ["_app/immutable/nodes/0.Bi-fmmpy.js","_app/immutable/chunks/DE8tGRaY.js","_app/immutable/chunks/B2WcDiD7.js"];
export const stylesheets = [];
export const fonts = [];
