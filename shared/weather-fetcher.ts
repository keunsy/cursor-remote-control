/**
 * 天气数据获取与格式化 — 基于中国天气网数据（sojson API）
 *
 * 数据来源：中国气象局 → 中国天气网 → sojson 免费 API
 * 支持按城市名或城市代码查询，输出新闻卡片风格。
 */

export interface WeatherFetchOptions {
	/** 城市名（如"北京"、"上海"、"深圳"）或城市代码（如"101010100"） */
	city?: string;
	/** 输出平台 */
	platform?: 'feishu' | 'dingtalk' | 'wecom' | 'wechat' | 'telegram';
}

interface SojsonCityInfo {
	city: string;
	citykey: string;
	parent: string;
	updateTime: string;
}

interface SojsonForecast {
	date: string;
	high: string;
	low: string;
	ymd: string;
	week: string;
	sunrise: string;
	sunset: string;
	aqi: number;
	fx: string;
	fl: string;
	type: string;
	notice: string;
}

interface SojsonData {
	shidu: string;
	pm25: number;
	pm10: number;
	quality: string;
	wendu: string;
	ganmao: string;
	forecast: SojsonForecast[];
	yesterday: SojsonForecast;
}

interface SojsonResponse {
	message: string;
	status: number;
	date: string;
	time: string;
	cityInfo: SojsonCityInfo;
	data: SojsonData;
}

const CITY_CODES: Record<string, string> = {
	'北京': '101010100', '上海': '101020100', '天津': '101030100', '重庆': '101040100',
	'广州': '101280101', '深圳': '101280601', '杭州': '101210101', '南京': '101190101',
	'成都': '101270101', '武汉': '101200101', '西安': '101110101', '苏州': '101190401',
	'长沙': '101250101', '郑州': '101180101', '青岛': '101120201', '大连': '101070201',
	'宁波': '101210401', '厦门': '101230201', '福州': '101230101', '无锡': '101190201',
	'合肥': '101220101', '昆明': '101290101', '哈尔滨': '101050101', '济南': '101120101',
	'佛山': '101280800', '东莞': '101281601', '南昌': '101240101', '沈阳': '101070101',
	'贵阳': '101260101', '海口': '101310101', '三亚': '101310201', '石家庄': '101090101',
	'太原': '101100101', '呼和浩特': '101080101', '长春': '101060101', '南宁': '101300101',
	'拉萨': '101140101', '银川': '101170101', '西宁': '101150101', '乌鲁木齐': '101130101',
	'兰州': '101160101', '珠海': '101280701', '中山': '101281701', '惠州': '101280301',
	'温州': '101210701', '常州': '101191101', '泉州': '101230501', '烟台': '101120501',
	'徐州': '101190801', '嘉兴': '101210301', '南通': '101190501', '金华': '101210901',
	'绍兴': '101210501', '台州': '101210601', '保定': '101090201', '洛阳': '101180901',
	'廊坊': '101090601', '汕头': '101280501', '潍坊': '101120601', '芜湖': '101220201',
};

const WEATHER_EMOJI: Record<string, string> = {
	'晴': '☀️', '多云': '⛅', '阴': '☁️', '雾': '🌫️', '霾': '😷',
	'小雨': '🌦️', '中雨': '🌧️', '大雨': '🌧️', '暴雨': '⛈️',
	'雷阵雨': '⛈️', '阵雨': '🌦️',
	'小雪': '🌨️', '中雪': '❄️', '大雪': '❄️', '暴雪': '🌬️❄️',
	'雨夹雪': '🌨️', '冻雨': '🌨️',
	'浮尘': '🌫️', '扬沙': '🌫️', '沙尘暴': '🌪️',
};

function getWeatherEmoji(type: string): string {
	for (const [key, emoji] of Object.entries(WEATHER_EMOJI)) {
		if (type.includes(key)) return emoji;
	}
	return '🌤️';
}

function getAqiLevel(aqi: number): { text: string; emoji: string } {
	if (aqi <= 50) return { text: '优', emoji: '🟢' };
	if (aqi <= 100) return { text: '良', emoji: '🟡' };
	if (aqi <= 150) return { text: '轻度', emoji: '🟠' };
	if (aqi <= 200) return { text: '中度', emoji: '🔴' };
	if (aqi <= 300) return { text: '重度', emoji: '🟣' };
	return { text: '严重', emoji: '⚫' };
}

function parseTemp(s: string): number {
	const m = s.match(/-?\d+/);
	return m ? parseInt(m[0], 10) : 0;
}

