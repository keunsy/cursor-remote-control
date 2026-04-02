/**
 * 微信媒体处理模块
 * 从 OpenClaw 官方插件提取，去除框架依赖，适配独立服务
 * 
 * 功能：
 * - CDN 图片/视频/文件下载与 AES-128-ECB 解密
 * - CDN 上传与 AES-128-ECB 加密
 * - 自动计算 MD5、文件大小
 */

import crypto from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';

// ═══════════════════════════════════════════════════
// AES-128-ECB 加解密（从官方插件提取）
// ═══════════════════════════════════════════════════

/** 加密：AES-128-ECB with PKCS7 padding */
export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
	const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
	return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** 解密：AES-128-ECB with PKCS7 padding */
export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
	const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** 计算 AES-128-ECB 加密后的密文大小（PKCS7 padding 到 16 字节边界） */
export function aesEcbPaddedSize(plaintextSize: number): number {
	return Math.ceil((plaintextSize + 1) / 16) * 16;
}

// ═══════════════════════════════════════════════════
// CDN 下载与解密
// ═══════════════════════════════════════════════════

/**
 * 从微信 CDN 下载并解密图片/视频/文件
 * 
 * @param encryptQueryParam - CDN 下载加密参数
 * @param fullUrl - 完整下载 URL（可选，优先使用）
 * @param aesKeyBase64 - Base64 编码的 AES-128 密钥
 * @param cdnBaseUrl - CDN 基础 URL（如 https://novac2c.cdn.weixin.qq.com/c2c）
 * @param saveDir - 保存目录
 * @param label - 日志标签（如 "image", "video"）
 * @returns 本地文件路径，失败返回 null
 */
export async function downloadAndDecryptMedia(params: {
	encryptQueryParam?: string;
	fullUrl?: string;
	aesKeyBase64?: string;
	cdnBaseUrl: string;
	saveDir: string;
	label: string;
	extension?: string;
}): Promise<string | null> {
	const { encryptQueryParam, fullUrl, aesKeyBase64, cdnBaseUrl, saveDir, label, extension = 'bin' } = params;

	// 构造下载 URL
	const url = fullUrl || (encryptQueryParam ? `${cdnBaseUrl}?${encryptQueryParam}` : null);
	if (!url) {
		console.error(`[媒体/${label}] 无下载 URL`);
		return null;
	}

	try {
		console.log(`[媒体/${label}] 下载: ${url.slice(0, 100)}...`);
		
		const res = await fetch(url);
		if (!res.ok) {
			const body = await res.text().catch(() => '(unreadable)');
			console.error(`[媒体/${label}] CDN 下载失败: ${res.status} ${res.statusText} body=${body}`);
			return null;
		}

		let buffer = Buffer.from(await res.arrayBuffer()) as Buffer;
		console.log(`[媒体/${label}] 已下载 ${buffer.length} bytes`);

		// 如果有 AES key，解密
		if (aesKeyBase64) {
			const aesKey = Buffer.from(aesKeyBase64, 'base64');
			buffer = decryptAesEcb(buffer, aesKey);
			console.log(`[媒体/${label}] 已解密 ${buffer.length} bytes`);
		}

		// 保存到本地
		mkdirSync(saveDir, { recursive: true });
		const filename = `weixin-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${extension}`;
		const filepath = pathResolve(saveDir, filename);
		writeFileSync(filepath, buffer);

		console.log(`[媒体/${label}] 已保存: ${filepath}`);
		return filepath;
	} catch (err) {
		console.error(`[媒体/${label}] 下载解密失败:`, err);
		return null;
	}
}

// ═══════════════════════════════════════════════════
// CDN 上传与加密
// ═══════════════════════════════════════════════════

/**
 * 上传图片到微信 CDN（加密）
 * 
 * 步骤：
 * 1. 读取本地文件，计算 MD5 和大小
 * 2. 生成随机 AES-128 key
 * 3. 调用 getuploadurl 获取上传 URL
 * 4. 加密文件
 * 5. PUT 上传到 CDN
 * 6. 返回下载参数和密钥
 */
