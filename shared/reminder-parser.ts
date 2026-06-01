/**
 * 自然语言提醒解析器 — 服务端直接创建定时任务，不依赖 Agent
 *
 * 支持格式：
 *   "3点提醒我开会"           → 今天15:00（已过则明天）
 *   "今天3点提醒我开会"        → 今天15:00
 *   "明天上午9点提醒我开会"     → 明天09:00
 *   "下午3点半提醒我开会"       → 今天15:30
 *   "每天8点提醒我打卡"        → cron 0 8 * * *
 *   "14:30提醒我开会"          → 今天14:30
 *   "3点45分提醒我开会"        → 今天15:45
 */

import type { CronSchedule } from './scheduler.js';

export type ReminderParseResult = {
	schedule: CronSchedule;
	deleteAfterRun: boolean;
	taskName: string;
	taskMessage: string;
	timeDesc: string;
	/** 当用户未指定日期且时间已过时，自动推到明天 */
	autoPostponed?: boolean;
};

const CN_DIGITS: Record<string, number> = {
	'零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5,
	'六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
	'十一': 11, '十二': 12,
};

function parseCnNumber(s: string): number {
	if (/^\d+$/.test(s)) return parseInt(s, 10);
	if (CN_DIGITS[s] !== undefined) return CN_DIGITS[s]!;
	if (s.startsWith('十')) {
		const rest = s.slice(1);
		return 10 + (rest ? (CN_DIGITS[rest] ?? 0) : 0);
	}
	const tens = CN_DIGITS[s[0]!];
	if (tens !== undefined && s[1] === '十') {
		const ones = s[2] ? (CN_DIGITS[s[2]!] ?? 0) : 0;
		return tens * 10 + ones;
	}
	return NaN;
}

const TIME_PERIOD_OFFSET: Record<string, (h: number) => number> = {
	'凌晨': (h) => h,
	'上午': (h) => h,
	'早上': (h) => h,
	'早': (h) => h,
	'am': (h) => h,
	'中午': (h) => (h < 12 ? 12 : h),
	'下午': (h) => (h < 12 ? h + 12 : h),
	'晚上': (h) => (h < 12 ? h + 12 : h),
	'晚': (h) => (h < 12 ? h + 12 : h),
	'pm': (h) => (h < 12 ? h + 12 : h),
};

// 中文日期偏移
const DAY_OFFSETS: Record<string, number> = {
	'今天': 0, '今日': 0, '今晚': 0,
	'明天': 1, '明日': 1,
	'后天': 2, '后日': 2,
	'大后天': 3,
};

/**
 * 主正则：覆盖绝大多数自然语言提醒格式
 *
 * 结构：[日期前缀]? [时段]? 时:分 [提醒|通知]我? 内容
 *
 * 匹配示例：
 *   "3点提醒我开会"
 *   "今天下午3点半提醒我开会"
 *   "明天9:30提醒我开会"
 *   "每天8点提醒我打卡"
 *   "14:30提醒我看报告"
 *   "晚上10点提醒我吃药"
 *   "3点45提醒我开会"
 */
const REMINDER_REGEX = new RegExp(
	'^' +
	// group 1: 日期前缀（今天/明天/后天/每天/每日）
	'(?:(今天|今日|今晚|明天|明日|后天|后日|大后天|每天|每日)\\s*)?' +
	// group 2: 时段（凌晨/上午/下午/晚上/中午）
	'(?:(凌晨|上午|早上|早|中午|下午|晚上|晚|am|pm)\\s*)?' +
	// group 3: 小时 (数字或中文)
	'(\\d{1,2}|[一二两三四五六七八九十]+)' +
	// group 4+5: 分钟部分，多种格式
	'(?:' +
		'[点时:：](\\d{1,2}|[一二三四五六七八九十]+|半)(?:分钟?)?|' +  // group 4: "X点Y分" / "X:Y" / "X点半"
		'(?:点|时)' +  // 纯 "X点" / "X时"，无分钟
	')' +
	'\\s*' +
	// group 5: 动词
	'(?:提醒|通知|告诉|叫)\\s*(?:我)?\\s*' +
	// group 6: 提醒内容
	'(.+)$',
	'i'
);

