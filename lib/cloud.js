// 云备份（WebDAV / S3 兼容）：经外部 curl 上传快照。
// 凭据只存宿主 storage（app-data，不进库目录），绝不写进 vault 文件。
import { spawn } from "node:child_process";
import path from "node:path";

export const CLOUD_KEY = "cloudBackup";

export function validateCloudConfig(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== "object") return { ok: false, errors: ["配置为空"] };
  if (!["webdav", "s3"].includes(cfg.proto)) errors.push("协议必须是 webdav 或 s3");
  if (!/^https?:\/\/.+/i.test(String(cfg.url || ""))) errors.push("地址必须是 http(s) URL");
  if (cfg.proto === "s3" && !String(cfg.region || "").trim()) errors.push("S3 需要 region（如 ap-east-1）");
  if (cfg.enabled && !String(cfg.user || "").trim()) errors.push("缺账号");
  return { ok: errors.length === 0, errors };
}

/** curl 参数构造（独立出来便于测试） */
export function curlArgs(cfg, filePath) {
  const url = String(cfg.url).replace(/\/+$/, "") + "/" + encodeURIComponent(path.basename(filePath));
  const args = ["-sS", "--max-time", "300", "-o", process.platform === "win32" ? "NUL" : "/dev/null", "-w", "%{http_code}", "-T", filePath, url];
  if (cfg.proto === "s3") args.push("--aws-sigv4", `aws:amz:${cfg.region}:s3`);
  return args;
}

/**
 * 上传一个文件。返回 { ok, status?, error? }。
 * 需要 app/process.spawn 授权；未授权或 curl 不在时返回明确错误。
 */
export async function uploadViaCurl(cfg, filePath, spawnEnabled) {
  const bad = validateCloudConfig(cfg);
  if (!bad.ok) return { ok: false, error: bad.errors.join("；") };
  if (!spawnEnabled) return { ok: false, error: "未授权 app/process.spawn（设置 → 安全 → 应用能力 中开启后重启生效）" };
  const candidates = process.platform === "win32" ? ["curl.exe", "curl"] : ["curl"];
  let exe = null;
  for (const c of candidates) {
    try {
      const r = await sdkResolve(c);
      if (r) { exe = r; break; }
    } catch { /* 继续 */ }
  }
  if (!exe) return { ok: false, error: "系统里找不到 curl" };
  return runCurl(exe.path || exe, curlArgs(cfg, filePath), cfg).then((r) => r.ok && r.status >= 200 && r.status < 300 ? r : ({ ...r, ok: false, error: r.error || `服务端返回 HTTP ${r.status}` }));
}

export async function downloadViaCurl(cfg, filePath, spawnEnabled) {
  const bad = validateCloudConfig(cfg);
  if (!bad.ok) return { ok: false, error: bad.errors.join("；") };
  if (!spawnEnabled) return { ok: false, error: "未授权 app/process.spawn" };
  const exe = await findCurl();
  if (!exe) return { ok: false, error: "系统里找不到 curl" };
  const url = String(cfg.url).replace(/\/+$/, "") + "/nian-vault-latest.zip";
  const args = ["-sS", "--fail", "--max-time", "300", "-o", filePath, url];
  if (cfg.proto === "s3") args.push("--aws-sigv4", `aws:amz:${cfg.region}:s3`);
  return runCurl(exe.path || exe, args, cfg);
}

async function findCurl() {
  const candidates = process.platform === "win32" ? ["curl.exe", "curl"] : ["curl"];
  for (const c of candidates) {
    try { const r = await sdkResolve(c); if (r) return r; } catch { /* continue */ }
  }
  return null;
}

function runCurl(exe, args, cfg) {
  return new Promise((resolve) => {
    const child = spawn(exe, ["--config", "-", ...args], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const done = (r) => { if (settled) return; settled = true; resolve(r); };
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString().slice(0, 500); });
    child.on("error", (e) => done({ ok: false, error: `curl 启动失败：${e.message.slice(0, 140)}` }));
    child.on("close", (code) => {
      const status = parseInt(stdout.trim(), 10) || 0;
      if (code === 0) done({ ok: true, status });
      else done({ ok: false, status, error: `curl 失败（${status || code}）：${stderr.slice(0, 180)}` });
    });
    const config = [`user = "${curlQuote(`${cfg.user || ""}:${cfg.pass || ""}`)}"`, ...(cfg.proto === "s3" ? [`aws-sigv4 = "aws:amz:${curlQuote(cfg.region)}:s3"`] : [])].join("\n");
    child.stdin.end(config);
    const timer = setTimeout(() => { child.kill(); done({ ok: false, error: "curl 超时" }); }, 320000);
    child.on("close", () => clearTimeout(timer));
  });
}

function curlQuote(s) { return String(s).replace(/\\/g, "\\\\").replace(/\"/g, "\\\""); }

// resolveExecutable 由 index.js 注入（依赖 sdk），避免本模块直接耦合
let sdkResolve = async () => null;
export function setResolver(fn) { sdkResolve = fn; }
