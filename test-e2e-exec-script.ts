import { executeScript } from "./shared/exec-script";

const PYTHON = "/Users/user/.venvs/uv-env/bin/python3";
const SCRIPT = "/Users/user/.cursor/skills/zhiwen-meal-order/zhiwen_meal_client.py";

async function test(label: string, payload: Parameters<typeof executeScript>[0]) {
	console.log(`\n${"=".repeat(60)}`);
	console.log(`场景: ${label}`);
	console.log(`${"=".repeat(60)}`);
	const result = await executeScript(payload);
	console.log(`status: ${result.status}`);
	console.log(`result: ${result.result ? `"${result.result}"` : "(无)"}`);
	console.log(`error:  ${result.error ? `"${result.error}"` : "(无)"}`);

	// 模拟 Scheduler 的 deliveryText 计算
	const deliveryText = result.result || (result.status === "error" && result.error ? `❌ ${result.error}` : undefined);
	console.log(`\n>>> 钉钉推送内容: ${deliveryText ? `"${deliveryText}"` : "[不推送]"}`);
	console.log(`>>> consecutiveErrors: ${result.status === "error" ? "+1" : "reset"}`);
}

// ── 真实场景 ──────────────────────────────────────

// 场景 A: 正常执行 auto --execute（非点餐时间 → 时间窗口拦截）
await test("A: 非点餐时间执行", {
	command: PYTHON,
	args: [SCRIPT, "auto", "--execute"],
	timeoutMs: 30000,
});

// 场景 B: 已有订单（模拟：先 slots 看有没有订单信息）
await test("B: slots 查看时段", {
	command: PYTHON,
	args: [SCRIPT, "slots"],
	timeoutMs: 30000,
});

// 场景 C: Python 脚本绝对路径错误
await test("C: 脚本路径错误", {
	command: PYTHON,
	args: ["/nonexistent/path/script.py"],
	timeoutMs: 5000,
});

// 场景 D: Python 命令不存在
await test("D: Python 命令不存在", {
	command: "/usr/local/bin/python999",
	args: [SCRIPT, "auto", "--execute"],
	timeoutMs: 5000,
});

// 场景 E: 脚本超时
await test("E: 脚本超时 (2s)", {
	command: PYTHON,
	args: ["-c", "import time; print('开始执行...'); time.sleep(10)"],
	timeoutMs: 2000,
});

// 场景 F: API 下单失败（模拟 exit 1 + stdout + stderr）
await test("F: 下单失败 (exit 1 + stderr)", {
	command: PYTHON,
	args: ["-c", `
import sys
print("🍽️ 自动选择: 红烧肉 ¥25 (食堂A)")
print("❌ 下单失败: CORP_MEMBER_ORDER_EXISTS", file=sys.stderr)
sys.exit(1)
`],
	timeoutMs: 5000,
});

// 场景 G: 下单失败（只有 stdout，无 stderr）
await test("G: 下单失败 (exit 1, 只有stdout)", {
	command: PYTHON,
	args: ["-c", `
import sys
print("🍽️ 自动选择: 红烧肉 ¥25 (食堂A)")
print("❌ 下单失败: 网络超时")
sys.exit(1)
`],
	timeoutMs: 5000,
});

// 场景 H: Token 过期（模拟 RuntimeError）
await test("H: Token 过期", {
	command: PYTHON,
	args: ["-c", `raise RuntimeError("Token 刷新失败。remember cookie 可能已过期，请重新从钉钉抓取。")`],
	timeoutMs: 5000,
});

// 场景 I: Cookie 文件不存在
await test("I: Cookie 文件不存在", {
	command: PYTHON,
	args: ["-c", `
import sys
print("[!] 未找到有效的 Cookie 文件，请先抓取 Cookie")
sys.exit(1)
`],
	timeoutMs: 5000,
});

// 场景 J: 正常成功下单（模拟）
await test("J: 下单成功 (模拟)", {
	command: PYTHON,
	args: ["-c", `
print("🍽️ 自动选择: 红烧肉套餐 ¥25 (食堂A)")
print("✅ 下单成功！订单号: abc123")
print("💳 支付状态: PAID")
`],
	timeoutMs: 5000,
});

// 场景 K: 已有订单（模拟 --execute 模式）
await test("K: 已有订单 (模拟)", {
	command: PYTHON,
	args: ["-c", `print("ℹ️ 今日已有订单：红烧肉套餐x1")`],
	timeoutMs: 5000,
});

// 场景 L: 空输出
await test("L: exit 0 + 空输出", {
	command: PYTHON,
	args: ["-c", "pass"],
	timeoutMs: 5000,
});

// 场景 M: command 为空
await test("M: command 为空", {
	command: "",
	timeoutMs: 5000,
});

// 场景 N: cwd 不存在
await test("N: cwd 不存在", {
	command: PYTHON,
	args: ["-c", "print('hello')"],
	cwd: "/nonexistent/directory",
	timeoutMs: 5000,
});

// 场景 O: 巨量输出
await test("O: 巨量输出 (100KB)", {
	command: PYTHON,
	args: ["-c", `print("x" * 100000)`],
	timeoutMs: 5000,
});

console.log(`\n${"=".repeat(60)}`);
console.log("全部 15 个场景测试完成");
console.log(`${"=".repeat(60)}`);
