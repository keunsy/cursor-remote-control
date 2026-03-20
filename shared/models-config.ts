/**
 * 模型配置库 — 支持别名、fallback 链、模型优先级
 * 
 * 设计目标：
 * 1. 统一模型定义（三平台共享）
 * 2. 支持缩略名称快速切换（opus → opus-4.6-thinking）
 * 3. 失败自动 fallback（第一个模型失败，尝试下一个）
 * 4. 集中管理（新增模型只需改这个文件）
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ──────────────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────────────

export interface ModelConfig {
	/** 模型唯一标识（传递给 Cursor Agent CLI 的 --model 参数） */
	id: string;
	
	/** 显示名称 */
	name: string;
	
	/** 简短描述 */
	description: string;
	
	/** 缩略名称列表（用户输入任一别名都能匹配到此模型） */
	aliases: string[];
	
	/** Fallback 链：当前模型失败后尝试的模型 ID 列表（按顺序重试） */
	fallbackChain?: string[];
	
	/** 是否推荐使用（影响列表排序） */
	recommended?: boolean;
	
	/** 额外说明（显示在模型列表中） */
	note?: string;
	
	/** 是否保护（永不加入黑名单） */
	protected?: boolean;
}

interface GlobalModelConfig {
	defaultModel: string;
	blacklistResetCron: string;
	models?: ModelConfig[];
}

// ──────────────────────────────────────────────────
// 🎯 全局配置读取（从 config/model-config.json）
// ──────────────────────────────────────────────────

const ROOT = resolve(import.meta.dirname, '..');
const MODEL_CONFIG_PATH = resolve(ROOT, 'config/model-config.json');

/**
 * 读取全局模型配置（强制要求配置文件存在）
 */
function loadGlobalConfig(): GlobalModelConfig {
	if (!existsSync(MODEL_CONFIG_PATH)) {
		console.error(`[致命错误] 配置文件不存在: ${MODEL_CONFIG_PATH}`);
		console.error('请参考 config/model-config.example.json 创建配置文件');
		process.exit(1);
	}

	try {
		const content = readFileSync(MODEL_CONFIG_PATH, 'utf-8');
		const config = JSON.parse(content) as GlobalModelConfig;
		
		// 验证必需字段
		if (!config.defaultModel) {
			throw new Error('配置文件缺少 defaultModel 字段');
		}
		if (!config.models || config.models.length === 0) {
			throw new Error('配置文件缺少 models 字段或模型列表为空');
		}
		if (!config.blacklistResetCron) {
			throw new Error('配置文件缺少 blacklistResetCron 字段');
		}
		
		return config;
	} catch (err) {
		console.error(`[致命错误] 读取配置文件失败: ${MODEL_CONFIG_PATH}`);
		console.error(err);
		console.error('请检查配置文件格式是否正确（参考 config/model-config.example.json）');
		process.exit(1);
	}
}

const globalConfig = loadGlobalConfig();

/**
 * 默认使用的模型（从 config/model-config.json 读取）
 * 具体可选值请查看配置文件中的 models 列表
 */
export const DEFAULT_MODEL = globalConfig.defaultModel;

/**
 * 黑名单重置 Cron 表达式（从 config/model-config.json 读取）
 */
export const BLACKLIST_RESET_CRON = globalConfig.blacklistResetCron;

/**
 * 所有可用模型配置（从 config/model-config.json 读取）
 */
export const MODELS: ModelConfig[] = globalConfig.models || [];


/**
 * 根据用户输入查找模型
 * 
 * @param input 用户输入（可以是模型 ID、别名、编号）
 * @returns 匹配的模型配置，找不到返回 null
 */
export function findModel(input: string): ModelConfig | null {
	// 处理 null/undefined/非字符串
	if (!input || typeof input !== 'string') return null;
	
	const trimmed = input.trim().toLowerCase();
	
	// 空输入
	if (!trimmed) return null;
	
	// 按编号查找（1-based）
	// 确保是纯整数，不是小数
	const num = Number.parseInt(trimmed, 10);
	if (!Number.isNaN(num) && num.toString() === trimmed && num >= 1 && num <= MODELS.length) {
		return MODELS[num - 1] ?? null;
	}
	
	// 按 ID 或别名查找
	const found = MODELS.find(m => 
		m.id.toLowerCase() === trimmed || 
		m.aliases.some(alias => alias.toLowerCase() === trimmed)
	);
	return found ?? null;
}

