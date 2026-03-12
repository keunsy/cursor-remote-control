/**
 * 飞书模块类型定义 - 自包含版本
 */

import type { MentionTarget } from "./mention.js";

export type FeishuDomain = "feishu" | "lark" | (string & {});
export type FeishuConnectionMode = "websocket" | "webhook";

export type FeishuConfig = {
	appId?: string;
	appSecret?: string;
	encryptKey?: string;
	verificationToken?: string;
	enabled?: boolean;
	domain?: FeishuDomain;
	connectionMode?: FeishuConnectionMode;
	dmPolicy?: string;
	groupPolicy?: string;
	allowFrom?: string[];
	groupAllowFrom?: string[];
	requireMention?: boolean;
	topicSessionMode?: boolean;
	historyLimit?: number;
	mediaMaxMb?: number;
	renderMode?: "auto" | "raw" | "card";
	streaming?: boolean;
	tableMode?: string;
	textChunkLimit?: number;
	chunkMode?: string;
	groups?: Record<string, FeishuGroupConfig>;
	accounts?: Record<string, FeishuAccountConfig>;
	tools?: Record<string, boolean>;
};

export type FeishuGroupConfig = {
	requireMention?: boolean;
	allowFrom?: string[];
	systemPrompt?: string;
	topicSessionMode?: boolean;
	tools?: { allow?: string[]; deny?: string[] };
};

export type FeishuAccountConfig = FeishuConfig & {
	name?: string;
};

export type ResolvedFeishuAccount = {
	accountId: string;
	enabled: boolean;
	configured: boolean;
	name?: string;
	appId?: string;
	appSecret?: string;
	encryptKey?: string;
	verificationToken?: string;
	domain: FeishuDomain;
	config: FeishuConfig;
};

export type FeishuIdType = "open_id" | "user_id" | "union_id" | "chat_id";

export type FeishuMessageContext = {
	chatId: string;
	messageId: string;
	senderId: string;
	senderOpenId: string;
	senderName?: string;
	chatType: "p2p" | "group";
	mentionedBot: boolean;
	rootId?: string;
	parentId?: string;
	content: string;
	contentType: string;
	mentionTargets?: MentionTarget[];
	mentionMessageBody?: string;
};

export type FeishuSendResult = {
	messageId: string;
	chatId: string;
};

export type FeishuProbeResult = {
	ok: boolean;
	error?: string;
	appId?: string;
	botName?: string;
	botOpenId?: string;
};

export type FeishuMediaInfo = {
	path: string;
	contentType?: string;
	placeholder: string;
};

export type DynamicAgentCreationConfig = {
	enabled?: boolean;
	workspaceTemplate?: string;
	agentDirTemplate?: string;
	maxAgents?: number;
};
