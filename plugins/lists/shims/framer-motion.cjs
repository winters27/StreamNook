// Resolves the plugin's `framer-motion` imports to the host's copy, keeping
// one animation runtime and honoring the app-wide MotionConfig.
module.exports = globalThis.__STREAMNOOK_HOST_LIBS__.framerMotion;