/**
 * 获取模型的 fallback 链
 * 
 * @param modelId 模型 ID
 * @returns 包含自身和 fallback 的完整模型链，找不到返回空数组
 */
export function getModelChain(modelId: string): ModelConfig[] {
	const model = MODELS.find(m => m.id === modelId);
	if (!model) return [];
	
	const chain: ModelConfig[] = [model];
	
	if (model.fallbackChain && model.fallbackChain.length > 0) {
		for (const fallbackId of model.fallbackChain) {
			const fallback = MODELS.find(m => m.id === fallbackId);
			if (fallback) chain.push(fallback);
		}
	}
	
	return chain;
}

/**
 * 格式化模型列表（供用户查看）
 * 
 * @param currentModelId 当前使用的模型 ID
 * @returns Markdown 格式的模型列表
 */
export function formatModelList(currentModelId: string): string {
	const lines: string[] = [];
	const { models: blacklisted } = getBlacklistStatus();
	
	MODELS.forEach((m, i) => {
		const isCurrent = m.id === currentModelId;
		const inBlacklist = blacklisted.includes(m.id);
		
		// 标记：当前 ✅ / 配额用尽 🚫
		let mark = '';
		if (isCurrent && inBlacklist) {
			mark = ' ✅🚫'; // 配置是它，但被跳过
		} else if (isCurrent) {
			mark = ' ✅';
		} else if (inBlacklist) {
			mark = ' 🚫';
		}
		
		const prefix = isCurrent ? '**' : '';
		const suffix = mark ? `${mark}**` : '';
		const note = m.note ? `\n   ${m.note}` : '';
		const aliases = m.aliases.slice(0, 3).map(a => `\`${a}\``).join(' / ');
		
		lines.push(
			`${prefix}${i + 1}. ${m.name}${suffix}`,
			`   ${aliases}`,
			note,
		);
	});
	
	// 如果有黑名单，添加说明
	if (blacklisted.length > 0) {
		lines.push('', '---');
		lines.push('', '🚫 = 配额用尽（已加入黑名单，自动跳过）');
		lines.push('✅🚫 = 配置当前模型，但会自动切换到备用模型');
	}
	
	lines.push('', '**用法：**');
	lines.push('· `/模型` — 查看所有模型');
	lines.push('· `/模型 编号` — 如 `/模型 1`');
	lines.push('· `/模型 名称` — 如 `/模型 opus`');
	lines.push('· `/模型 别名` — 如 `/模型 o`');
	
	return `**可用模型（共 ${MODELS.length} 个）**\n\n${lines.join('\n')}`;
}

/**
 * 检测是否应在模型链上继续 fallback（最终由配置保证会尝试 `auto`）
 *
 * 策略：凡属于「Agent/模型/上游 API」类失败则重试；明确与模型无关的本机/并发问题不重试。
 *
 * @param error 错误对象或错误消息
 * @returns 是否需要 fallback
 */
