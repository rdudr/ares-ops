// Stand-ins for phone-only and screen-only modules the apps' calculation files import.
// Nothing here is called when the Console works out an overview.
const noop = () => undefined;
const asyncNoop = async () => undefined;
export const Capacitor = { isNativePlatform: () => false, getPlatform: () => "web", convertFileSrc: (s) => s };
export const Filesystem = { writeFile: asyncNoop, readFile: asyncNoop, getUri: asyncNoop, deleteFile: asyncNoop, mkdir: asyncNoop };
export const Directory = { Documents: "DOCUMENTS", Cache: "CACHE", Data: "DATA", External: "EXTERNAL" };
export const Encoding = { UTF8: "utf8" };
export const Share = { share: asyncNoop };
export const get = asyncNoop, set = asyncNoop, del = asyncNoop, keys = async () => [], createStore = noop;
export const toast = Object.assign(noop, { success: noop, error: noop, message: noop, info: noop, warning: noop });
export const useState = (v) => [v, noop], useEffect = noop, useMemo = (f) => f(), useCallback = (f) => f, useRef = (v) => ({ current: v });
export const useSyncExternalStore = (sub, get) => get();
export const createElement = noop, Fragment = "fragment", jsx = noop, jsxs = noop;
export default { Capacitor, Filesystem, Directory, toast, useState, useEffect, useSyncExternalStore, createElement };
