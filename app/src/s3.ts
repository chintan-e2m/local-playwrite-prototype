// Object storage (MinIO locally, R2/S3 in production).
//   - client uploads:   browser -> pre-signed PUT -> bucket (never through this server)
//   - task results:     task worker -> SDK upload (the files are already on this server)
//   - viewing results:  browser <- pre-signed GET (short-lived)
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "./config.ts";

const base = {
  region: config.s3.region,
  forcePathStyle: true,
  credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey },
  // Without this, pre-signed PUTs from browsers fail with checksum errors.
  requestChecksumCalculation: "WHEN_REQUIRED" as const,
  responseChecksumValidation: "WHEN_REQUIRED" as const,
};
// Internal endpoint for the server; public endpoint for URLs handed to browsers.
const s3 = new S3Client({ ...base, endpoint: config.s3.endpoint });
const s3Public = new S3Client({ ...base, endpoint: config.s3.publicEndpoint });
const Bucket = config.s3.bucket;

export async function ensureBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket }));
  }
}

export const presignPut = (key: string, contentType: string) =>
  getSignedUrl(s3Public, new PutObjectCommand({ Bucket, Key: key, ContentType: contentType }), { expiresIn: 600 });

export const presignGet = (key: string, filename?: string) =>
  getSignedUrl(
    s3Public,
    new GetObjectCommand({ Bucket, Key: key, ResponseContentDisposition: filename ? `inline; filename="${filename.replace(/"/g, "")}"` : undefined }),
    { expiresIn: 600 },
  );

export async function uploadFile(key: string, file: string, contentType: string) {
  await s3.send(new PutObjectCommand({ Bucket, Key: key, Body: createReadStream(file), ContentType: contentType }));
}

export async function downloadTo(key: string, file: string) {
  const out = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.from(await out.Body!.transformToByteArray()));
}

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".zip": "application/zip",
};
export const contentTypeFor = (name: string) => TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream";