export function shouldFallback(error: Error | string): boolean {
	const raw = error instanceof Error ? error.message : error;
	const msg = raw.toLowerCase();

	// ── 明确不应换模型重试（与模型/配额无关）────────────────
	if (msg.includes('并发任务数已达上限')) return false;
	if (msg.includes('agent cli 启动失败')) return false;
	if (msg.includes('agent 进程启动失败')) return false;

	// Cursor Agent 非 0 退出：stderr 内多为模型/API/用量错误，统一允许走 fallback 直至 auto
	if (msg.includes('agent exited with code')) return true;

	// 配额相关错误（与 isQuotaExhausted 大部分对齐）
	if (
		msg.includes('quota') ||
		msg.includes('rate limit') ||
		msg.includes('usage limit') ||
		msg.includes('reached its usage limit') ||
		msg.includes('配额') ||
		msg.includes('balance') || // insufficient balance
		msg.includes('credit') || // insufficient credit
		msg.includes('余额')
	) {
		return true;
	}

	// 团队/订阅类（常见于 Cursor 用量提示）
	if (
		msg.includes('contact your team admin') ||
		msg.includes('team has reached') ||
		msg.includes('subscription') ||
		msg.includes('billing') ||
		msg.includes('upgrade your plan')
	) {
		return true;
	}

	// 权限/认证错误
	if (
		msg.includes('unauthorized') ||
		msg.includes('forbidden') ||
		msg.includes('permission') || // permission denied
		msg.includes('invalid api key') ||
		msg.includes('401') ||
		msg.includes('403')
	) {
		return true;
	}

	// 上游不可用 / 过载
	if (
		msg.includes('429') ||
		msg.includes('502') ||
		msg.includes('503') ||
		msg.includes('504') ||
		msg.includes('bad gateway') ||
		msg.includes('service unavailable') ||
		msg.includes('overloaded') ||
		msg.includes('capacity')
	) {
		return true;
	}

	// 模型不可用 / 参数错误
	if (
		msg.includes('model not available') ||
		msg.includes('model not found') ||
		msg.includes('invalid model') ||
		msg.includes('unknown model') ||
		msg.includes('unsupported model')
	) {
		return true;
	}

	// 超时错误（可能是模型过载）
	if (msg.includes('timeout') || msg.includes('超时')) {
		return true;
	}

	return false;
}

/**
 * 检测错误是否为配额用尽（需要加入黑名单）
 * 
 * @param error 错误对象或错误消息
 * @returns 是否为配额用尽错误
 */
export function isQuotaExhausted(error: Error | string): boolean {
	const msg = (error instanceof Error ? error.message : error).toLowerCase();

	return (
		msg.includes('quota') ||
		msg.includes('balance') || // insufficient balance
		msg.includes('credit') || // insufficient credit
		msg.includes('余额') ||
		msg.includes('配额') ||
		msg.includes('rate limit') ||
		msg.includes('usage limit') ||
		msg.includes('reached its usage limit') ||
		msg.includes('team has reached') ||
		msg.includes('contact your team admin')
	);
}

// ──────────────────────────────────────────────────
// 模型黑名单管理（配额用尽的模型）
// ──────────────────────────────────────────────────

interface ModelBlacklist {
	/** 黑名单中的模型 ID */
	models: string[];
	/** 加入黑名单的时间戳 */
	addedAt: Record<string, number>;
	/** 下次重置时间（UTC timestamp） */
	nextResetTime: number;
}

/** 黑名单存储路径 */
const BLACKLIST_PATH = `${process.env.HOME}/.cursor/model-blacklist.json`;

/** 黑名单配置 */
export interface BlacklistConfig {
	/** 重置日期（1-31），默认每月1号 */
	resetDay?: number;
	/** 重置小时（0-23），默认 00:00 */
	resetHour?: number;
}

/** 全局配置（可通过环境变量或配置文件覆盖） */
let blacklistConfig: BlacklistConfig = {
	resetDay: 1,    // 每月1号
	resetHour: 0,   // 00:00
};

/** 全局黑名单实例 */
let blacklist: ModelBlacklist = loadBlacklist();

/**
 * 设置黑名单配置（重置时间）
 * 
 * @param config 配置选项
 */
export function configureBlacklist(config: BlacklistConfig): void {
	blacklistConfig = { ...blacklistConfig, ...config };
	console.log(`[模型黑名单] 配置已更新: 每月${config.resetDay || 1}号 ${config.resetHour || 0}:00 重置`);
}

/**
 * 加载黑名单（启动时调用）
 */
function loadBlacklist(): ModelBlacklist {
	try {
		const fs = require('node:fs');
		if (fs.existsSync(BLACKLIST_PATH)) {
			const data = JSON.parse(fs.readFileSync(BLACKLIST_PATH, 'utf-8'));
			
			// 检查是否需要自动重置
			const now = Date.now();
			if (now >= data.nextResetTime) {
				console.log(`[模型黑名单] 已到重置时间，清空黑名单`);
				return createFreshBlacklist();
			}
			
			return data;
		}
	} catch (err) {
		console.error('[模型黑名单] 加载失败:', err);
	}
	
	return createFreshBlacklist();
}

/**
 * 创建新的黑名单（计算下次重置时间）
 */
