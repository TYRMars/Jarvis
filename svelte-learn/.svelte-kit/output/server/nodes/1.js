

export const index = 1;
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/fallbacks/error.svelte.js')).default;
export const imports = ["_app/immutable/nodes/1.BH8Xgy4g.js","_app/immutable/chunks/DE8tGRaY.js","_app/immutable/chunks/B2WcDiD7.js","_app/immutable/chunks/CpIn2oQ2.js"];
export const stylesheets = [];
export const fonts = [];
