#!/usr/bin/env bun
/**
 * Mac 备忘录同步脚本 v2
 * 通过 AppleScript 从 Notes 应用提取内容，保存为 markdown 文件
 * 支持大量备忘录的分批处理
 *
 * 用法：
 *   bun sync-apple-notes.ts              # 同步所有备忘录
 *   bun sync-apple-notes.ts --folder "工作"  # 只同步指定文件夹
 *   bun sync-apple-notes.ts --limit 100  # 限制每个文件夹最多处理100条
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const WORKSPACE = resolve(import.meta.dirname, "..");
const OUTPUT_DIR = resolve(WORKSPACE, "apple-notes");
const MANIFEST_PATH = resolve(OUTPUT_DIR, ".sync-manifest.json");
const BATCH_SIZE = 20;

interface NoteBasic {
	id: string;
	name: string;
	modificationDate: string;
}

interface Manifest {
	lastSync: string;
	notes: Record<string, { modDate: string; file: string; folder: string }>;
}

function runAppleScript(script: string, timeout = 60000): string {
	try {
		return execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
			encoding: "utf-8",
			timeout,
			maxBuffer: 50 * 1024 * 1024,
		}).trim();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("not permitted") || msg.includes("denied")) {
			console.error("❌ 需要授权访问备忘录。");
			process.exit(1);
		}
		throw err;
	}
}

function getFolders(): string[] {
	const script = `tell application "Notes" to get name of every folder`;
	const result = runAppleScript(script);
	if (!result) return [];
	return result.split(", ").map((f) => f.trim()).filter(Boolean);
}

function getNoteCount(folder: string): number {
	const script = `tell application "Notes" to count of notes of folder "${folder}"`;
	const result = runAppleScript(script);
	return parseInt(result, 10) || 0;
}

function getNoteBasicInfo(folder: string, startIdx: number, count: number): NoteBasic[] {
	const script = `
tell application "Notes"
	set noteList to {}
	set theFolder to folder "${folder}"
	set allNotes to notes of theFolder
	set endIdx to ${startIdx} + ${count}
	if endIdx > (count of allNotes) then set endIdx to (count of allNotes)
	repeat with i from ${startIdx + 1} to endIdx
		set theNote to item i of allNotes
		set noteId to id of theNote
		set noteName to name of theNote
		set noteModified to modification date of theNote as string
		set end of noteList to noteId & "|||" & noteName & "|||" & noteModified
	end repeat
	set AppleScript's text item delimiters to "<<<NOTE>>>"
	return noteList as string
end tell`;

	const result = runAppleScript(script, 120000);
	if (!result) return [];

	return result
		.split("<<<NOTE>>>")
		.filter(Boolean)
		.map((line) => {
			const [id, name, modificationDate] = line.split("|||");
			return {
				id: id?.trim() || "",
				name: name?.trim() || "无标题",
				modificationDate: modificationDate?.trim() || "",
			};
		})
		.filter((n) => n.id);
}

function getNoteContent(noteId: string): { body: string; creationDate: string } {
	const script = `
tell application "Notes"
	set theNote to note id "${noteId}"
	set noteBody to plaintext of theNote
	set noteCreated to creation date of theNote as string
	return noteBody & "<<<SEP>>>" & noteCreated
end tell`;

	const result = runAppleScript(script, 30000);
	const [body, creationDate] = result.split("<<<SEP>>>");
	return {
		body: body?.trim() || "",
		creationDate: creationDate?.trim() || "",
	};
}

function sanitizeFilename(name: string): string {
	return name
		.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 80);
}

function noteToMarkdown(
	name: string,
	folder: string,
	body: string,
	creationDate: string,
	modificationDate: string
): string {
	return [
		`# ${name}`,
		"",
		`> 文件夹: ${folder}`,
		`> 创建: ${creationDate}`,
		`> 修改: ${modificationDate}`,
		"",
		"---",
		"",
		body,
	].join("\n");
}

function loadManifest(): Manifest {
	if (existsSync(MANIFEST_PATH)) {
		try {
			return JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
		} catch {
			// ignore
		}
	}
	return { lastSync: "", notes: {} };
}

function saveManifest(manifest: Manifest): void {
	writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

async function main() {
	const args = process.argv.slice(2);
	const folderIdx = args.indexOf("--folder");
	const targetFolder = folderIdx >= 0 ? args[folderIdx + 1] : null;
	const limitIdx = args.indexOf("--limit");
	const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;

	console.log("📝 正在连接 Mac 备忘录...");

	const folders = getFolders();
	if (folders.length === 0) {
		console.log("未找到任何备忘录文件夹。");
		return;
	}

	const workFolders = folders.filter((f) => f !== "Recently Deleted");
	console.log(`📁 找到 ${workFolders.length} 个文件夹: ${workFolders.join(", ")}`);

	mkdirSync(OUTPUT_DIR, { recursive: true });

	const manifest = loadManifest();
	const newManifest: Manifest = { lastSync: new Date().toISOString(), notes: {} };

	let totalNotes = 0;
	let updatedNotes = 0;
	let skippedNotes = 0;
	let errorNotes = 0;

	for (const folder of workFolders) {
		if (targetFolder && folder !== targetFolder) continue;

		const count = getNoteCount(folder);
		const processCount = Math.min(count, limit);
		console.log(`\n📂 ${folder} (${count} 条${limit < count ? `, 处理前 ${processCount} 条` : ""})`);

		if (count === 0) continue;

		const folderDir = resolve(OUTPUT_DIR, sanitizeFilename(folder));
		mkdirSync(folderDir, { recursive: true });

		for (let offset = 0; offset < processCount; offset += BATCH_SIZE) {
			const batchCount = Math.min(BATCH_SIZE, processCount - offset);
			const notes = getNoteBasicInfo(folder, offset, batchCount);

			for (const note of notes) {
				totalNotes++;
				const filename = `${sanitizeFilename(note.name)}.md`;
				const filepath = join(folderDir, filename);
				const relPath = `${sanitizeFilename(folder)}/${filename}`;

				newManifest.notes[note.id] = {
					modDate: note.modificationDate,
					file: relPath,
					folder,
				};

				const cached = manifest.notes[note.id];
				if (
					cached &&
					cached.modDate === note.modificationDate &&
					existsSync(resolve(OUTPUT_DIR, cached.file))
				) {
					skippedNotes++;
					continue;
				}

				try {
					const { body, creationDate } = getNoteContent(note.id);
					const content = noteToMarkdown(note.name, folder, body, creationDate, note.modificationDate);
					writeFileSync(filepath, content);
					updatedNotes++;
					process.stdout.write(`   ✓ ${note.name.slice(0, 40)}${note.name.length > 40 ? "..." : ""}\n`);
				} catch (err) {
					errorNotes++;
					console.log(`   ✗ ${note.name} (错误)`);
				}
			}

			if (offset + BATCH_SIZE < processCount) {
				process.stdout.write(`   ... 进度 ${Math.min(offset + BATCH_SIZE, processCount)}/${processCount}\n`);
			}
		}
	}

	saveManifest(newManifest);

	console.log(`\n✅ 同步完成!`);
	console.log(`   总计: ${totalNotes} 条`);
	console.log(`   更新: ${updatedNotes} 条`);
	console.log(`   跳过: ${skippedNotes} 条 (未修改)`);
	if (errorNotes > 0) console.log(`   错误: ${errorNotes} 条`);
	console.log(`\n📍 输出目录: ${OUTPUT_DIR}`);
}

main().catch((e) => {
	console.error(`错误: ${e instanceof Error ? e.message : e}`);
	process.exit(1);
});