function createFreshBlacklist(): ModelBlacklist {
	const nextReset = calculateNextResetTime();
	return {
		models: [],
		addedAt: {},
		nextResetTime: nextReset,
	};
}

/**
 * 计算下次重置时间（根据配置）
 */
function calculateNextResetTime(): number {
	const now = new Date();
	const resetDay = blacklistConfig.resetDay || 1;
	const resetHour = blacklistConfig.resetHour || 0;
	
	// 获取当前月份的重置日期
	const nextReset = new Date(now.getFullYear(), now.getMonth(), resetDay, resetHour, 0, 0, 0);
	
	// 如果当前已经过了重置时间，推到下个月
	if (now.getTime() >= nextReset.getTime()) {
		nextReset.setMonth(nextReset.getMonth() + 1);
	}
	
	return nextReset.getTime();
}

/**
 * 保存黑名单到磁盘
 */
function saveBlacklist(): void {
	try {
		const fs = require('node:fs');
		const dir = require('node:path').dirname(BLACKLIST_PATH);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(BLACKLIST_PATH, JSON.stringify(blacklist, null, 2), 'utf-8');
	} catch (err) {
		console.error('[模型黑名单] 保存失败:', err);
	}
}

/**
 * 将模型加入黑名单
 * 
 * ⚠️ 重要：auto 模型有硬编码保护，永远不会被加入黑名单
 * 
 * @param modelId 模型 ID
 */
export function addToBlacklist(modelId: string): void {
	// 检查模型是否受保护（从配置文件读取 protected 字段）
	const model = MODELS.find(m => m.id === modelId);
	if (model?.protected) {
		console.log(`[模型黑名单] ${modelId} 是受保护模型，拒绝加入黑名单`);
		return;
	}
	
	if (!blacklist.models.includes(modelId)) {
		blacklist.models.push(modelId);
		blacklist.addedAt[modelId] = Date.now();
		saveBlacklist();
		
		const resetDate = new Date(blacklist.nextResetTime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
		console.log(`[模型黑名单] 已加入: ${modelId}（将在 ${resetDate} 重置）`);
	}
}

/**
 * 检查模型是否在黑名单中
 * 
 * @param modelId 模型 ID
 * @returns 是否在黑名单中
 */
export function isBlacklisted(modelId: string): boolean {
	// 检查是否到重置时间
	if (Date.now() >= blacklist.nextResetTime) {
		console.log('[模型黑名单] 到达重置时间，自动清空');
		blacklist = createFreshBlacklist();
		saveBlacklist();
		return false;
	}
	
	return blacklist.models.includes(modelId);
}

/**
 * 手动重置黑名单（清空所有记录）
 */
export function resetBlacklist(): void {
	blacklist = createFreshBlacklist();
	saveBlacklist();
	console.log('[模型黑名单] 已手动重置');
}

/**
 * 获取黑名单状态（供用户查看）
 */
export function getBlacklistStatus(): {
	models: string[];
	nextResetTime: number;
	nextResetDate: string;
} {
	return {
		models: [...blacklist.models],
		nextResetTime: blacklist.nextResetTime,
		nextResetDate: new Date(blacklist.nextResetTime).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
	};
}

/**
 * 获取可用的模型链（自动过滤黑名单）
 * 
 * @param modelId 模型 ID
 * @returns 过滤后的模型链（不包含黑名单中的模型）
 */
export function getAvailableModelChain(modelId: string): ModelConfig[] {
	const fullChain = getModelChain(modelId);
	const available = fullChain.filter(m => !isBlacklisted(m.id));

	// 如果主模型在黑名单中，记录日志
	const firstModel = fullChain[0];
	if (firstModel && isBlacklisted(firstModel.id)) {
		console.log(`[智能跳过] ${firstModel.id} 在黑名单中，直接使用 fallback`);
	}

	// 保证链末端总有一次 `auto`（配置中存在且未在链中、且未黑名单时），满足「模型类错误最终可切换到 auto」
	const autoModel = MODELS.find(m => m.id === 'auto');
	if (
		autoModel &&
		!available.some(m => m.id === 'auto') &&
		!isBlacklisted('auto')
	) {
		return [...available, autoModel];
	}

	return available;
}