function getDressingAdvice(temp: number, type: string): string {
	let clothing: string;
	if (temp <= 0) clothing = '🧣 严寒，羽绒服+围巾手套';
	else if (temp <= 5) clothing = '🧥 很冷，厚外套/大衣';
	else if (temp <= 10) clothing = '🧥 偏冷，外套+毛衣';
	else if (temp <= 15) clothing = '🧶 微凉，长袖+薄外套';
	else if (temp <= 20) clothing = '👕 舒适，长袖/薄外套';
	else if (temp <= 25) clothing = '👕 舒适，T恤即可';
	else if (temp <= 30) clothing = '🩳 较热，短袖/短裤';
	else clothing = '🥵 酷热，注意防暑防晒';

	const extras: string[] = [];
	if (/雨/.test(type)) extras.push('🌂 有雨记得带伞');
	if (/雪/.test(type)) extras.push('🌂 有雪注意防滑');
	if (/霾/.test(type)) extras.push('😷 有霾建议戴口罩');

	return extras.length > 0 ? `${clothing}\n  ${extras.join('  ')}` : clothing;
}

function resolveCityCode(city: string): string {
	if (/^\d{9,}$/.test(city)) return city;

	const normalized = city.replace(/[市省区]$/, '');
	if (CITY_CODES[normalized]) return CITY_CODES[normalized]!;

	for (const [name, code] of Object.entries(CITY_CODES)) {
		if (name.includes(normalized) || normalized.includes(name)) return code;
	}

	throw new Error(
		`未找到城市"${city}"的代码。支持的城市：${Object.keys(CITY_CODES).join('、')}。也可直接传城市代码（如 101010100）`
	);
}

export async function fetchWeather(options?: WeatherFetchOptions): Promise<string> {
	const cityInput = options?.city ?? '北京';
	const cityCode = resolveCityCode(cityInput);

	const url = `http://t.weather.sojson.com/api/weather/city/${cityCode}`;
	const resp = await fetch(url, {
		signal: AbortSignal.timeout(15_000),
	});

	if (!resp.ok) {
		throw new Error(`天气 API 请求失败: ${resp.status} ${resp.statusText}`);
	}

	const data = (await resp.json()) as SojsonResponse;

	if (data.status !== 200) {
		throw new Error(`天气 API 返回异常: ${data.message}`);
	}

	const { cityInfo, data: wd } = data;
	const today = wd.forecast[0];

	if (!today) {
		throw new Error('天气数据缺少今日预报');
	}

	const tempNow = parseFloat(wd.wendu);
	const tempHigh = parseTemp(today.high);
	const tempLow = parseTemp(today.low);
	const weatherEmoji = getWeatherEmoji(today.type);
	const aqiInfo = getAqiLevel(today.aqi);
	const dressing = getDressingAdvice(tempHigh, today.type);

	const now = new Date();
	const dateStr = now.toLocaleDateString('zh-CN', {
		timeZone: 'Asia/Shanghai',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		weekday: 'long',
	});
	const timeStr = now.toLocaleTimeString('zh-CN', {
		timeZone: 'Asia/Shanghai',
		hour: '2-digit',
		minute: '2-digit',
	});

	let card = '';
	card += `━━━━━━━━━━━━━━━━━━━━━━\n`;
	card += `${weatherEmoji} ${cityInfo.city}天气日报\n`;
	card += `📅 ${dateStr}  ⏱ ${timeStr}\n`;
	card += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;

	card += `🌡️ 实时天气\n`;
	card += `  ${weatherEmoji} ${today.type}  ${tempNow}°C\n`;
	card += `  🌡 ${tempLow}°C ~ ${tempHigh}°C\n`;
	card += `  💧 湿度 ${wd.shidu}  🌬 ${today.fx}${today.fl}\n`;
	card += `  🌅 日出 ${today.sunrise}  🌇 日落 ${today.sunset}\n`;

	card += `\n`;
	card += `👔 穿衣建议\n`;
	card += `  ${dressing}\n`;

	if (today.notice) {
		card += `  💡 ${today.notice}\n`;
	}

	card += `\n`;
	card += `🌬️ 空气质量\n`;
	card += `  ${aqiInfo.emoji} AQI ${today.aqi}（${aqiInfo.text}）  `;
	card += `PM2.5: ${wd.pm25}  PM10: ${wd.pm10}\n`;

	if (wd.quality) {
		card += `  空气质量：${wd.quality}\n`;
	}

	if (wd.ganmao) {
		card += `  💊 ${wd.ganmao}\n`;
	}

	card += `\n`;
	card += `📊 未来几天\n`;
	const forecastDays = wd.forecast.slice(1, 6);
	for (const day of forecastDays) {
		const emoji = getWeatherEmoji(day.type);
		const low = parseTemp(day.low);
		const high = parseTemp(day.high);
		card += `  ${day.week}(${day.date}日)  ${emoji} ${day.type}  ${low}~${high}°C  ${day.fx}${day.fl}\n`;
	}

	card += `\n---\n📡 数据来源：中国气象局（更新于 ${cityInfo.updateTime}）`;

	return card;
}

/** 获取支持的城市列表 */
export function getSupportedCities(): string[] {
	return Object.keys(CITY_CODES);
}
