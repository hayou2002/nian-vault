// 最小 ZIP 读写（store 模式，无依赖）。备份库这种「一堆小 md + 图片」的场景够用：
// 写入只用 local header，不带 data descriptor；读取容忍 data descriptor。

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// DOS 时间戳（zip 字段）
function dosTime(d = new Date()) {
  return (((d.getHours() << 6) | d.getMinutes()) << 5) | (d.getSeconds() >> 1);
}
function dosDate(d = new Date()) {
  return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5)) | d.getDate();
}

function nameBytes(name) {
  const b = Buffer.from(name, "utf8");
  return b;
}

/**
 * entries: [{ name, data: Buffer }] → zip Buffer
 */
export function zipSync(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const t = new Date();
  for (const e of entries) {
    const name = nameBytes(e.name);
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 name flag
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(dosTime(t), 10);
    local.writeUInt16LE(dosDate(t), 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    chunks.push(local, data);

    const cen = Buffer.alloc(46 + name.length);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(dosTime(t), 12);
    cen.writeUInt16LE(dosDate(t), 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    name.copy(cen, 46);
    central.push(cen);

    offset += local.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

/**
 * zip Buffer → Map name → Buffer。只支持 store（我们自己的备份包）；deflate 条目会明确报错。
 */
export function unzipSync(buf) {
  const out = new Map();
  // 从尾部找 EOCD
  let eocd = -1;
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是有效的 zip 文件（找不到中央目录结尾）");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // central directory offset
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("zip 中央目录损坏");
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16); // 指针推进前先取值
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (uncompSize === 0 && name.endsWith("/")) continue; // 目录条目
    // 读 local header 定位数据起点
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error(`zip 本地头损坏：${name}`);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    if (method !== 0) {
      if (method === 8 && uncompSize === compSize) throw new Error(`zip 条目 ${name} 声明为空但实际是 deflate`);
      throw new Error(`暂不支持 deflate 压缩的 zip 条目：${name}（请用本应用导出的备份包）`);
    }
    const data = buf.subarray(dataStart, dataStart + compSize);
    if (crc32(data) !== crc) throw new Error(`条目校验失败（CRC 不匹配）：${name}`);
    out.set(name, Buffer.from(data));
  }
  return out;
}
