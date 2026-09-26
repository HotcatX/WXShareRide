import { z } from 'zod';

// These are geographic codes already offered by the market region selector.
// County/area labels come from its editable directory, not a frozen second copy.
export const marketStateSchema = z.enum([
  'NY', 'NJ', 'NY_NJ', 'CA', 'MA', 'PA', 'CT', 'RI', 'NH', 'VT', 'ME',
  'MD', 'VA', 'DC', 'DE', 'NC', 'SC', 'GA', 'FL', 'IL', 'MI', 'OH', 'IN',
  'WI', 'MN', 'IA', 'MO', 'KS', 'NE', 'TX', 'WA', 'OR', 'AZ', 'CO', 'UT',
  'NV', 'NM', 'TN', 'KY', 'AL', 'LA', 'OK', 'AR', 'MS', 'ID', 'MT', 'WY',
  'ND', 'SD', 'AK', 'HI', 'WV',
]);

const line = (maximum: number) => z.string().trim().max(maximum)
  .refine(value => !/[\u0000-\u001f\u007f-\u009f]/u.test(value), '不能包含控制字符');
const paragraph = (maximum: number) => z.string().max(maximum)
  .refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value), '不能包含控制字符');
const money = z.number().int().min(0).max(10_000_000_000);

export const marketDateOnlySchema = z.iso.date().refine(value => !value.startsWith('0000-'), '年份必须大于零');
export const marketRegionSchema = z.strictObject({
  state: marketStateSchema,
  county: line(240).min(1),
  area: line(240).min(1),
});
export const marketLocationSchema = z.strictObject({
  displayName: line(300),
  address: line(300),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
}).superRefine((value, context) => {
  if ((value.latitude === null) !== (value.longitude === null)) {
    context.addIssue({ code: 'custom', path: ['longitude'], message: '经纬度必须同时提供或同时为空' });
  }
});

// Storage ownership/existence must be checked by the write service. A valid
// cloud:// shape alone never grants permission to attach somebody else's file.
export const marketFileIdSchema = z.string().max(2048)
  .regex(/^cloud:\/\/[^\s/?#\\]+\/[^\s?#\\]+$/u)
  .refine(value => !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
export const marketImageSchema = z.strictObject({
  fileId: marketFileIdSchema,
  thumbFileId: marketFileIdSchema.optional(),
});
export const marketImagesSchema = z.array(marketImageSchema).max(6).superRefine((images, context) => {
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

const avatar = z.union([
  z.literal(''), marketFileIdSchema,
  z.url().max(2048).refine(value => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !/[\s\u0000-\u001f\u007f-\u009f]/u.test(value);
  }),
]);
export const marketSellerContactSchema = z.strictObject({
  name: line(240),
  wechat: line(240),
  phone: line(240),
  avatar,
  note: paragraph(2000),
});
export const marketSubletSchema = z.strictObject({
  housingType: line(240),
  depositCents: money.nullable(),
  // Legacy false means "not indicated/not included" in the UI, not proof
  // that a home is unfurnished or that every utility is excluded.
  furnished: z.boolean(),
  utilitiesIncluded: z.boolean(),
  genderPreference: line(240),
  roommateCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
});

const contentFields = {
  title: line(240).min(1),
  description: paragraph(10000),
  priceCents: money,
  category: line(240).min(1),
  condition: line(240),
  region: marketRegionSchema,
  buildingName: line(240),
  location: marketLocationSchema.nullable(),
  startDate: marketDateOnlySchema,
  endDate: marketDateOnlySchema,
  images: marketImagesSchema,
  sellerContact: marketSellerContactSchema.nullable(),
};

/** Canonical stored content and complete create input. No owner or derived data. */
export const marketListingContentSchema = z.discriminatedUnion('listingType', [
  z.strictObject({ ...contentFields, listingType: z.literal('goods'), sublet: z.null() }),
  z.strictObject({ ...contentFields, listingType: z.literal('sublet'), sublet: marketSubletSchema,
    category: z.enum(['Studio', '1B1B', '2B1B', '2B2B', '3B2B', '其他']) }),
]).superRefine((value, context) => {
  if (value.endDate < value.startDate) {
    context.addIssue({ code: 'custom', path: ['endDate'], message: '结束日期不能早于开始日期' });
  }
});

/** Nested objects replace as a whole. Merge, then validate complete content. */
export const marketListingPatchSchema = z.strictObject({
  ...contentFields,
  listingType: z.enum(['goods', 'sublet']),
  sublet: marketSubletSchema.nullable(),
}).partial().refine(value => Object.keys(value).some(key => value[key as keyof typeof value] !== undefined), '修改不能为空');

// Status is a separate authorized operation; it cannot be smuggled into content.
export const marketListingStatusSchema = z.strictObject({ status: z.enum(['online', 'offline', 'sold']) });

export type MarketListingContent = z.infer<typeof marketListingContentSchema>;
export type MarketListingPatch = z.infer<typeof marketListingPatchSchema>;
export type MarketSellerContact = z.infer<typeof marketSellerContactSchema>;
export type MarketImage = z.infer<typeof marketImageSchema>;
