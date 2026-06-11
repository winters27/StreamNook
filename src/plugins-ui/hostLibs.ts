// Shares the host's copies of the libraries ui plugins must not duplicate.
// A plugin's build aliases its bare `react` / `react/jsx-runtime` /
// `framer-motion` imports to shims that read this global, so contributed
// components run on the same React instance as the host tree (hooks only
// work when both sides share one React).

import * as react from 'react';
import * as reactJsxRuntime from 'react/jsx-runtime';
import * as framerMotion from 'framer-motion';

export const HOST_LIBS = { react, reactJsxRuntime, framerMotion };

export function installHostLibs(): void {
  (globalThis as Record<string, unknown>).__STREAMNOOK_HOST_LIBS__ = HOST_LIBS;
}
