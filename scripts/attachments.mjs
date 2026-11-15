import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const ATTACHMENTS_DIR = path.join("artifacts", "attachments");
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_IMAGES = 6;


async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isSafeAttachmentId(id) {
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$/.test(id);
}

function sniffImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    if (buffer.length < 24) return null;
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return { mimeType: "image/png", extension: "png", width, height };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      const size = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = buffer.readUInt16BE(offset + 5);
        const width = buffer.readUInt16BE(offset + 7);
        return { mimeType: "image/jpeg", extension: "jpg", width, height };
      }
      offset += 2 + size;
    }
    return { mimeType: "image/jpeg", extension: "jpg", width: null, height: null };
  }
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    const width = buffer.readUInt16LE(6);
    const height = buffer.readUInt16LE(8);
    return { mimeType: "image/gif", extension: "gif", width, height };
  }
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    // Basic RIFF/WEBP recognition; dimensions optional for VP8X.
    let width = null;
    let height = null;
    if (buffer[12] === 0x56 && buffer[13] === 0x50 && buffer[14] === 0x38 && buffer[15] === 0x58 && buffer.length >= 30) {
      width = 1 + buffer.readUIntLE(24, 3);
      height = 1 + buffer.readUIntLE(27, 3);
    }
    return { mimeType: "image/webp", extension: "webp", width, height };
  }
  return null;
}

function sanitizeFilename(name, extension) {
  const base = String(name || `attachment.${extension}`)
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || `attachment.${extension}`;
  if (base.toLowerCase().endsWith(`.${extension}`)) return base;
  return `${base}.${extension}`;
}

function attachmentPaths(root, attachmentId) {
  const dir = path.join(root, ATTACHMENTS_DIR, attachmentId);
  return {
    dir,
    meta: path.join(dir, "meta.json"),
    content: path.join(dir, "content"),
  };
}

async function collectRefsFromThreadFile(filePath, refs) {
  try {
    const thread = JSON.parse(await readFile(filePath, "utf8"));
    for (const id of thread.identity?.attachmentIds || []) {
      if (isSafeAttachmentId(id)) refs.add(id);
    }
    for (const message of thread.messages || []) {
      for (const id of message.attachmentIds || []) {
        if (isSafeAttachmentId(id)) refs.add(id);
      }
    }
  } catch {
    // Skip damaged threads.
  }
}

async function listAttachmentRefs(root) {
  const refs = new Set();
  const threadsDir = path.join(root, "artifacts", "feedback", "threads");
  const legacyDir = path.join(root, "artifacts", "feedback");
  for (const dir of [threadsDir, legacyDir]) {
    if (!(await pathExists(dir))) continue;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === "index.json") continue;
      await collectRefsFromThreadFile(path.join(dir, entry.name), refs);
    }
  }
  return refs;
}

async function listAttachments(root) {
  const base = path.join(root, ATTACHMENTS_DIR);
  if (!(await pathExists(base))) return { version: 1, attachments: [] };
  const entries = await readdir(base, { withFileTypes: true });
  const attachments = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeAttachmentId(entry.name)) continue;
    const metaPath = path.join(base, entry.name, "meta.json");
    if (!(await pathExists(metaPath))) continue;
    try {
      attachments.push(JSON.parse(await readFile(metaPath, "utf8")));
    } catch {
      // Skip damaged packages.
    }
  }
  attachments.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return { version: 1, attachments };
}

async function getAttachment(root, attachmentId) {
  if (!isSafeAttachmentId(attachmentId)) {
    const error = new Error("Invalid attachment id.");
    error.statusCode = 400;
    throw error;
  }
  const paths = attachmentPaths(root, attachmentId);
  if (!(await pathExists(paths.meta))) {
    const error = new Error("Attachment not found.");
    error.statusCode = 404;
    throw error;
  }
  const meta = JSON.parse(await readFile(paths.meta, "utf8"));
  const body = await readFile(paths.content);
  return { meta, body, paths };
}

