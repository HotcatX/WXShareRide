import { z } from 'zod';

const exactString = z.string().refine(value => value.trim() === value && !/[\ud800-\udfff]/u.test(value));
const appId = exactString.min(1).refine(value => !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const fileId = z.uuid().transform(value => value.toLowerCase());
export const fileOwnerSchema = z.union([
  z.strictObject({ userId: fileId }),
  z.strictObject({ adminOwnerKey: exactString.regex(/^[a-zA-Z0-9_-]{1,128}$/) }),
]);
export const fileTargetSchema = z.strictObject({ appId, fileId });
export const reserveFileSchema = z.strictObject({
  appId,
  provider: z.enum(['cloudbase', 'cos']),
  // Preserve the provider's exact locator. Never normalize its path or URL.
  locator: z.string().min(1).refine(value => !/[\u0000\ud800-\udfff]/u.test(value) && Buffer.byteLength(value, 'utf8') <= 1024),
  owner: fileOwnerSchema,
});
export const fileMetadataSchema = z.strictObject({
  sizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  mediaType: exactString.max(255).regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/),
  sha256: exactString.regex(/^[a-f0-9]{64}$/),
});
export const confirmFileSchema = fileTargetSchema.extend({ owner: fileOwnerSchema, metadata: fileMetadataSchema });
export const fileResourceSchema = z.strictObject({
  appId,
  kind: z.enum(['listing', 'ad', 'community']),
  id: exactString.regex(/^[a-zA-Z0-9:_-]{1,160}$/),
});
export const fileReferencesSchema = z.array(z.strictObject({
  slot: exactString.regex(/^[a-z][a-z0-9_.-]{0,63}$/),
  fileId,
})).superRefine((references, context) => {
  const slots = new Set<string>();
  references.forEach((reference, index) => {
    if (slots.has(reference.slot)) context.addIssue({ code: 'custom', path: [index, 'slot'], message: '文件位置不能重复' });
    slots.add(reference.slot);
  });
});

export type FileOwner = z.infer<typeof fileOwnerSchema>;
export type FileTarget = z.infer<typeof fileTargetSchema>;
export type FileResource = z.infer<typeof fileResourceSchema>;
export type FileReference = z.infer<typeof fileReferencesSchema>[number];
export type FileMetadata = z.infer<typeof fileMetadataSchema>;
