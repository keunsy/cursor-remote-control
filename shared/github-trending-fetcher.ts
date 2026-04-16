/**
 * GitHub Trending 抓取与格式化
 *
 * 直接解析 github.com/trending 页面 HTML，提取热门仓库信息。
 * 使用 Google Translate 将英文简介翻译为中文。
 */

// 使用 MyMemory 免费翻译 API（不依赖 Google Translate，避免 IP 限流）

export interface GithubTrendingOptions {
	/** 时间范围：daily | weekly | monthly */
	since?: 'daily' | 'weekly' | 'monthly';
	/** 编程语言筛选（如 "python"、"javascript"） */
	language?: string;
	/** 返回数量，默认 20 */
	topN?: number;
	/** 是否翻译简介为中文，默认 true */
	translateDesc?: boolean;
}

interface TrendingRepo {
	rank: number;
	name: string;
	description: string;
	descZh: string;
	language: string;
	starsToday: string;
	totalStars: string;
	forks: string;
	url: string;
}

const LANG_EMOJI: Record<string, string> = {
	'python': '🐍', 'javascript': '🟨', 'typescript': '🔷', 'java': '☕',
	'go': '🐹', 'rust': '🦀', 'c++': '⚙️', 'c': '⚙️', 'c#': '🟣',
	'ruby': '💎', 'swift': '🍎', 'kotlin': '🟠', 'php': '🐘',
	'shell': '🐚', 'dart': '🎯', 'vue': '💚', 'html': '🌐', 'css': '🎨',
	'lua': '🌙', 'scala': '🔴', 'r': '📊', 'jupyter notebook': '📓',
};

function getLangEmoji(lang: string): string {
	return LANG_EMOJI[lang.toLowerCase()] ?? '📦';
}

function parseHTML(html: string, topN: number): Omit<TrendingRepo, 'descZh'>[] {
	const repos: Omit<TrendingRepo, 'descZh'>[] = [];
	const articleRegex = /<article class="Box-row">[\s\S]*?<\/article>/g;
	let match: RegExpExecArray | null;
	let rank = 0;

	while ((match = articleRegex.exec(html)) !== null && rank < topN) {
		rank++;
		const article = match[0];

		const nameMatch = article.match(/href="\/([\w.-]+\/[\w.-]+)"/);
		const name = nameMatch?.[1] ?? `unknown-${rank}`;

		const descMatch = article.match(/<p class="col-9[^"]*">\s*([\s\S]*?)\s*<\/p>/);
		const description = descMatch?.[1]?.replace(/<[^>]*>/g, '').trim() ?? '';

		const langMatch = article.match(/itemprop="programmingLanguage">([\s\S]*?)<\/span>/);
		const language = langMatch?.[1]?.trim() ?? '';

		const starsMatch = article.match(/([\d,]+)\s*stars\s*today/i);
		const starsToday = starsMatch?.[1] ?? '';

		repos.push({
			rank,
			name,
			description,
			language,
			starsToday,
			totalStars: '',
			forks: '',
			url: `https://github.com/${name}`,
		});
	}

	return repos;
}

interface RepoApiData {
	description: string;
	totalStars: string;
	forks: string;
}

async function fetchRepoDetails(repos: Omit<TrendingRepo, 'descZh'>[]): Promise<RepoApiData[]> {
	const results = await Promise.allSettled(
		repos.map(async (repo) => {
			const apiUrl = `https://api.github.com/repos/${repo.name}`;
			const resp = await fetch(apiUrl, {
				headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'cursor-remote-control/1.0' },
				signal: AbortSignal.timeout(5_000),
			});
			if (!resp.ok) return { description: repo.description, totalStars: '', forks: '' };
			const data = (await resp.json()) as {
				description?: string;
				topics?: string[];
				stargazers_count?: number;
				forks_count?: number;
			};
			let desc = data.description ?? repo.description;
			if (data.topics?.length) {
				desc += ` [${data.topics.slice(0, 4).join(', ')}]`;
			}
			const totalStars = data.stargazers_count ? formatCount(data.stargazers_count) : '';
			const forks = data.forks_count ? formatCount(data.forks_count) : '';
			return { description: desc, totalStars, forks };
		})
	);
	return results.map((r, i) =>
		r.status === 'fulfilled' ? r.value : { description: repos[i]!.description, totalStars: '', forks: '' }
	);
}

