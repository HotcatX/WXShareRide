import { z } from 'zod';

/** Private source-document format only. Runtime market requests use file UUIDs;
 * a legacy locator never establishes permission to attach or delete a file. */
export const legacyCloudFileIdSchema = z.string().max(2048)
  .regex(/^cloud:\/\/[^\s/?#\\]+\/[^\s?#\\]+$/u)
  .refine(value => !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const legacyMarketImageSchema = z.strictObject({
  fileId: legacyCloudFileIdSchema,
  thumbFileId: legacyCloudFileIdSchema.optional(),
});
export const legacyMarketImagesSchema = z.array(legacyMarketImageSchema).max(6).superRefine((images, context) => {
  const originals = new Set<string>();
  const thumbnails = new Set<string>();
  images.forEach((image, index) => {
    if (originals.has(image.fileId)) context.addIssue({ code: 'custom', path: [index, 'fileId'], message: '原图不能重复' });
    originals.add(image.fileId);
    if (image.thumbFileId !== undefined) {
      if (thumbnails.has(image.thumbFileId)) context.addIssue({ code: 'custom', path: [index, 'thumbFileId'], message: '缩略图不能重复' });
      thumbnails.add(image.thumbFileId);
    }
  });
});
export type LegacyMarketImage = z.infer<typeof legacyMarketImageSchema>;
