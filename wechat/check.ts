#!/usr/bin/env bun

/**
 * 微信模块环境检查脚本
 * 
 * 用途：检查依赖、配置、网络连通性
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ENV_PATH = resolve(import.meta.dirname, '.env');
const TOKEN_FILE = resolve(import.meta.dirname, '.wechat_token.json');
const WECHAT_BASE_URL = 'https://ilinkai.weixin.qq.com';

console.log('🔍 微信模块环境检查\n');
console.log('='.repeat(60));

// 1. 检查 .env 文件
console.log('\n1️⃣ 检查配置文件');
if (existsSync(ENV_PATH)) {
	console.log('   ✅ .env 文件存在');
	
	const content = readFileSync(ENV_PATH, 'utf-8');
	const hasApiKey = /CURSOR_API_KEY=\S+/.test(content) && !content.includes('your_');
	const hasModel = /CURSOR_MODEL=\S+/.test(content);
	
	if (hasApiKey) {
		console.log('   ✅ CURSOR_API_KEY 已配置');
	} else {
		console.log('   ⚠️  CURSOR_API_KEY 未配置（推荐使用 agent login）');
	}
	
	if (hasModel) {
		console.log('   ✅ CURSOR_MODEL 已配置');
	} else {
		console.log('   ℹ️  CURSOR_MODEL 未配置（将使用默认模型）');
	}
} else {
	console.log('   ❌ .env 文件不存在');
	console.log('   💡 运行: cp .env.example .env');
	process.exit(1);
}

// 2. 检查 Token 文件
console.log('\n2️⃣ 检查登录状态');
if (existsSync(TOKEN_FILE)) {
	try {
		const tokenData = JSON.parse(readFileSync(TOKEN_FILE, 'utf-8'));
		console.log('   ✅ 已有登录凭证');
		console.log(`   📅 保存时间: ${tokenData.savedAt || '未知'}`);
		console.log(`   🆔 账号ID: ${tokenData.accountId || '未知'}`);
	} catch (e) {
		console.log('   ⚠️  Token 文件损坏，需要重新登录');
	}
} else {
	console.log('   ℹ️  未登录，首次启动需要扫码');
}

// 3. 检查网络连通性
console.log('\n3️⃣ 检查网络连通性');
try {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 5000);
	
	const res = await fetch(`${WECHAT_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`, {
		signal: controller.signal
	});
	clearTimeout(timer);
	
	if (res.ok) {
		console.log('   ✅ 微信 API 可以访问');
		const data = (await res.json()) as { qrcode?: string };
		if (data.qrcode) {
			console.log('   ✅ API 响应正常');
		}
	} else {
		console.log(`   ⚠️  API 返回错误: ${res.status}`);
	}
} catch (e: any) {
	if (e.name === 'AbortError') {
		console.log('   ❌ 网络超时（5秒）');
	} else if (e.code === 'ENOTFOUND') {
		console.log('   ❌ 无法解析域名 ilinkai.weixin.qq.com');
		console.log('   💡 检查网络连接或 DNS 设置');
	} else {
		console.log(`   ❌ 网络错误: ${e.message}`);
	}
	process.exit(1);
}

// 4. 检查依赖
console.log('\n4️⃣ 检查依赖包');
try {
	await import('qrcode-terminal');
	console.log('   ✅ qrcode-terminal 已安装');
} catch {
	console.log('   ❌ qrcode-terminal 未安装');
	console.log('   💡 运行: bun install');
	process.exit(1);
}

// 5. 总结
console.log('\n' + '='.repeat(60));
console.log('✅ 环境检查完成！可以启动服务：');
console.log('   bun run start.ts');
console.log('='.repeat(60) + '\n');
