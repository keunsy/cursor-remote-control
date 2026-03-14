/**
 * 钉钉文件上传模块
 */
import axios from 'axios';
import FormData from 'form-data';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface DingtalkFileUploadOptions {
	filePath: string;
	accessToken: string;
	type?: 'image' | 'voice' | 'video' | 'file';
}

export interface DingtalkFileUploadResult {
	mediaId: string;
}

/**
 * 上传文件到钉钉服务器
 */
export async function uploadFileDingtalk(options: DingtalkFileUploadOptions): Promise<DingtalkFileUploadResult> {
	const { filePath, accessToken, type = 'file' } = options;

	// 检查文件
	const fullPath = resolve(filePath);
	if (!existsSync(fullPath)) {
		throw new Error(`文件不存在: ${fullPath}`);
	}

	const stats = statSync(fullPath);
	const maxSize = 30 * 1024 * 1024; // 30MB
	if (stats.size > maxSize) {
		throw new Error(`文件过大: ${(stats.size / 1024 / 1024).toFixed(2)}MB > 30MB`);
	}

	// 构建表单
	const form = new FormData();
	form.append('media', createReadStream(fullPath));
	form.append('type', type);

	// 上传（钉钉旧版 API：oapi.dingtalk.com）
	const url = `https://oapi.dingtalk.com/media/upload?access_token=${accessToken}&type=${type}`;
	const response = await axios.post(url, form, {
		headers: form.getHeaders(),
		maxBodyLength: maxSize,
		maxContentLength: maxSize,
	});

	if (response.data.errcode !== 0) {
		throw new Error(`钉钉上传失败: ${response.data.errmsg || response.data.errcode}`);
	}

	return {
		mediaId: response.data.media_id,
	};
}

/**
 * 通过 webhook 发送文件消息
 */
export async function sendFileDingtalk(webhook: string, mediaId: string, _fileName: string): Promise<void> {
	await axios.post(webhook, {
		msgtype: 'file',
		file: {
			media_id: mediaId,
		},
	});
}
