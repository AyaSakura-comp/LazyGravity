import { AttachmentBuilder, Message } from 'discord.js';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { ExtractedResponseImage } from '../services/cdpService';
import { logger } from './logger';

const MAX_INBOUND_IMAGE_ATTACHMENTS = 4;
const IMAGE_EXT_PATTERN = /\.(png|jpe?g|webp|gif|bmp)$/i;
const TEMP_IMAGE_DIR = path.join(os.tmpdir(), 'lazy-gravity-images');

export interface InboundImageAttachment {
    localPath: string;
    url: string;
    name: string;
    mimeType: string;
}

export type LocalFileMarkerKind = 'image' | 'file' | 'video';

export interface LocalFileMarker {
    kind: LocalFileMarkerKind;
    path: string;
}

export interface ExtractedLocalFileMarkers {
    text: string;
    markers: LocalFileMarker[];
}

export function isImageAttachment(contentType: string | null | undefined, fileName: string | null | undefined): boolean {
    if ((contentType || '').toLowerCase().startsWith('image/')) return true;
    return IMAGE_EXT_PATTERN.test(fileName || '');
}

export function mimeTypeToExtension(mimeType: string): string {
    const normalized = (mimeType || '').toLowerCase();
    if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
    if (normalized.includes('webp')) return 'webp';
    if (normalized.includes('gif')) return 'gif';
    if (normalized.includes('bmp')) return 'bmp';
    return 'png';
}

export function sanitizeFileName(fileName: string): string {
    const sanitized = fileName.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
    return sanitized || `image-${Date.now()}.png`;
}

export function buildPromptWithAttachmentUrls(prompt: string, attachments: InboundImageAttachment[]): string {
    const base = prompt.trim() || 'Please review the attached images and respond accordingly.';
    if (attachments.length === 0) return base;

    const lines = attachments.map((image, index) =>
        `${index + 1}. ${image.name}\nURL: ${image.url}`,
    );

    return `${base}\n\n[Discord Attached Images]\n${lines.join('\n\n')}\n\nPlease refer to the attached images above in your response.`;
}

const LOCAL_FILE_MARKER_PATTERN = /\[\[\s*(image|file|video)\s*:\s*([^\]]+?)\s*\]\]/gi;
const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

export function extractLocalFileMarkers(text: string): ExtractedLocalFileMarkers {
    const markers: LocalFileMarker[] = [];
    const cleaned = (text || '').replace(LOCAL_FILE_MARKER_PATTERN, (match, rawKind: string, rawPath: string) => {
        const candidatePath = (rawPath || '').trim();
        if (!candidatePath || URL_PATTERN.test(candidatePath) || !path.isAbsolute(candidatePath)) {
            return match;
        }

        markers.push({
            kind: rawKind.toLowerCase() as LocalFileMarkerKind,
            path: candidatePath,
        });
        return '';
    });

    const visibleText = cleaned
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line.trim().length > 0)
        .join('\n')
        .trim();

    return { text: visibleText, markers };
}

export async function toDiscordFileAttachments(
    markers: LocalFileMarker[],
    maxAttachments = 10,
): Promise<AttachmentBuilder[]> {
    const attachments: AttachmentBuilder[] = [];
    const seen = new Set<string>();

    for (const marker of markers) {
        if (attachments.length >= maxAttachments) break;
        if (!marker.path || seen.has(marker.path)) continue;
        seen.add(marker.path);

        try {
            const stat = await fs.stat(marker.path);
            if (!stat.isFile()) continue;

            const buffer = await fs.readFile(marker.path);
            if (buffer.length === 0) continue;

            const rawName = path.basename(marker.path) || `${marker.kind}-${attachments.length + 1}`;
            const name = sanitizeFileName(rawName);
            attachments.push(new AttachmentBuilder(buffer, { name }));
        } catch (error: any) {
            logger.warn(`[ImageBridge] Local ${marker.kind} marker skipped (${marker.path})`, error?.message || error);
        }
    }

    return attachments;
}

export async function downloadInboundImageAttachments(message: Message): Promise<InboundImageAttachment[]> {
    const allAttachments = Array.from(message.attachments.values());
    const imageAttachments = allAttachments
        .filter((attachment) => isImageAttachment(attachment.contentType, attachment.name))
        .slice(0, MAX_INBOUND_IMAGE_ATTACHMENTS);

    if (imageAttachments.length === 0) return [];

    await fs.mkdir(TEMP_IMAGE_DIR, { recursive: true });

    const downloaded: InboundImageAttachment[] = [];
    let index = 0;
    for (const attachment of imageAttachments) {
        try {
            const response = await fetch(attachment.url);
            if (!response.ok) {
                logger.warn(`[ImageBridge] Attachment image download failed (id=${attachment.id || 'unknown'}, status=${response.status})`);
                continue;
            }

            const bytes = Buffer.from(await response.arrayBuffer());
            if (bytes.length === 0) continue;

            const mimeType = attachment.contentType || 'image/png';
            const hasExt = IMAGE_EXT_PATTERN.test(attachment.name || '');
            const ext = mimeTypeToExtension(mimeType);
            const originalName = sanitizeFileName(attachment.name || `discord-image-${index + 1}.${ext}`);
            const name = hasExt ? originalName : `${originalName}.${ext}`;
            const localPath = path.join(
                TEMP_IMAGE_DIR,
                `${Date.now()}-${message.id}-${index}-${name}`,
            );

            await fs.writeFile(localPath, bytes);
            downloaded.push({
                localPath,
                url: attachment.url,
                name,
                mimeType,
            });
            index += 1;
        } catch (error: any) {
            logger.warn(`[ImageBridge] Attachment image processing failed (id=${attachment.id || 'unknown'})`, error?.message || error);
        }
    }

    return downloaded;
}

export async function cleanupInboundImageAttachments(attachments: InboundImageAttachment[]): Promise<void> {
    for (const image of attachments) {
        await fs.unlink(image.localPath).catch(() => { });
    }
}

export async function toDiscordAttachment(image: ExtractedResponseImage, index: number): Promise<AttachmentBuilder | null> {
    let buffer: Buffer | null = null;
    let mimeType = image.mimeType || 'image/png';

    if (image.base64Data) {
        try {
            buffer = Buffer.from(image.base64Data, 'base64');
        } catch {
            buffer = null;
        }
    } else if (image.url && /^https?:\/\//i.test(image.url)) {
        try {
            const response = await fetch(image.url);
            if (response.ok) {
                buffer = Buffer.from(await response.arrayBuffer());
                mimeType = response.headers.get('content-type') || mimeType;
            }
        } catch {
            buffer = null;
        }
    }

    if (!buffer || buffer.length === 0) return null;

    const fallbackExt = mimeTypeToExtension(mimeType);
    const baseName = sanitizeFileName(image.name || `generated-image-${index + 1}.${fallbackExt}`);
    const finalName = IMAGE_EXT_PATTERN.test(baseName) ? baseName : `${baseName}.${fallbackExt}`;
    return new AttachmentBuilder(buffer, { name: finalName });
}
