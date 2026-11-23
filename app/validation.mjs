import { TextDecoder } from 'node:util';

const maxImageBytes = 3 * 1024 * 1024;
export const maxBodyBytes = 4 * Math.ceil(maxImageBytes / 3) + 1024;
export const maxTextLength = 4000;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function readJson(request) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'Expected application/json.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      request.resume();
      throw new HttpError(413, 'Request is too large.');
    }
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new HttpError(400, 'Invalid JSON body.');
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new HttpError(400, 'Expected a JSON object.');
  }
  return value;
}

export function parseTicket(input) {
  const keys = Object.keys(input);
  if (keys.length === 1 && keys[0] === 'text' && typeof input.text === 'string') {
    const text = input.text.trim();
    if (!text || text.length > maxTextLength || text.includes('\0')) {
      throw new HttpError(400, 'Enter between 1 and 4000 characters of text.');
    }
    return { source: 'text', text };
  }
  if (keys.length !== 2 || typeof input.image !== 'string' || typeof input.mime !== 'string') {
    throw new HttpError(400, 'Submit either text or a screenshot.');
  }
  if (input.mime !== 'image/png' && input.mime !== 'image/jpeg') {
    throw new HttpError(400, 'Upload a PNG or JPEG screenshot.');
  }
  const image = Buffer.from(input.image, 'base64');
  if (image.length > maxImageBytes) throw new HttpError(413, 'Screenshot must be 3 MB or smaller.');
  if (image.toString('base64') !== input.image) throw new HttpError(400, 'Invalid screenshot encoding.');
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const jpeg = Buffer.from([255, 216, 255]);
  const signature = input.mime === 'image/png' ? png : jpeg;
  if (!image.subarray(0, signature.length).equals(signature)) {
    throw new HttpError(400, 'Screenshot content does not match its file type.');
  }
  return { source: 'image', image, extension: input.mime === 'image/png' ? 'png' : 'jpg' };
}

export function parseReview(input, intents) {
  const { intent, version, note = '' } = input;
  if (!intents.has(intent) || !Number.isInteger(version) || version < 1 || version > 2147483647
      || typeof note !== 'string' || note.length > 500 || note.includes('\0')) {
    throw new HttpError(400, 'Choose a valid intent, supply the ticket version, and limit the note to 500 characters.');
  }
  return { intent, version, note: note.trim() };
}