export async function uploadImageToCdn(params: {
	filePath: string;
	toUserId: string;
	token: string;
	baseUrl: string;
	cdnBaseUrl: string;
}): Promise<{
	filekey: string;
	downloadParam: string;
	aeskeyBase64: string;
	fileSize: number;
	fileSizeCiphertext: number;
} | null> {
	const { filePath, toUserId, token, baseUrl, cdnBaseUrl } = params;

	try {
		// 1. 读取文件并计算哈希
		let plaintext: Buffer;
		try {
			plaintext = readFileSync(filePath);
		} catch (err) {
			console.error(`[媒体/上传] 文件读取失败: ${filePath}`, err);
			return null;
		}
		
		const rawsize = plaintext.length;
		
		// 微信官方限制（与 OpenClaw 插件一致）
		const MAX_MEDIA_SIZE = 100 * 1024 * 1024; // 100MB
		if (rawsize > MAX_MEDIA_SIZE) {
			console.error(`[媒体/上传] 文件过大: ${rawsize} bytes (限制: ${MAX_MEDIA_SIZE} bytes)`);
			return null;
		}
		const rawfilemd5 = crypto.createHash('md5').update(plaintext).digest('hex');
		const filesize = aesEcbPaddedSize(rawsize);
		const filekey = crypto.randomBytes(16).toString('hex');
		const aeskey = crypto.randomBytes(16);

		console.log(`[媒体/上传] 文件: ${filePath}`);
		console.log(`[媒体/上传] 原文件: ${rawsize} bytes, MD5: ${rawfilemd5}`);
		console.log(`[媒体/上传] 密文: ${filesize} bytes, filekey: ${filekey}`);

		// 2. 调用 getuploadurl 获取上传参数
		const uploadUrlRes = await fetch(`${baseUrl}/getuploadurl`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'AuthorizationType': 'ilink_bot_token',
				'Authorization': `Bearer ${token}`,
				'X-WECHAT-UIN': Buffer.from(String(Math.floor(Math.random() * 0xFFFFFFFF))).toString('base64'),
			},
			body: JSON.stringify({
				filekey,
				media_type: 1, // 1=IMAGE, 2=VIDEO, 3=FILE
				to_user_id: toUserId,
				rawsize,
				rawfilemd5,
				filesize,
				no_need_thumb: true,
				aeskey: aeskey.toString('hex'),
			}),
		});

		if (!uploadUrlRes.ok) {
			console.error(`[媒体/上传] getuploadurl 失败: ${uploadUrlRes.status} ${uploadUrlRes.statusText}`);
			const errorText = await uploadUrlRes.text();
			console.error(`[媒体/上传] 错误响应: ${errorText}`);
			return null;
		}

		const uploadData = await uploadUrlRes.json() as { upload_param?: string; upload_full_url?: string };
		const uploadParam = uploadData.upload_param;
		const uploadFullUrl = uploadData.upload_full_url;

		if (!uploadParam && !uploadFullUrl) {
			console.error('[媒体/上传] 未获取到上传 URL');
			return null;
		}

		console.log(`[媒体/上传] 已获取上传参数`);

		// 3. 加密文件
		const encrypted = encryptAesEcb(plaintext, aeskey);
		console.log(`[媒体/上传] 已加密: ${encrypted.length} bytes`);

		// 4. 上传到 CDN（3 次重试，与官方一致）
		const cdnUrl = uploadFullUrl || `${cdnBaseUrl}?${uploadParam}`;
		const MAX_RETRIES = 3;
		let downloadParam: string | null = null;
		
		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			try {
				const cdnRes = await fetch(cdnUrl, {
					method: 'POST',
					body: new Uint8Array(encrypted),
					headers: {
						'Content-Type': 'application/octet-stream',
					},
				});

				// 4xx 客户端错误，不重试
				if (cdnRes.status >= 400 && cdnRes.status < 500) {
					const errMsg = cdnRes.headers.get('x-error-message') || await cdnRes.text();
					console.error(`[媒体/上传] 客户端错误 ${cdnRes.status}: ${errMsg}`);
					return null;
				}

				// 5xx 服务端错误，重试
				if (cdnRes.status !== 200) {
					const errMsg = cdnRes.headers.get('x-error-message') || `status ${cdnRes.status}`;
					console.error(`[媒体/上传] 服务端错误（尝试 ${attempt}/${MAX_RETRIES}）: ${errMsg}`);
					if (attempt === MAX_RETRIES) return null;
					continue; // 重试
				}

				// 成功：从响应头获取下载参数
				downloadParam = cdnRes.headers.get('x-encrypted-param');
				if (!downloadParam) {
					console.error(`[媒体/上传] CDN 响应缺少 x-encrypted-param 头（尝试 ${attempt}/${MAX_RETRIES}）`);
					if (attempt === MAX_RETRIES) return null;
					continue; // 重试
				}

				console.log(`[媒体/上传] CDN 上传成功（尝试 ${attempt}）`);
				break;
			} catch (err) {
				console.error(`[媒体/上传] 上传异常（尝试 ${attempt}/${MAX_RETRIES}）:`, err);
				if (attempt === MAX_RETRIES) return null;
			}
		}

		if (!downloadParam) {
			console.error('[媒体/上传] 所有重试失败');
			return null;
		}

		return {
			filekey,
			downloadParam,
			aeskeyBase64: aeskey.toString('base64'),
			fileSize: rawsize,
			fileSizeCiphertext: filesize,
		};
	} catch (err) {
		console.error('[媒体/上传] 失败:', err);
		return null;
	}
}

