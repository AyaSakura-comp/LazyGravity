import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {
    extractLocalFileMarkers,
    isImageAttachment,
    mimeTypeToExtension,
    sanitizeFileName,
    toDiscordFileAttachments,
} from '../../src/utils/imageHandler';
import { logger } from '../../src/utils/logger';

describe('imageHandler', () => {
    describe('isImageAttachment', () => {
        it('returns true when contentType is image/*', () => {
            expect(isImageAttachment('image/png', 'any.bin')).toBe(true);
        });

        it('returns true when the file extension is an image format', () => {
            expect(isImageAttachment(null, 'photo.jpeg')).toBe(true);
        });

        it('returns false for non-image files', () => {
            expect(isImageAttachment('application/pdf', 'doc.pdf')).toBe(false);
        });
    });

    describe('mimeTypeToExtension', () => {
        it('converts common mimeTypes to file extensions', () => {
            expect(mimeTypeToExtension('image/png')).toBe('png');
            expect(mimeTypeToExtension('image/jpeg')).toBe('jpg');
            expect(mimeTypeToExtension('image/webp')).toBe('webp');
        });
    });

    describe('sanitizeFileName', () => {
        it('replaces invalid characters with hyphens', () => {
            expect(sanitizeFileName('bad name/with*chars?.png')).toBe('bad-name-with-chars-.png');
        });
    });

    describe('extractLocalFileMarkers', () => {
        it('extracts image/file/video local path markers and removes them from visible text', () => {
            const result = extractLocalFileMarkers([
                'Here is the render:',
                '[[image: /tmp/output image.png]]',
                'and the raw file [[file:/tmp/report.pdf]].',
                'remote stays [[image: https://example.com/image.png]]',
                'bad relative stays [[image: relative.png]]',
                'video too [[video: /tmp/demo.mp4]]',
            ].join('\n'));

            expect(result.markers).toEqual([
                { kind: 'image', path: '/tmp/output image.png' },
                { kind: 'file', path: '/tmp/report.pdf' },
                { kind: 'video', path: '/tmp/demo.mp4' },
            ]);
            expect(result.text).toBe([
                'Here is the render:',
                'and the raw file .',
                'remote stays [[image: https://example.com/image.png]]',
                'bad relative stays [[image: relative.png]]',
                'video too',
            ].join('\n'));
        });
    });

    describe('toDiscordFileAttachments', () => {
        it('turns existing marker paths into Discord attachments and skips missing files', async () => {
            const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lazy-gravity-marker-test-'));
            const pngPath = path.join(dir, 'render.png');
            await fs.writeFile(pngPath, Buffer.from([1, 2, 3]));

            const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
            try {
                const attachments = await toDiscordFileAttachments([
                    { kind: 'image', path: pngPath },
                    { kind: 'image', path: path.join(dir, 'missing.png') },
                ]);

                expect(attachments).toHaveLength(1);
                expect((attachments[0] as any).name).toBe('render.png');
                expect(warnSpy).toHaveBeenCalledTimes(1);
            } finally {
                warnSpy.mockRestore();
            }
        });
    });
});
