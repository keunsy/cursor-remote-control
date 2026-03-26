#!/usr/bin/env bun

/**
 * Telegram Bot 连接测试工具
 * 用途：快速验证 Bot Token 是否有效
 */

import TelegramBot from 'node-telegram-bot-api';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ENV_PATH = resolve(import.meta.dirname, '.env');

if (!existsSync(ENV_PATH)) {
	console.error('❌ .env 文件不存在');
	console.error('💡 请复制 .env.example 并填入 TELEGRAM_BOT_TOKEN');
	process.exit(1);
}

const raw = readFileSync(ENV_PATH, 'utf-8');
let token = '';

for (const line of raw.split('\n')) {
	const trimmed = line.trim();
	if (trimmed.startsWith('TELEGRAM_BOT_TOKEN=')) {
		token = trimmed.split('=')[1]?.replace(/['"]/g, '').trim() || '';
		break;
	}
}

if (!token || token === 'your_bot_token_here') {
	console.error('❌ TELEGRAM_BOT_TOKEN 未配置或无效');
	console.error('💡 请在 .env 中设置有效的 Bot Token');
	process.exit(1);
}

console.log('🔍 测试 Telegram Bot 连接...\n');

const bot = new TelegramBot(token, { polling: false });

bot.getMe()
	.then((info) => {
		console.log('✅ Bot 连接成功！\n');
		console.log('📋 Bot 信息:');
		console.log(`  ID: ${info.id}`);
		console.log(`  用户名: @${info.username}`);
		console.log(`  名称: ${info.first_name}`);
		console.log(`  是否 Bot: ${info.is_bot ? '是' : '否'}`);
		console.log('\n💡 下一步:');
		console.log('  1. 在 Telegram 中搜索 @' + info.username);
		console.log('  2. 发送 /start 开始对话');
		console.log('  3. 运行 bun run server.ts 启动服务');
		process.exit(0);
	})
	.catch((err) => {
		console.error('❌ Bot 连接失败！\n');
		console.error('错误信息:', err.message);
		console.error('\n💡 可能的原因:');
		console.error('  1. Token 格式错误');
		console.error('  2. Token 已失效');
		console.error('  3. 网络连接问题');
		console.error('\n请检查 .env 中的 TELEGRAM_BOT_TOKEN 是否正确');
		process.exit(1);
	});
