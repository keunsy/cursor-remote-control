/**
 * Runtime singleton - 简化版本，不依赖 openclaw/plugin-sdk
 */

export interface PluginRuntime {
	log: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
}

let runtime: PluginRuntime | null = null;

export function setFeishuRuntime(next: PluginRuntime) {
	runtime = next;
}

export function getFeishuRuntime(): PluginRuntime {
	if (!runtime) {
		return { log: console.log, error: console.error };
	}
	return runtime;
}