/**
 * 上传本地视频到微信 CDN
 * 与图片上传类似，只是 media_type=2
 */
export async function uploadVideoToCdn(params: {
	filePath: string;
	toUserId: string;
	token: string;
	baseUrl: string;
	cdnBaseUrl: string;
}): Promise<{
	filekey: string;
	downloadParam: string;
	aeskeyBase64: string;
	fileSize: number;
	fileSizeCiphertext: number;
} | null> {
	const { filePath, toUserId, token, baseUrl, cdnBaseUrl } = params;

	try {
		// 1. 读取文件并计算哈希
		let plaintext: Buffer;
		try {
			plaintext = readFileSync(filePath);
		} catch (err) {
			console.error(`[媒体/视频上传] 文件读取失败: ${filePath}`, err);
			return null;
		}
		
		const rawsize = plaintext.length;
		const MAX_MEDIA_SIZE = 100 * 1024 * 1024; // 100MB
		if (rawsize > MAX_MEDIA_SIZE) {
			console.error(`[媒体/视频上传] 文件过大: ${rawsize} bytes (限制: ${MAX_MEDIA_SIZE} bytes)`);
			return null;
		}
		const rawfilemd5 = crypto.createHash('md5').update(plaintext).digest('hex');
		const filesize = aesEcbPaddedSize(rawsize);
		const filekey = crypto.randomBytes(16).toString('hex');
		const aeskey = crypto.randomBytes(16);

		console.log(`[媒体/视频上传] 文件: ${filePath}, 原文件: ${rawsize} bytes, 密文: ${filesize} bytes`);

		// 2. 调用 getuploadurl 获取上传参数
		const uploadUrlRes = await fetch(`${baseUrl}/getuploadurl`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'AuthorizationType': 'ilink_bot_token',
				'Authorization': `Bearer ${token}`,
				'X-WECHAT-UIN': Buffer.from(String(Math.floor(Math.random() * 0xFFFFFFFF))).toString('base64'),
			},
			body: JSON.stringify({
				filekey,
				media_type: 2, // VIDEO
				to_user_id: toUserId,
				rawsize,
				rawfilemd5,
				filesize,
				no_need_thumb: true,
				aeskey: aeskey.toString('hex'),
			}),
		});

		if (!uploadUrlRes.ok) {
			console.error(`[媒体/视频上传] getuploadurl 失败: ${uploadUrlRes.status}`);
			return null;
		}

		const uploadData = await uploadUrlRes.json() as { upload_param?: string; upload_full_url?: string };
		const uploadParam = uploadData.upload_param;
		const uploadFullUrl = uploadData.upload_full_url;

		if (!uploadParam && !uploadFullUrl) {
			console.error('[媒体/视频上传] 未获取到上传 URL');
			return null;
		}

		// 3. 加密文件
		const encrypted = encryptAesEcb(plaintext, aeskey);

		// 4. 上传到 CDN（3 次重试）
		const cdnUrl = uploadFullUrl || `${cdnBaseUrl}?${uploadParam}`;
		const MAX_RETRIES = 3;
		let downloadParam: string | null = null;
		
		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			try {
				const cdnRes = await fetch(cdnUrl, {
					method: 'POST',
					body: new Uint8Array(encrypted),
					headers: {
						'Content-Type': 'application/octet-stream',
					},
				});

				if (cdnRes.status >= 400 && cdnRes.status < 500) {
					console.error(`[媒体/视频上传] 客户端错误 ${cdnRes.status}`);
					return null;
				}

				if (cdnRes.status !== 200) {
					console.error(`[媒体/视频上传] 服务端错误（尝试 ${attempt}/${MAX_RETRIES}）: ${cdnRes.status}`);
					if (attempt === MAX_RETRIES) return null;
					continue;
				}

				downloadParam = cdnRes.headers.get('x-encrypted-param');
				if (!downloadParam) {
					console.error(`[媒体/视频上传] 缺少 x-encrypted-param（尝试 ${attempt}/${MAX_RETRIES}）`);
					if (attempt === MAX_RETRIES) return null;
					continue;
				}

				console.log(`[媒体/视频上传] 上传成功（尝试 ${attempt}）`);
				break;
			} catch (err) {
				console.error(`[媒体/视频上传] 上传异常（尝试 ${attempt}/${MAX_RETRIES}）:`, err);
				if (attempt === MAX_RETRIES) return null;
			}
		}

		if (!downloadParam) return null;

		return {
			filekey,
			downloadParam,
			aeskeyBase64: aeskey.toString('base64'),
			fileSize: rawsize,
			fileSizeCiphertext: filesize,
		};
	} catch (err) {
		console.error('[媒体/视频上传] 失败:', err);
		return null;
	}
}