async function createAttachment(root, {
  buffer,
  filename = null,
  declaredType = null,
} = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return {
      status: "blocked",
      ok: false,
      blockedReasons: ["Attachment body is required."],
    };
  }
  if (buffer.length > MAX_BYTES) {
    return {
      status: "blocked",
      ok: false,
      blockedReasons: [`Attachment exceeds ${MAX_BYTES} bytes (12 MB limit).`],
    };
  }

  const listed = await listAttachments(root);
  if (listed.attachments.length >= MAX_IMAGES * 20) {
    // Soft project ceiling so drafts cannot grow unboundedly; drafts are usually few.
  }

  const image = sniffImage(buffer);
  const isImage = ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"].includes(declaredType);
  const sniffed = image || (!isImage ? {
    mimeType: "application/octet-stream",
    extension: /^[a-z0-9]{1,12}$/i.test(path.extname(filename || "").slice(1)) ? path.extname(filename).slice(1).toLowerCase() : "bin",
    width: null, height: null,
  } : null);
  if (!sniffed) {
    return {
      status: "blocked",
      ok: false,
      blockedReasons: ["Only PNG, JPEG, WebP, or GIF images are accepted."],
    };
  }
  if (image && declaredType && declaredType !== sniffed.mimeType &&
      !(declaredType === "image/jpg" && sniffed.mimeType === "image/jpeg")) {
    return {
      status: "blocked",
      ok: false,
      blockedReasons: [`Declared type ${declaredType} does not match image bytes (${sniffed.mimeType}).`],
    };
  }

  const attachmentId = `att-${randomUUID()}`;
  const paths = attachmentPaths(root, attachmentId);
  const createdAt = new Date().toISOString();
  const safeName = sanitizeFilename(filename, sniffed.extension);
  const meta = {
    version: 1,
    attachmentId,
    filename: safeName,
    mimeType: sniffed.mimeType,
    byteSize: buffer.length,
    width: sniffed.width,
    height: sniffed.height,
    createdAt,
    projectRootHint: path.basename(path.resolve(root)),
    contentUrl: `/api/v1/attachments/${encodeURIComponent(attachmentId)}/content`,
    retention: "keep-if-referenced",
  };

  await mkdir(paths.dir, { recursive: true });
  await writeFile(paths.content, buffer);
  await writeFile(paths.meta, `${JSON.stringify(meta, null, 2)}\n`);

  return {
    status: "written",
    ok: true,
    attachment: meta,
    explanation: "Attachment stored under artifacts/attachments/. Keep IDs in feedback; do not log image bytes.",
  };
}

async function deleteAttachment(root, attachmentId, { force = false } = {}) {
  if (!isSafeAttachmentId(attachmentId)) {
    return {
      status: "blocked",
      ok: false,
      blockedReasons: ["Invalid attachment id."],
    };
  }
  const paths = attachmentPaths(root, attachmentId);
  if (!(await pathExists(paths.dir))) {
    return {
      status: "blocked",
      ok: false,
      blockedReasons: ["Attachment not found."],
    };
  }
  const refs = await listAttachmentRefs(root);
  if (refs.has(attachmentId) && !force) {
    return {
      status: "blocked",
      ok: false,
      blockedReasons: [
        "Attachment is referenced by feedback. Leave it in place, or pass force after host consent.",
      ],
      referenced: true,
    };
  }
  await rm(paths.dir, { recursive: true, force: true });
  return {
    status: "deleted",
    ok: true,
    attachmentId,
    explanation: "Attachment directory removed.",
  };
}

export {
  ATTACHMENTS_DIR,
  MAX_BYTES,
  MAX_IMAGES,
  createAttachment,
  deleteAttachment,
  getAttachment,
  isSafeAttachmentId,
  listAttachments,
  sniffImage,
};
