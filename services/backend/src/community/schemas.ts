import { z } from 'zod';

const text = (limit: number) => z.string().max(limit).refine(value => value.trim() === value &&
  !/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(value));
const time = z.iso.datetime({ precision: 3 }).refine(value => Date.parse(value) > 0).nullable();
const file = z.uuid().transform(value => value.toLowerCase()).nullable();
const group = z.strictObject({ enabled: z.boolean(), title: text(80).min(1), expiresAt: time });
const announcement = z.strictObject({ enabled: z.boolean(), id: z.string().regex(/^[a-zA-Z0-9_-]{0,128}$/),
  title: text(80).min(1), body: text(2000), showGroupImage: z.boolean(), maxShows: z.number().int().min(1).max(100),
  intervalHours: z.number().min(0).max(8760), startAt: time, endAt: time });

/** Attachments live only in file_references; content has no storage locator. */
export const communityContentSchema = z.strictObject({ group, announcement });
export type CommunityContent = z.infer<typeof communityContentSchema>;
export const communityConfigSchema = z.strictObject({
  group: group.extend({ imageFileId: file }), announcement: announcement.extend({ imageFileId: file }),
}).superRefine((config, context) => {
  const { group: g, announcement: a } = config;
  if (a.startAt && a.endAt && a.startAt >= a.endAt) context.addIssue({ code: 'custom', path: ['announcement', 'endAt'], message: '结束时间必须晚于开始时间' });
  if (g.enabled && (!g.imageFileId || !g.expiresAt)) context.addIssue({ code: 'custom', path: ['group'], message: '启用社群需要图片和有效期' });
  if (a.enabled && (!a.id || !(a.body || a.imageFileId || a.showGroupImage && g.enabled) || a.showGroupImage && !g.enabled)) {
    context.addIssue({ code: 'custom', path: ['announcement'], message: '公告内容不完整' });
  }
});
export type CommunityConfig = z.infer<typeof communityConfigSchema>;
export const updateCommunitySchema = z.strictObject({ expectedVersion: z.number().int().min(0).max(2147483646), config: communityConfigSchema });

export function emptyCommunity(): CommunityContent {
  return { group: { enabled: false, title: '加入拼车群', expiresAt: null },
    announcement: { enabled: false, id: '', title: '最新消息', body: '', showGroupImage: false,
      maxShows: 1, intervalHours: 24, startAt: null, endAt: null } };
}
