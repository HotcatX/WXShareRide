import type { PoolClient } from 'pg';
import type { z } from 'zod';
import { withIdempotencyInTransaction } from '../db.ts';
import { AppError } from '../errors.ts';
import { compatOperation, compatWrites, parseCompatAction, compatTemplateForm } from './contract.ts';
import { templateId } from '../templates/identity.ts';
import { createTemplateInTransaction, updateTemplateInTransaction, deleteTemplateInTransaction,
  templateRows, templateDto, getTemplate } from '../templates/service.ts';
import type { TemplateDefinition } from '../templates/schemas.ts';
import { parseListedPrice } from '../prices.ts';
import { listNotifications, unreadNotifications, markNotificationReadInTransaction,
  markAllNotificationsReadInTransaction, clearNotificationsInTransaction } from '../notifications/service.ts';
import { updateUserAddressInTransaction } from '../users/service.ts';

type Actor = { appId: string; openid: string; id: string };
type Form = z.infer<typeof compatTemplateForm>;
type Template = ReturnType<typeof templateDto>;
function legacyTemplate(row: Template, actor: Actor, sourceId = row.id, form?: Form) {
  const d = row.definition, weekdayIndex = (row.weekday + 6) % 7;
  requireLegacyTemplate(d);
  return { ...(form ?? {}), _id: sourceId, _openid: actor.openid, templateName: row.name,
    weekdayIndex, weekdayText: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'][weekdayIndex],
    departureTime: row.localTime, departureAddress: d.stops.find(stop => stop.kind === 'departure')!.address,
    destinationAddress: d.stops.find(stop => stop.kind === 'destination')!.address,
    passengerCount: d.seatCapacity, referencePrice: d.listedPriceLabel ?? (d.listedPriceCents === null ? '' : (d.listedPriceCents / 100).toFixed(2)),
    comment: d.note, createdAt: row.createdAt, updatedAt: row.updatedAt };
}
function requireLegacyTemplate(definition: TemplateDefinition) {
  if (definition.kind !== 'offer' || definition.cityKey !== 'ny_nj' || definition.stops.length !== 2 ||
      definition.stops[0]?.kind !== 'departure' || definition.stops[1]?.kind !== 'destination') {
    throw new AppError(409, 'TEMPLATE_REQUIRES_NEW_CLIENT', '请使用新版小程序编辑此模板');
  }
}
function templateInput(form: Form, previous?: TemplateDefinition) {
  if (previous) requireLegacyTemplate(previous);
  const price = parseListedPrice(form.referencePrice);
  const stops: TemplateDefinition['stops'] = previous ? structuredClone(previous.stops)
    : [{ kind: 'departure', address: form.departureAddress, offsetMinutes: 0 }, { kind: 'destination', address: form.destinationAddress }];
  for (const [kind, address] of [['departure', form.departureAddress], ['destination', form.destinationAddress]] as const) {
    const stop = stops.find(value => value.kind === kind)!;
    if (stop.address !== address) { stop.address = address; delete stop.placeId; }
  }
  return { name: form.templateName, weekday: (form.weekdayIndex + 1) % 7, localTime: form.departureTime, timeZone: 'America/New_York',
    definition: { kind: 'offer', cityKey: 'ny_nj', seatCapacity: form.passengerCount, listedPriceCents: price.cents,
      listedPriceLabel: price.label, note: form.comment, stops } };
}

/** Caller owns the nonce + identity + mutation transaction. Never creates a
 * user/session or opens CloudBase. Remove with the finite transitional bridge. */
export async function runCompatAction(client: PoolClient, appId: string, openid: string, action: string, input: unknown, key?: unknown) {
  const body = parseCompatAction(action, input);
  const user = (await client.query<{ id: string }>('SELECT id FROM users WHERE app_id=$1 AND openid=$2', [appId, openid])).rows[0];
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', '账号不存在，请先登录');
  const actor: Actor = { appId, openid, id: user.id };
  const write = async () => {
    if (action === 'templates.create' || action === 'templates.update') {
      const form = body.form as Form;
      const id = action === 'templates.update' ? templateId(appId, body.id as string) : undefined;
      const current = id ? await getTemplate(client, user.id, id, true) : undefined;
      const draft = templateInput(form, current?.definition);
      const result = id ? await updateTemplateInTransaction(client, user.id, id, draft) : await createTemplateInTransaction(client, user.id, draft);
      return { status: 200, data: legacyTemplate(result.data, actor, body.id as string | undefined, form) };
    }
    if (action === 'templates.delete') {
      await deleteTemplateInTransaction(client, user.id, templateId(appId, body.id as string));
      return { status: 200, data: { id: body.id, deleted: true } };
    }
    if (action === 'notifications.read') return markNotificationReadInTransaction(client, user.id, body.id);
    if (action === 'notifications.readAll') return markAllNotificationsReadInTransaction(client, user.id);
    if (action === 'notifications.clear') return clearNotificationsInTransaction(client, user.id);
    const field = body.field as 'pickupSpot' | 'dropoffSpot';
    const values = await updateUserAddressInTransaction(client, user.id,
      field === 'pickupSpot' ? 'pickupAddresses' : 'dropoffAddresses', body.value as string, action === 'profile.spots.add');
    return { status: 200, data: { field, values } };
  };
  if (compatWrites.has(action)) {
    const result = await withIdempotencyInTransaction(client, user.id, compatOperation(action), key, body, write);
    return { ok: true as const, actor, data: result.data };
  }
  if (key !== undefined) throw new AppError(400, 'INVALID_INPUT', '读取操作不接受请求编号');
  let data: Record<string, unknown>;
  if (action === 'identity') data = actor;
  else if (action === 'templates.list') {
    const page = body.page as number;
    data = { page, items: (await templateRows(client, user.id, page, 100, 'created')).slice(0, 100).map(row => legacyTemplate(templateDto(row), actor)) };
  } else if (action === 'templates.get') data = legacyTemplate(templateDto(await getTemplate(client, user.id, templateId(appId, body.id as string))), actor, body.id as string);
  else if (action === 'notifications.unread') data = await unreadNotifications(client, user.id);
  else {
    const result = await listNotifications(client, user.id, { limit: 100 });
    data = { unreadCount: result.unreadCount, nextCursor: null, items: result.items.map(row => ({ _id: row.id, _openid: actor.openid,
      type: row.type, title: row.title, content: row.content, read: row.read, createdAt: row.createdAt,
      ...(row.rideId ? { carpoolId: row.rideId, extra: { tripId: row.rideId } } : {}) })) };
  }
  return { ok: true as const, actor, data };
}