/**
 * 上传本地文件到微信 CDN
 * 与图片上传类似，只是 media_type=3
 */
export async function uploadFileToCdn(params: {
	filePath: string;
	toUserId: string;
	token: string;
	baseUrl: string;
	cdnBaseUrl: string;
}): Promise<{
	filekey: string;
	downloadParam: string;
	aeskeyBase64: string;
	fileSize: number;
	fileSizeCiphertext: number;
} | null> {
	const { filePath, toUserId, token, baseUrl, cdnBaseUrl } = params;

	try {
		// 1. 读取文件并计算哈希
		let plaintext: Buffer;
		try {
			plaintext = readFileSync(filePath);
		} catch (err) {
			console.error(`[媒体/文件上传] 文件读取失败: ${filePath}`, err);
			return null;
		}
		
		const rawsize = plaintext.length;
		const MAX_MEDIA_SIZE = 100 * 1024 * 1024; // 100MB
		if (rawsize > MAX_MEDIA_SIZE) {
			console.error(`[媒体/文件上传] 文件过大: ${rawsize} bytes (限制: ${MAX_MEDIA_SIZE} bytes)`);
			return null;
		}
		const rawfilemd5 = crypto.createHash('md5').update(plaintext).digest('hex');
		const filesize = aesEcbPaddedSize(rawsize);
		const filekey = crypto.randomBytes(16).toString('hex');
		const aeskey = crypto.randomBytes(16);

		console.log(`[媒体/文件上传] 文件: ${filePath}, 原文件: ${rawsize} bytes, 密文: ${filesize} bytes`);

		// 2. 调用 getuploadurl 获取上传参数
		const uploadUrlRes = await fetch(`${baseUrl}/getuploadurl`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'AuthorizationType': 'ilink_bot_token',
				'Authorization': `Bearer ${token}`,
				'X-WECHAT-UIN': Buffer.from(String(Math.floor(Math.random() * 0xFFFFFFFF))).toString('base64'),
			},
			body: JSON.stringify({
				filekey,
				media_type: 3, // FILE
				to_user_id: toUserId,
				rawsize,
				rawfilemd5,
				filesize,
				no_need_thumb: true,
				aeskey: aeskey.toString('hex'),
			}),
		});

		if (!uploadUrlRes.ok) {
			console.error(`[媒体/文件上传] getuploadurl 失败: ${uploadUrlRes.status}`);
			return null;
		}

		const uploadData = await uploadUrlRes.json() as { upload_param?: string; upload_full_url?: string };
		const uploadParam = uploadData.upload_param;
		const uploadFullUrl = uploadData.upload_full_url;

		if (!uploadParam && !uploadFullUrl) {
			console.error('[媒体/文件上传] 未获取到上传 URL');
			return null;
		}

		// 3. 加密文件
		const encrypted = encryptAesEcb(plaintext, aeskey);

		// 4. 上传到 CDN（3 次重试）
		const cdnUrl = uploadFullUrl || `${cdnBaseUrl}?${uploadParam}`;
		const MAX_RETRIES = 3;
		let downloadParam: string | null = null;
		
		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			try {
				const cdnRes = await fetch(cdnUrl, {
					method: 'POST',
					body: new Uint8Array(encrypted),
					headers: {
						'Content-Type': 'application/octet-stream',
					},
				});

				if (cdnRes.status >= 400 && cdnRes.status < 500) {
					console.error(`[媒体/文件上传] 客户端错误 ${cdnRes.status}`);
					return null;
				}

				if (cdnRes.status !== 200) {
					console.error(`[媒体/文件上传] 服务端错误（尝试 ${attempt}/${MAX_RETRIES}）: ${cdnRes.status}`);
					if (attempt === MAX_RETRIES) return null;
					continue;
				}

				downloadParam = cdnRes.headers.get('x-encrypted-param');
				if (!downloadParam) {
					console.error(`[媒体/文件上传] 缺少 x-encrypted-param（尝试 ${attempt}/${MAX_RETRIES}）`);
					if (attempt === MAX_RETRIES) return null;
					continue;
				}

				console.log(`[媒体/文件上传] 上传成功（尝试 ${attempt}）`);
				break;
			} catch (err) {
				console.error(`[媒体/文件上传] 上传异常（尝试 ${attempt}/${MAX_RETRIES}）:`, err);
				if (attempt === MAX_RETRIES) return null;
			}
		}

		if (!downloadParam) return null;

		return {
			filekey,
			downloadParam,
			aeskeyBase64: aeskey.toString('base64'),
			fileSize: rawsize,
			fileSizeCiphertext: filesize,
		};
	} catch (err) {
		console.error('[媒体/文件上传] 失败:', err);
		return null;
	}
}

