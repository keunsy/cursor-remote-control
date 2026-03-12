/**
 * 钉钉消息发送辅助函数
 * 
 * 钉钉的消息发送机制与飞书不同：
 * - 飞书：通过 messageId/chatId 发送
 * - 钉钉：通过 sessionWebhook 发送
 */

import axios from 'axios';

// 维护 conversationId -> sessionWebhook 的映射
const webhookCache = new Map<string, string>();

/**
 * 缓存会话 webhook
 */
export function cacheWebhook(conversationId: string, webhook: string) {
	webhookCache.set(conversationId, webhook);
}

/**
 * 获取会话 webhook
 */
export function getWebhook(conversationId: string): string | undefined {
	return webhookCache.get(conversationId);
}

/**
 * 发送 Markdown 消息
 */
export async function sendMarkdown(
	webhook: string,
	markdown: string,
	title?: string
): Promise<void> {
	try {
		await axios.post(webhook, {
			msgtype: 'markdown',
			markdown: {
				title: title || 'Cursor AI',
				text: markdown,
			},
		});
	} catch (error) {
		console.error('[钉钉] 发送 Markdown 失败:', error);
		throw error;
	}
}

/**
 * 发送 ActionCard（交互式卡片）
 */
export async function sendCard(
	webhook: string,
	markdown: string,
	header?: { title?: string; color?: string }
): Promise<void> {
	try {
		const title = header?.title || 'Cursor AI';
		
		// 钉钉的 ActionCard 支持 Markdown
		await axios.post(webhook, {
			msgtype: 'actionCard',
			actionCard: {
				title,
				text: markdown,
				hideAvatar: '0',
				btnOrientation: '0',
			},
		});
	} catch (error) {
		console.error('[钉钉] 发送卡片失败:', error);
		// 降级为 Markdown
		try {
			await sendMarkdown(webhook, markdown, header?.title);
		} catch (fallbackError) {
			console.error('[钉钉] Markdown 降级也失败:', fallbackError);
		}
	}
}

/**
 * 回复消息（钉钉用 webhook 回复）
 */
export async function replyCard(
	webhook: string,
	markdown: string,
	header?: { title?: string; color?: string }
): Promise<void> {
	await sendCard(webhook, markdown, header);
}

/**
 * 更新卡片（钉钉不支持更新，只能发新消息）
 */
export async function updateCard(
	webhook: string,
	markdown: string,
	header?: { title?: string; color?: string }
): Promise<{ ok: boolean; error?: string }> {
	// 钉钉不支持消息更新，发送新消息代替
	try {
		await sendCard(webhook, markdown, header);
		return { ok: true };
	} catch (error) {
		return { 
			ok: false, 
			error: error instanceof Error ? error.message : String(error) 
		};
	}
}

/**
 * 下载钉钉文件
 */
export async function downloadDingTalkFile(
	downloadCode: string,
	accessToken: string
): Promise<Buffer> {
	try {
		const response = await axios.get(
			`https://api.dingtalk.com/v1.0/robot/messageFiles/download`,
			{
				params: { downloadCode },
				headers: {
					'x-acs-dingtalk-access-token': accessToken,
				},
				responseType: 'arraybuffer',
			}
		);
		return Buffer.from(response.data);
	} catch (error) {
		console.error('[钉钉] 下载文件失败:', error);
		throw error;
	}
}

/**
 * 获取钉钉 access_token
 */
export async function getDingTalkAccessToken(
	appKey: string,
	appSecret: string
): Promise<string> {
	try {
		const response = await axios.post(
			'https://api.dingtalk.com/v1.0/oauth2/accessToken',
			{
				appKey,
				appSecret,
			}
		);
		return response.data.accessToken;
	} catch (error) {
		console.error('[钉钉] 获取 access_token 失败:', error);
		throw error;
	}
}

/**
 * 解析钉钉消息内容
 */
export function parseDingTalkContent(message: any): {
	text: string;
	imageUrl?: string;
	fileUrl?: string;
	fileName?: string;
} {
	const msgtype = message.msgtype;
	
	switch (msgtype) {
		case 'text':
			return { text: message.text?.content || '' };
			
		case 'picture':
			return { 
				text: '', 
				imageUrl: message.content?.downloadCode 
			};
			
		case 'audio':
			return { 
				text: '', 
				fileUrl: message.content?.downloadCode 
			};
			
		case 'file':
			return {
				text: '',
				fileUrl: message.content?.downloadCode,
				fileName: message.content?.fileName,
			};
			
		case 'richText':
			// 富文本提取纯文本
			const richText = message.content?.richText || [];
			const texts = richText.map((item: any) => item.text || '').join('\n');
			return { text: texts };
			
		default:
			return { text: '' };
	}
}
