'use strict';

const fs = require('node:fs');
const {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const config = require('./config');
const log = require('./log');

function buildClient(endpoint) {
  return new S3Client({
    endpoint,
    region: config.s3.region,
    forcePathStyle: config.s3.forcePathStyle,
    credentials: {
      accessKeyId: config.s3.accessKey,
      secretAccessKey: config.s3.secretKey,
    },
  });
}

const internal = buildClient(config.s3.endpoint);
const publicClient = buildClient(config.s3.publicEndpoint);

async function ensureBucket() {
  try {
    await internal.send(new HeadBucketCommand({ Bucket: config.s3.bucket }));
  } catch {
    try {
      await internal.send(new CreateBucketCommand({ Bucket: config.s3.bucket }));
      log.info('s3.bucket_created', { bucket: config.s3.bucket });
    } catch (error) {
      if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists/i.test(String(error?.name))) throw error;
    }
  }
}

async function putBuffer(key, body, contentType, metadata) {
  await internal.send(new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    Metadata: metadata,
  }));
  return Buffer.byteLength(body);
}

async function putFile(key, filePath, contentType) {
  const stat = fs.statSync(filePath);
  await internal.send(new PutObjectCommand({
    Bucket: config.s3.bucket,
    Key: key,
    Body: fs.createReadStream(filePath),
    ContentLength: stat.size,
    ContentType: contentType,
  }));
  return stat.size;
}

async function deleteObject(key) {
  await internal.send(new DeleteObjectCommand({ Bucket: config.s3.bucket, Key: key }));
}

async function presignGet(key, filename) {
  const command = new GetObjectCommand({
    Bucket: config.s3.bucket,
    Key: key,
    ResponseContentDisposition: filename ? `attachment; filename="${filename.replace(/["\\]/g, '_')}"` : undefined,
  });
  return getSignedUrl(publicClient, command, { expiresIn: config.s3.presignTtlSeconds });
}

async function getObjectBuffer(key) {
  const response = await internal.send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }));
  const chunks = [];
  for await (const chunk of response.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

module.exports = {
  ensureBucket,
  putBuffer,
  putFile,
  deleteObject,
  presignGet,
  getObjectBuffer,
  bucket: config.s3.bucket,
};