// 额外匹配 "HH:MM 提醒我 XXX" 格式（纯24小时制）
const TIME_COLON_REGEX = /^(?:(今天|今日|明天|明日|后天|后日|大后天|每天|每日)\s*)?(\d{1,2}):(\d{1,2})\s*(?:提醒|通知|告诉|叫)\s*(?:我)?\s*(.+)$/i;

/**
 * 解析自然语言提醒文本
 * @returns null 表示未识别到提醒格式
 */
export function parseReminder(text: string): ReminderParseResult | null {
	// 先尝试 HH:MM 格式
	const colonMatch = text.match(TIME_COLON_REGEX);
	if (colonMatch) {
		const dayPrefix = colonMatch[1] || '';
		const hour = parseInt(colonMatch[2]!, 10);
		const minute = parseInt(colonMatch[3]!, 10);
		const taskMessage = colonMatch[4]!.trim();
		return buildResult(dayPrefix, '', hour, minute, taskMessage);
	}

	const m = text.match(REMINDER_REGEX);
	if (!m) return null;

	const dayPrefix = m[1] || '';
	const period = m[2] || '';
	const hourRaw = m[3]!;
	const minRaw = m[4] || '';
	const taskMessage = (m[5] || '').trim();

	if (!taskMessage) return null;

	let hour = parseCnNumber(hourRaw);
	if (isNaN(hour) || hour < 0 || hour > 23) return null;

	let minute = 0;
	if (minRaw === '半') {
		minute = 30;
	} else if (minRaw) {
		minute = parseCnNumber(minRaw);
		if (isNaN(minute)) minute = 0;
	}
	minute = Math.min(59, Math.max(0, minute));

	// 时段修正
	const effectivePeriod = period || (dayPrefix === '今晚' ? '晚上' : '');
	if (effectivePeriod) {
		const key = effectivePeriod.toLowerCase();
		const fn = TIME_PERIOD_OFFSET[key];
		if (fn) hour = fn(hour);
	} else if (hour >= 1 && hour <= 5) {
		// 1-5 点且无时段/日期暗示 → 推断为下午
		// "3点提醒我" → 15:00（符合日常对话习惯）
		// 6点不自动推断，因为"早上6点提醒我起床"很常见
		hour += 12;
	}

	hour = Math.min(23, Math.max(0, hour));

	return buildResult(dayPrefix, period, hour, minute, taskMessage);
}

function buildResult(
	dayPrefix: string,
	_period: string,
	hour: number,
	minute: number,
	taskMessage: string,
): ReminderParseResult | null {
	const timeStr = `${hour}:${String(minute).padStart(2, '0')}`;

	// 每天/每日 → cron
	if (dayPrefix === '每天' || dayPrefix === '每日') {
		return {
			schedule: { kind: 'cron', expr: `${minute} ${hour} * * *`, tz: 'Asia/Shanghai' },
			deleteAfterRun: false,
			taskName: '每日提醒',
			taskMessage,
			timeDesc: `每天 ${timeStr}`,
		};
	}

	// 一次性提醒
	const now = new Date();
	const target = new Date();
	target.setHours(hour, minute, 0, 0);
	let autoPostponed = false;

	if (dayPrefix && DAY_OFFSETS[dayPrefix] !== undefined) {
		const offset = DAY_OFFSETS[dayPrefix]!;
		target.setDate(target.getDate() + offset);
		if (offset === 0 && target.getTime() <= now.getTime()) {
			target.setDate(target.getDate() + 1);
			autoPostponed = true;
		}
	} else {
		if (target.getTime() <= now.getTime()) {
			target.setDate(target.getDate() + 1);
			autoPostponed = true;
		}
	}

	const dayLabel = dayPrefix || (target.getDate() === now.getDate() ? '今天' : '明天');

	return {
		schedule: { kind: 'at', at: target.toISOString() },
		deleteAfterRun: true,
		taskName: `${dayLabel}${timeStr}提醒`,
		taskMessage,
		timeDesc: `${dayLabel} ${timeStr}`,
		autoPostponed,
	};
}
