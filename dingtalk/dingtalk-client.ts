/**
 * 钉钉 Stream 客户端封装
 * 
 * 基于钉钉 Stream SDK，提供与飞书 SDK 类似的接口
 */

import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream';
import axios from 'axios';

export interface DingTalkConfig {
	clientId: string;
	clientSecret: string;
}

export interface DingTalkMessage {
	messageId: string;
	conversationId: string;
	senderId: string;
	senderStaffId: string;
	chatType: 'private' | 'group';
	text?: {
		content: string;
	};
	msgtype: 'text' | 'picture' | 'audio' | 'file' | 'richText';
	content?: any;
	sessionWebhook: string;
}

export interface MessageHandler {
	(message: DingTalkMessage): Promise<void>;
}

export class DingTalkStreamClient {
	private client: DWClient;
	private accessToken: string = '';
	private tokenExpireTime: number = 0;
	private config: DingTalkConfig;

	constructor(config: DingTalkConfig) {
		this.config = config;
		this.client = new DWClient({
			clientId: config.clientId,
			clientSecret: config.clientSecret,
		});
	}

	/**
	 * 注册消息监听器
	 */
	registerMessageListener(handler: MessageHandler) {
		this.client.registerCallbackListener(TOPIC_ROBOT, async (res) => {
			try {
				const messageId = res.headers.messageId;
				const rawData = JSON.parse(res.data);
				
				// 解析钉钉消息格式
				const message: DingTalkMessage = {
					messageId,
					conversationId: rawData.conversationId || '',
					senderId: rawData.senderId || '',
					senderStaffId: rawData.senderStaffId || '',
					chatType: rawData.conversationType === '1' ? 'private' : 'group',
					text: rawData.text,
					msgtype: rawData.msgtype || 'text',
					content: rawData,
					sessionWebhook: rawData.sessionWebhook || '',
				};

				// 调用处理器
				await handler(message);

				// 返回成功响应（防止重复推送）
				this.client.socketCallBackResponse(messageId, {
					code: 200,
					message: 'OK',
				});
			} catch (error) {
				console.error('[钉钉Stream] 消息处理异常:', error);
				// 返回错误响应
				this.client.socketCallBackResponse(res.headers.messageId, {
					code: 500,
					message: error instanceof Error ? error.message : String(error),
				});
			}
		});
	}

	/**
	 * 启动连接
	 */
	async start() {
		await this.refreshAccessToken();
		await this.client.connect();
		console.log('[钉钉Stream] WebSocket 连接已建立');
	}

	/**
	 * 刷新 access_token
	 */
	private async refreshAccessToken() {
		try {
			const response = await axios.post(
				'https://api.dingtalk.com/v1.0/oauth2/accessToken',
				{
					appKey: this.config.clientId,
					appSecret: this.config.clientSecret,
				}
			);
			this.accessToken = response.data.accessToken;
			this.tokenExpireTime = Date.now() + response.data.expireIn * 1000;
			console.log(`[钉钉] access_token 已刷新 (有效期: ${response.data.expireIn}s)`);
		} catch (error) {
			console.error('[钉钉] 获取 access_token 失败:', error);
			throw error;
		}
	}

	/**
	 * 确保 token 有效
	 */
	private async ensureToken() {
		if (Date.now() >= this.tokenExpireTime - 60000) {
			await this.refreshAccessToken();
		}
	}

	/**
	 * 发送文本消息
	 */
	async sendText(sessionWebhook: string, content: string) {
		try {
			await axios.post(sessionWebhook, {
				msgtype: 'text',
				text: {
					content,
				},
			});
		} catch (error) {
			console.error('[钉钉] 发送文本消息失败:', error);
			throw error;
		}
	}

	/**
	 * 发送 Markdown 消息
	 */
	async sendMarkdown(sessionWebhook: string, title: string, text: string) {
		try {
			await axios.post(sessionWebhook, {
				msgtype: 'markdown',
				markdown: {
					title,
					text,
				},
			});
		} catch (error) {
			console.error('[钉钉] 发送 Markdown 消息失败:', error);
			throw error;
		}
	}

	/**
	 * 发送交互式卡片（ActionCard）
	 */
	async sendCard(sessionWebhook: string, title: string, markdown: string, btnText?: string, btnUrl?: string) {
		try {
			const body: any = {
				msgtype: 'actionCard',
				actionCard: {
					title,
					text: markdown,
					hideAvatar: '0',
					btnOrientation: '0',
				},
			};

			if (btnText && btnUrl) {
				body.actionCard.singleTitle = btnText;
				body.actionCard.singleURL = btnUrl;
			}

			await axios.post(sessionWebhook, body);
		} catch (error) {
			console.error('[钉钉] 发送卡片失败:', error);
			throw error;
		}
	}

	/**
	 * 下载文件（图片/语音/文件）
	 */
	async downloadFile(downloadCode: string): Promise<Buffer> {
		try {
			await this.ensureToken();
			const response = await axios.get(
				`https://api.dingtalk.com/v1.0/robot/messageFiles/download`,
				{
					params: { downloadCode },
					headers: {
						'x-acs-dingtalk-access-token': this.accessToken,
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
	 * 获取媒体资源（图片）
	 */
	async getMedia(mediaId: string): Promise<Buffer> {
		try {
			await this.ensureToken();
			const response = await axios.get(
				`https://oapi.dingtalk.com/media/download`,
				{
					params: {
						access_token: this.accessToken,
						media_id: mediaId,
					},
					responseType: 'arraybuffer',
				}
			);
			return Buffer.from(response.data);
		} catch (error) {
			console.error('[钉钉] 获取媒体失败:', error);
			throw error;
		}
	}
}
