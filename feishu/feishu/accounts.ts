/**
 * Feishu 账号管理 - 简化版本
 * 我们只使用单账号，所以大幅简化。
 */

import type { ClawdbotConfig } from "./sdk-shim.js";
import type { FeishuConfig, FeishuDomain, ResolvedFeishuAccount } from "./types.js";

const DEFAULT_ACCOUNT_ID = "default";

export function resolveFeishuAccount(params: {
	cfg: ClawdbotConfig;
	accountId?: string | null;
}): ResolvedFeishuAccount {
	const feishuCfg = (params.cfg as Record<string, unknown>).channels as Record<string, unknown> | undefined;
	const merged = (feishuCfg?.feishu ?? {}) as FeishuConfig;

	const appId = merged.appId?.trim();
	const appSecret = merged.appSecret?.trim();

	return {
		accountId: params.accountId || DEFAULT_ACCOUNT_ID,
		enabled: Boolean(appId && appSecret),
		configured: Boolean(appId && appSecret),
		appId: appId,
		appSecret: appSecret,
		domain: (merged.domain as FeishuDomain) ?? "feishu",
		config: merged,
	};
}

export function listEnabledFeishuAccounts(cfg: ClawdbotConfig): ResolvedFeishuAccount[] {
	const account = resolveFeishuAccount({ cfg });
	return account.enabled ? [account] : [];
}
