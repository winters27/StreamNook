// Resolves the plugin's `react` imports to the host's copy, so contributed
// components run on the host React tree (hooks require one shared instance).
module.exports = globalThis.__STREAMNOOK_HOST_LIBS__.react;