function formatCount(n: number): string {
	if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

function isChinese(text: string): boolean {
	return /[\u4e00-\u9fff]/.test(text) && (text.match(/[\u4e00-\u9fff]/g)?.length ?? 0) > text.length * 0.3;
}

async function translateText(text: string): Promise<string> {
	if (!text) return '';
	if (isChinese(text)) return text;

	const cleaned = text.replace(/\[.*?\]$/, '').trim();

	try {
		const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(cleaned)}&langpair=en|zh-CN`;
		const resp = await fetch(url, { signal: AbortSignal.timeout(8_000) });
		if (!resp.ok) return text;
		const data = (await resp.json()) as { responseData?: { translatedText?: string }; responseStatus?: number };
		if (data.responseStatus === 200 && data.responseData?.translatedText) {
			const translated = data.responseData.translatedText;
			if (translated.toUpperCase() === cleaned.toUpperCase()) return text;
			return translated;
		}
		return text;
	} catch {
		return text;
	}
}

async function fallbackToSearchAPI(topN: number): Promise<Omit<TrendingRepo, 'descZh'>[]> {
	const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
	const url = `https://api.github.com/search/repositories?q=created:>${weekAgo}&sort=stars&order=desc&per_page=${topN}`;

	const resp = await fetch(url, {
		headers: { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'cursor-remote-control/1.0' },
		signal: AbortSignal.timeout(15_000),
	});

	if (!resp.ok) {
		throw new Error(`GitHub Search API 失败: ${resp.status}`);
	}

	const data = (await resp.json()) as { items: { full_name: string; description: string; language: string; stargazers_count: number; html_url: string }[] };

	return data.items.map((item, idx) => ({
		rank: idx + 1,
		name: item.full_name,
		description: item.description ?? '',
		language: item.language ?? '',
		starsToday: '',
		totalStars: formatCount(item.stargazers_count),
		forks: '',
		url: item.html_url,
	}));
}

export async function fetchGithubTrending(options?: GithubTrendingOptions): Promise<string> {
	const since = options?.since ?? 'daily';
	const topN = options?.topN ?? 20;
	const shouldTranslate = options?.translateDesc !== false;
	const language = options?.language ?? '';

	const sinceLabel = since === 'daily' ? '今日' : since === 'weekly' ? '本周' : '本月';

	let repos: Omit<TrendingRepo, 'descZh'>[];
	let isFallback = false;

	try {
		const langParam = language ? `/${encodeURIComponent(language)}` : '';
		const url = `https://github.com/trending${langParam}?since=${since}`;
		const resp = await fetch(url, {
			headers: {
				'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
			},
			signal: AbortSignal.timeout(15_000),
		});

		if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
		const html = await resp.text();
		repos = parseHTML(html, topN);

		if (repos.length < 3) throw new Error(`仅解析到 ${repos.length} 个仓库`);
	} catch (err) {
		console.warn(`[GitHub Trending] 页面抓取失败，使用 Search API fallback: ${err}`);
		repos = await fallbackToSearchAPI(topN);
		isFallback = true;
	}

	const details = await fetchRepoDetails(repos);
	for (let i = 0; i < repos.length; i++) {
		const d = details[i]!;
		repos[i]!.description = d.description || repos[i]!.description;
		repos[i]!.totalStars = d.totalStars;
		repos[i]!.forks = d.forks;
	}

	let fullRepos: TrendingRepo[];
	if (shouldTranslate) {
		const translated: string[] = [];
		for (const r of repos) {
			translated.push(await translateText(r.description));
			if (repos.length > 5) await new Promise(resolve => setTimeout(resolve, 200));
		}
		fullRepos = repos.map((r, i) => ({ ...r, descZh: translated[i] ?? r.description }));
	} else {
		fullRepos = repos.map(r => ({ ...r, descZh: r.description }));
	}

	const now = new Date();
	const dateStr = now.toLocaleDateString('zh-CN', {
		timeZone: 'Asia/Shanghai',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		weekday: 'long',
	});

	let card = '';
	card += `━━━━━━━━━━━━━━━━━━━━━━\n`;
	card += `🔥 GitHub Trending ${sinceLabel}热榜\n`;
	card += `📅 ${dateStr}`;
	if (language) card += `  📝 ${language}`;
	card += '\n';
	card += `━━━━━━━━━━━━━━━━━━━━━━\n`;

	if (isFallback) {
		card += `⚠️ Trending 页面不可用，以下为近 7 天新建仓库热度 Top${topN}\n`;
	}

	card += '\n';

	for (const repo of fullRepos) {
		const langEmoji = repo.language ? getLangEmoji(repo.language) : '';
		const langTag = repo.language ? ` ${langEmoji}${repo.language}` : '';

		const stats: string[] = [];
		if (repo.totalStars) stats.push(`⭐${repo.totalStars}`);
		if (repo.forks) stats.push(`🔱${repo.forks}`);
		if (repo.starsToday) stats.push(`📈+${repo.starsToday}/天`);
		const statsTag = stats.length ? `  ${stats.join(' ')}` : '';

		card += `${repo.rank}. ${repo.name}${langTag}\n`;
		if (statsTag.trim()) {
			card += `   ${statsTag.trim()}\n`;
		}

		if (repo.descZh) {
			card += `   ${repo.descZh}\n`;
		} else if (repo.description) {
			card += `   ${repo.description}\n`;
		} else {
			card += `   （暂无简介）\n`;
		}

		card += `   🔗 ${repo.url}\n`;
		card += '\n';
	}

	card += `---\n📡 数据来源：github.com/trending`;

	return card;
}