// ═══════════════════════════════════════════════════
// 从远程 URL 下载图片到本地
// ═══════════════════════════════════════════════════

/**
 * 下载远程图片 URL（用于 Agent 生成图片后从网络获取）
 */
export async function downloadRemoteImage(params: {
	url: string;
	saveDir: string;
}): Promise<string | null> {
	const { url, saveDir } = params;

	try {
		console.log(`[媒体/远程] 下载: ${url}`);
		
		const res = await fetch(url);
		if (!res.ok) {
			console.error(`[媒体/远程] 下载失败: ${res.status} ${res.statusText}`);
			return null;
		}

		const buffer = Buffer.from(await res.arrayBuffer());

		// 根据 Content-Type 推断扩展名
		const contentType = res.headers.get('content-type') || '';
		let ext = 'bin';
		if (contentType.includes('image/jpeg') || contentType.includes('image/jpg')) ext = 'jpg';
		else if (contentType.includes('image/png')) ext = 'png';
		else if (contentType.includes('image/gif')) ext = 'gif';
		else if (contentType.includes('image/webp')) ext = 'webp';
		else {
			const urlMatch = url.match(/\.(jpe?g|png|gif|webp)$/i);
			if (urlMatch?.[1]) ext = urlMatch[1].toLowerCase();
		}

		mkdirSync(saveDir, { recursive: true });
		const filename = `weixin-remote-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
		const filepath = pathResolve(saveDir, filename);
		writeFileSync(filepath, buffer);

		console.log(`[媒体/远程] 已保存: ${filepath} (${buffer.length} bytes)`);
		return filepath;
	} catch (err) {
		console.error('[媒体/远程] 下载失败:', err);
		return null;
	}
}

// ═══════════════════════════════════════════════════
// 类型定义补充
// ═══════════════════════════════════════════════════

export interface CDNMedia {
	encrypt_query_param?: string;
	aes_key?: string;
	encrypt_type?: number;
	full_url?: string;
}

export interface ImageItem {
	media?: CDNMedia;
	thumb_media?: CDNMedia;
	aeskey?: string; // Raw AES-128 key as hex string (16 bytes)
	url?: string;
	mid_size?: number;
	thumb_size?: number;
	thumb_height?: number;
	thumb_width?: number;
	hd_size?: number;
}

export interface VideoItem {
	media?: CDNMedia;
	thumb_media?: CDNMedia;
	aeskey?: string;
	url?: string;
	duration?: number;
	thumb_size?: number;
	thumb_height?: number;
	thumb_width?: number;
	hd_size?: number;
}

export interface FileItem {
	media?: CDNMedia;
	file_name?: string;
	len?: string; // 明文大小（字符串）
	md5?: string;
}

export interface VoiceItem {
	media?: CDNMedia;
	duration?: number;
	text?: string; // 语音识别文本（如果有）
}
