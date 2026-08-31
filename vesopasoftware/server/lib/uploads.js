import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";

export const UPLOAD_DIR = path.join(ROOT, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// What a project brief actually contains: images, documents, archives of
// assets. Executables are not on the list, and the list is an allowlist so a
// new dangerous type cannot arrive by default.
const ALLOWED = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/avif",
  "application/pdf", "text/plain", "text/csv", "text/markdown",
  "application/zip", "application/x-zip-compressed",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "video/mp4", "video/quicktime",
]);

const EXT = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
  "image/svg+xml": ".svg", "image/avif": ".avif", "application/pdf": ".pdf",
  "text/plain": ".txt", "text/csv": ".csv", "text/markdown": ".md",
  "application/zip": ".zip", "application/x-zip-compressed": ".zip",
  "video/mp4": ".mp4", "video/quicktime": ".mov",
};

export const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    // The stored name is ours and random. The uploader's filename never
    // reaches the filesystem, so it cannot escape the directory or collide.
    filename: (req, file, cb) => {
      const ext = EXT[file.mimetype] || path.extname(file.originalname).replace(/[^.\w]/g, "").slice(0, 10) || "";
      cb(null, `${Date.now().toString(36)}_${crypto.randomBytes(8).toString("hex")}${ext}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) =>
    ALLOWED.has(file.mimetype)
      ? cb(null, true)
      : cb(new Error(`That file type (${file.mimetype}) is not accepted.`)),
});

export const prettySize = (bytes) => {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

export const isImage = (mime) => String(mime || "").startsWith("image/");
